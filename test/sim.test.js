import test from 'node:test';
import assert from 'node:assert/strict';
import { climate, createBody, heatFluxes, stepBody, dehydrationPct, causeOfDeath, DEFAULT_CLIMATE } from '../src/physics.js';
import { generateWorld, tileAt } from '../src/world.js';
import { newGame, perform, actions, envNow, here, scheduleStorms, ailments } from '../src/game.js';

const at = (h) => climate(h * 60, DEFAULT_CLIMATE);

test('气候：正午酷热、黎明凉爽、夜间无日照', () => {
  const noon = at(12);
  const dawn = at(5.5);
  assert.ok(noon.ghi > 900 && noon.ghi < 1150, `ghi ${noon.ghi}`);
  assert.ok(noon.groundT > 60 && noon.groundT < 75, `ground ${noon.groundT}`);
  assert.ok(at(15).airT > 40 && dawn.airT < 22);
  assert.equal(at(1).ghi, 0);
  assert.ok(noon.rh < 20 && dawn.rh > 30);
});

test('出汗率落在生理学合理范围', () => {
  const b = createBody();
  const sun = heatFluxes(b, at(12), { met: 1.2 });
  const shade = heatFluxes(b, at(12), { met: 1.2, shade: 0.8 });
  const walk = heatFluxes(b, at(12), { met: 4.5, speed: 0.8 });
  const night = heatFluxes(b, at(23), { met: 4.5, speed: 0.8 });
  assert.ok(sun.sweatLh > 0.35 && sun.sweatLh < 0.8, `sun ${sun.sweatLh}`);
  assert.ok(shade.sweatLh < sun.sweatLh * 0.7, `shade ${shade.sweatLh}`);
  assert.ok(walk.sweatLh > 0.55 && walk.sweatLh < 1.6, `walk ${walk.sweatLh}`);
  assert.ok(night.sweatLh < 0.5, `night ${night.sweatLh}`);
});

function restUntilDeath(ctx, maxH = 24 * 10) {
  const b = createBody();
  let t = 6 * 60;
  let lo = 99;
  let hi = 0;
  while (!causeOfDeath(b) && t < maxH * 60) {
    stepBody(b, heatFluxes(b, climate(t, DEFAULT_CLIMATE), ctx), 60);
    lo = Math.min(lo, b.coreT);
    hi = Math.max(hi, b.coreT);
    t++;
  }
  return { hours: (t - 360) / 60, cause: causeOfDeath(b), lo, hi, pct: dehydrationPct(b) };
}

test('不喝水：阴凉处能撑两到四天，暴晒下明显更短', () => {
  const shade = restUntilDeath({ met: 1.2, shade: 0.8 });
  const sun = restUntilDeath({ met: 1.2 });
  console.log('shade', shade, 'sun', sun);
  assert.ok(shade.hours > 40 && shade.hours < 110, `shade ${shade.hours}`);
  assert.ok(sun.hours < shade.hours * 0.85, `sun ${sun.hours}`);
  assert.ok(shade.lo > 34, `夜里不应冻死 ${shade.lo}`);
});

test('第一天内体温保持稳定', () => {
  const b = createBody();
  for (let t = 360; t < 360 + 12 * 60; t++) {
    stepBody(b, heatFluxes(b, climate(t, DEFAULT_CLIMATE), { met: 1.2, shade: 0.8 }), 60);
    assert.ok(b.coreT > 36.3 && b.coreT < 38.6, `t=${t} T=${b.coreT}`);
  }
});

test('世界生成是确定性的，绿洲在 10–14 km 外', () => {
  const a = generateWorld(42);
  const b = generateWorld(42);
  assert.deepEqual(a, b);
  for (const seed of [1, 2, 3, 99, 12345]) {
    const w = generateWorld(seed);
    const d = Math.hypot(w.oasis.x - w.start.x, w.oasis.y - w.start.y);
    assert.ok(d >= 9 && d <= 15, `seed ${seed} d=${d}`);
    assert.equal(tileAt(w, w.oasis.x, w.oasis.y).type, 'oasis');
    assert.ok(w.tiles.filter((t) => t.type === 'wadi').length > 15);
  }
});

