import test from 'node:test';
import assert from 'node:assert/strict';
import { climate, createBody, heatFluxes, stepBody, dehydrationPct, causeOfDeath, DEFAULT_CLIMATE } from '../src/physics.js';
import { generateWorld, tileAt } from '../src/world.js';
import { newGame, perform, actions, envNow, here } from '../src/game.js';

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