test('游戏流程：直奔绿洲可以通关，原地暴晒会死', () => {
  const g = newGame({ seed: 7, difficulty: 'easy' });
  assert.ok(actions(g).length >= 5);
  // 策略：白天躲在遮阴沟里睡觉，夜里朝绿洲赶路
  let guard = 0;
  while (!g.over && guard++ < 400) {
    if (g.inv.water > 0 && dehydrationPct(g.body) > 3) perform(g, 'drink');
    if (envNow(g).isDay) {
      if (!here(g).shelter && here(g).shade < 0.5) perform(g, 'digShelter');
      else perform(g, g.body.fatigue > 30 ? 'sleep' : 'wait');
      continue;
    }
    if (g.levels.tired >= 2) {
      perform(g, 'sleep');
      continue;
    }
    const dx = Math.sign(g.world.oasis.x - g.pos.x);
    const dy = Math.sign(g.world.oasis.y - g.pos.y);
    perform(g, 'move', dx !== 0 ? { dx, dy: 0 } : { dx: 0, dy });
  }
  console.log('run', g.over, g.stats, dehydrationPct(g.body).toFixed(1), g.t / 60);
  assert.equal(g.over?.win, true);

  const d = newGame({ seed: 7, difficulty: 'hard' });
  guard = 0;
  while (!d.over && guard++ < 2000) perform(d, 'rest');
  assert.equal(d.over.win, false);
  assert.ok(JSON.stringify(d).length > 100); // 状态可序列化
});

test('沙暴：风大、直射光被挡、头两天必有一场', () => {
  const c = { ...DEFAULT_CLIMATE, storms: [{ start: 14 * 60, end: 17 * 60, peak: 16 }] };
  const calm = climate(15 * 60, DEFAULT_CLIMATE);
  const storm = climate(15 * 60, c);
  assert.equal(storm.storm, 1);
  assert.ok(storm.wind > 15 && calm.wind < 6);
  assert.ok(storm.dni < calm.dni * 0.15 && storm.ghi < calm.ghi * 0.4, `ghi ${storm.ghi}`);
  assert.ok(storm.airT < calm.airT);
  assert.equal(climate(13 * 60, c).storm, 0);
  for (let seed = 1; seed <= 50; seed++) {
    const st = scheduleStorms(seed);
    assert.ok(st.length > 0 && st[0].start < 2 * 1440, `seed ${seed}`);
    for (const x of st) assert.ok(x.end - x.start >= 120 && x.peak >= 12 && x.peak <= 20);
  }
});

test('沙暴里看不见、会走偏，过后别处的遮阴沟被填平', () => {
  const g = newGame({ seed: 3, difficulty: 'easy' });
  perform(g, 'digShelter');
  const dug = here(g);
  perform(g, 'move', { dx: 1, dy: 0 });
  const st = g.climate.storms[0];
  g.t = st.start + 30; // 直接跳到沙暴中
  assert.ok(envNow(g).storm > 0.5);
  const before = g.world.tiles.filter((t) => t.seen).length;
  let drift = 0;
  for (let i = 0; i < 12 && !g.over && envNow(g).storm > 0.5; i++) {
    const p = { ...g.pos };
    perform(g, 'move', { dx: 1, dy: 0 });
    if (g.pos.y !== p.y) drift++;
  }
  assert.ok(drift > 0, '沙暴中应当有走偏');
  assert.ok(g.world.tiles.filter((t) => t.seen).length - before <= 13, '沙暴中只能看见脚下');
  while (!g.over && g.t < st.end + 5) perform(g, 'rest');
  assert.equal(dug.shelter, false);
  assert.ok(g.log.some((l) => l.text.includes('沙暴过去了')));
});

test('夜间动物：蝎子、角蝰、耳廓狐、胡狼都会出现', () => {
  const seen = { 蝎子: 0, 角蝰: 0, 耳廓狐: 0, 胡狼: 0 };
  let stung = false;
  for (let seed = 1; seed <= 40; seed++) {
    const g = newGame({ seed, difficulty: 'easy' });
    let guard = 0;
    while (!g.over && guard++ < 300 && g.t < 3 * 1440) {
      if (g.inv.water > 0 && dehydrationPct(g.body) > 3) perform(g, 'drink');
      if (envNow(g).isDay) perform(g, 'wait');
      else if (guard % 3 === 0) perform(g, 'rest');
      else perform(g, 'move', { dx: guard % 2 ? 1 : -1, dy: 0 });
      if (ailments(g).length) stung = true;
    }
    for (const k of Object.keys(seen)) if (g.log.some((l) => l.text.includes(k))) seen[k]++;
  }
  console.log('animals', seen);
  for (const k of Object.keys(seen)) assert.ok(seen[k] > 0, k);
  assert.ok(stung);
});
