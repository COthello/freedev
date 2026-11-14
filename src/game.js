// 游戏规则层：把玩家的行动翻译成“以某种代谢强度度过若干分钟”，逐分钟交给物理内核积分。
// 状态是纯 JSON，可直接存档。
import {
  DEFAULT_CLIMATE,
  climate,
  createBody,
  heatFluxes,
  stepBody,
  dehydrationPct,
  drink,
  eat,
  causeOfDeath,
  hash01,
} from './physics.js';
import { generateWorld, tileAt, reveal, bearing, TERRAIN } from './world.js';

export const DIFFICULTY = {
  easy: { label: '宽松', water: 3 },
  normal: { label: '标准', water: 2 },
  hard: { label: '严酷', water: 1 },
};

export const BOTTLE_L = 3;
const START_MIN = 5 * 60; // 第 1 天 05:00，日出前
const DIG_RATE = 0.35; // m/h
const SEEP_RATE = 0.6; // L/h
const WELL_MAX = 2.5;

/** 沙暴日程：多在午后到傍晚起风，持续 2–5 小时。头两天里保证至少有一场 */
export function scheduleStorms(seed, days = 10) {
  const storms = [];
  const make = (d) => {
    const start = d * 1440 + Math.round((13 + 6 * hash01(seed + 211, d)) * 60);
    const dur = Math.round(120 + 180 * hash01(seed + 223, d));
    storms.push({ start, end: start + dur, peak: 12 + 8 * hash01(seed + 227, d) });
  };
  for (let d = 0; d < days; d++) {
    if (hash01(seed + 101, d) < 0.45 || (d === 1 && storms.length === 0)) make(d);
  }
  return storms;
}

export function newGame(cfg = {}) {
  const seed = (cfg.seed ?? Math.floor(Math.random() * 1e9)) >>> 0;
  const diff = DIFFICULTY[cfg.difficulty] ? cfg.difficulty : 'normal';
  const world = generateWorld(seed);
  const state = {
    version: 2,
    name: cfg.name || '无名者',
    difficulty: diff,
    seed,
    t: START_MIN,
    t0: START_MIN,
    climate: { ...DEFAULT_CLIMATE, seed, storms: scheduleStorms(seed) },
    body: createBody(cfg),
    world,
    pos: { ...world.start },
    inv: { water: DIFFICULTY[diff].water, sheet: true },
    levels: { dehyd: 0, heat: 0, cold: 0, tired: 0 },
    stats: { km: 0, drunk: 0 },
    effects: { sting: 0, pain: 0, bite: 0 }, // 各自的结束时刻
    sight: null, // 刚看见的动物，供画面使用
    drifted: false,
    posture: 'stand',
    log: [],
    over: null,
    flux: null,
  };
  say(state, `${state.name}在一片陌生的沙漠中睁开眼睛。东方刚刚泛白，沙子还是凉的。`, 'story');
  say(
    state,
    `身上只有一件长袍、一只 3 L 的水囊（里面有 ${state.inv.water.toFixed(1)} L 水）和一张塑料布。必须找到稳定的水源。`,
    'story',
  );
  look(state);
  refreshFlux(state);
  return state;
}

function say(state, text, kind = 'info') {
  state.log.push({ t: state.t, text, kind });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

export function here(state) {
  return tileAt(state.world, state.pos.x, state.pos.y);
}

export function envNow(state) {
  return climate(state.t, state.climate);
}

function look(state) {
  const tile = here(state);
  const env = envNow(state);
  const r = env.storm > 0.5 ? 0 : env.isDay ? TERRAIN[tile.type].view : 1;
  reveal(state.world, state.pos.x, state.pos.y, r);
}

function restCtx(state, met, lying) {
  const tile = here(state);
  return { met, shade: tile.shade, shelter: tile.shelter, lying };
}

/** 刷新界面上显示的“此刻静息热流” */
export function refreshFlux(state) {
  state.flux = heatFluxes(state.body, envNow(state), restCtx(state, 1.2, false));
}

function wellWater(tile, t) {
  if (!tile.well) return 0;
  return Math.min(WELL_MAX, tile.well.l + ((t - tile.well.since) / 60) * SEEP_RATE);
}

function computeLevels(body) {
  const p = dehydrationPct(body);
  const T = body.coreT;
  return {
    dehyd: p >= 11 ? 4 : p >= 8 ? 3 : p >= 5 ? 2 : p >= 2 ? 1 : 0,
    heat: T >= 40.5 ? 3 : T >= 39.2 ? 2 : T >= 38.3 ? 1 : 0,
    cold: T <= 33 ? 3 : T <= 35 ? 2 : T <= 36 ? 1 : 0,
    tired: body.fatigue >= 100 ? 2 : body.fatigue >= 75 ? 1 : 0,
  };
}

function metMul(state) {
  return (state.effects.sting > state.t ? 1.2 : 1) * (state.effects.bite > state.t ? 1.15 : 1);
}

/** 当前位置是否背风（沙暴里能躲的地方） */
function inLee(tile) {
  return tile.shelter || tile.shade > 0.5;
}

function stormAftermath(state) {
  const cur = here(state);
  let lost = false;
  for (const t of state.world.tiles) {
    if (t === cur) continue;
    if (t.shelter) {
      t.shelter = false;
      lost = true;
    }
    if (t.well) {
      t.well = null;
      t.dug = Math.max(0, t.dug - 0.6);
      lost = true;
    }
  }
  if (cur.still) cur.still.l = 0;
  say(state, `沙暴过去了，空气里还悬着细尘。${lost ? '别处挖的沟和水坑都被流沙填平了。' : ''}${cur.still ? '蒸馏器里灌进了沙子，凝的水全废了。' : ''}`, 'env');
  if (state.drifted) {
    say(state, '风停后你才看清四周：刚才在沙暴里走偏了方向。', 'warn');
    state.drifted = false;
  }
  look(state);
}

const SCORPION_RISK = { rock: 0.04, wadi: 0.03, flat: 0.015, dune: 0.005, oasis: 0.02 }; // 每小时

function sting(state, text) {
  state.effects.sting = state.t + 360;
  state.effects.pain = state.t + 120;
  state.body.fatigue = Math.min(100, state.body.fatigue + 8);
  state.sight = { kind: 'scorpion', until: state.t + 30 };
  say(state, text, 'danger');
}

const WARN = {
  dehyd: [
    null,
    '嘴唇发干，开始口渴。（脱水 2%）',
    '头痛，尿色深黄，走路变慢了。（脱水 5%）',
    '头晕目眩，舌头肿胀，几乎没有汗了。（脱水 8%）',
    '视线模糊，双腿不听使唤，已经无法行走。（脱水 11%）',
  ],
  heat: [null, '浑身燥热，心跳加快。', '恶心、抽筋——这是热衰竭，必须马上降温。', '皮肤滚烫，意识模糊：中暑虚脱，无法行走。'],
  cold: [null, '冷得发抖。', '抖得停不下来，手指僵硬：轻度失温。', '不再发抖，意识迟钝：重度失温。'],
  tired: [null, '眼皮沉重，脚步虚浮。', '体力彻底耗尽，瘫倒在地。'],
};

/**
 * 推进时间。act: { met, kind: 'walk'|'work'|'rest'|'sleep', speed, long }
 * 返回 { elapsed, interrupted }
 */
function advance(state, minutes, act) {
  const body = state.body;
  const sleeping = act.kind === 'sleep';
  const stationary = act.kind === 'rest' || sleeping;
  const tile = here(state);
  state.posture = sleeping ? 'sleep' : stationary ? 'sit' : act.kind === 'walk' ? 'walk' : 'work';
  let elapsed = 0;
  let interrupted = false;
  for (let i = 0; i < minutes; i++) {
    const env = climate(state.t, state.climate);
    const ctx = stationary
      ? restCtx(state, act.met * metMul(state), sleeping)
      : { met: act.met * metMul(state), shade: act.kind === 'work' ? tile.shade * 0.5 : 0, speed: act.speed ?? 0 };
    const flux = heatFluxes(body, env, ctx);
    stepBody(body, flux, 60, { sleeping });
    state.flux = flux;
    if (tile.still) tile.still.l = Math.min(1.2, tile.still.l + (0.06 * (env.ghi / 1000) + 0.004) / 60);
    state.t++;
    elapsed++;

    // 黎明与黄昏，沙鸡飞向水源
    const tod = state.t % 1440;
    if ((tod === 330 || tod === 1110) && !sleeping) {
      const d = Math.hypot(state.world.oasis.x - state.pos.x, state.world.oasis.y - state.pos.y);
      if (d <= 25 && d > 0) {
        say(state, `${tod === 330 ? '天刚亮' : '日落时分'}，一群沙鸡低低掠过，朝${bearing(state.pos, state.world.oasis)}方飞去——它们每天都要去喝水。`, 'hint');
      }
    }
    let eventStop = false;

    // —— 沙暴 ——
    for (const st of state.climate.storms) {
      if (state.t === st.start - 45 && !sleeping) {
        say(state, '地平线上立起一道黄褐色的墙，正朝这边压过来。沙暴大约四十分钟后到——该找个背风的地方了。', 'danger');
        if (act.long) eventStop = true;
      }
      if (state.t === st.start) {
        say(state, sleeping ? '你被抽在脸上的沙粒打醒：沙暴到了。' : '沙暴到了。天一下子暗成土黄色，三步之外什么也看不见。', 'danger');
        if (sleeping) eventStop = true;
      }
      if (state.t === st.end) stormAftermath(state);
    }
    if (env.storm > 0.5 && !(stationary && inLee(tile))) {
      body.fatigue = Math.min(100, body.fatigue + 3 / 60); // 顶着风沙，格外耗人
    }

    // —— 夜间动物（沙暴时都躲起来了）——
    if (!env.isDay && env.storm === 0) {
      const d = Math.hypot(state.world.oasis.x - state.pos.x, state.world.oasis.y - state.pos.y);
      if (tod === 1380 && !sleeping && d > 0 && d <= 9) {
        say(state, `夜深了，${bearing(state.pos, state.world.oasis)}方传来胡狼此起彼伏的嚎叫。胡狼离不开水，不会住得离水源太远。`, 'hint');
      }
      if ((tod === 1260 || tod === 120) && !sleeping && hash01(state.seed + 41, state.t) < 0.5) {
        state.sight = { kind: 'fennec', until: state.t + 40 };
        if ((tile.type === 'flat' || tile.type === 'dune') && hash01(state.seed + 43, state.t) < 0.4) {
          tile.plants += 1;
          say(state, '一只耳廓狐在不远处刨沙，叼走了什么。你过去看，沙下露出一截肥厚多汁的根茎——它能听见沙子下面的东西。', 'hint');
        } else {
          say(state, '月光下，一只耳廓狐竖着大耳朵看了你一会儿，悄无声息地跑开了。', 'env');
        }
      }
      if (stationary && state.effects.sting <= state.t && hash01(state.seed + 47, state.t) < SCORPION_RISK[tile.type] / 60) {
        sting(state, sleeping ? '小腿上一阵火烧似的剧痛把你惊醒——一只蝎子钻进了长袍。伤处又肿又麻，心跳得厉害。' : '手边的沙子里蹿出一只蝎子，在你手背上蜇了一下。伤处又肿又麻，心跳得厉害。');
        eventStop = true;
      }
    }

    if (tod === 320) say(state, '太阳升起来了。气温很快会爬升。', 'env');
    if (tod === 1120) say(state, '太阳落山了。沙漠开始迅速变凉。', 'env');

    const cause = causeOfDeath(body);
    if (cause) {
      state.over = { win: false, cause };
      say(state, cause, 'death');
      return { elapsed, interrupted: true };
    }

    const lv = computeLevels(body);
    let stop = false;
    for (const k of Object.keys(lv)) {
      if (lv[k] > state.levels[k]) {
        say(state, WARN[k][lv[k]], lv[k] >= 2 ? 'danger' : 'warn');
        if (lv[k] >= 2) stop = true;
      }
    }
    state.levels = lv;
    if (eventStop || (stop && (act.long || lv.heat >= 3 || lv.dehyd >= 4 || lv.tired >= 2 || lv.cold >= 3))) {
      interrupted = true;
      break;
    }
    if (sleeping && body.fatigue <= 2) break;
  }
  if (!stationary) state.posture = 'stand';
  return { elapsed, interrupted };
}

function fmtDur(min) {
  return min >= 60 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分钟`;
}

function canWalk(state) {
  const lv = state.levels;
  if (lv.heat >= 3) return '中暑虚脱，无法行走';
  if (lv.dehyd >= 4) return '严重脱水，无法行走';
  if (lv.cold >= 3) return '重度失温，无法行走';
  if (lv.tired >= 2) return '体力耗尽，必须先睡觉';
  return null;
}

function speedFactor(state) {
  const lv = state.levels;
  let f = 1;
  if (lv.dehyd === 2) f *= 0.85;
  if (lv.dehyd === 3) f *= 0.6;
  if (lv.tired >= 1) f *= 0.8;
  if (lv.heat >= 2) f *= 0.7;
  const env = envNow(state);
  if (!env.isDay) f *= 0.85; // 摸黑走得慢
  if (env.storm > 0.5) f *= 0.5; // 顶着风沙
  if (state.effects.bite > state.t) f *= 0.5; // 腿被蛇咬伤
  return f;
}

export function moveCost(state, dx, dy) {
  const dest = tileAt(state.world, state.pos.x + dx, state.pos.y + dy);
  if (!dest) return null;
  const tr = TERRAIN[dest.type];
  return { dest, minutes: Math.round(tr.minutes / speedFactor(state)), met: tr.met };
}

/** 收集并装水：先喝到补足亏缺（单次最多 1.5 L），再灌满水壶。返回剩余水量 */
function takeWater(state, avail) {
  const body = state.body;
  const want = Math.min(1.5, Math.max(0, body.waterDeficit + 0.3));
  const d = Math.min(avail, want);
  drink(body, d);
  state.stats.drunk += d;
  avail -= d;
  const fill = Math.min(avail, BOTTLE_L - state.inv.water);
  state.inv.water += fill;
  avail -= fill;
  return { drank: d, filled: fill, left: avail };
}

function packStill(state, tile) {
  const r = takeWater(state, tile.still.l);
  tile.still = null;
  state.inv.sheet = true;
  say(state, `收起蒸馏器，得到 ${(r.drank + r.filled).toFixed(2)} L 蒸馏水。`, 'good');
}

/** 当前可用的行动列表 */
/** 当前的伤情，供界面显示 */
export function ailments(state) {
  const out = [];
  const left = (t) => `还有 ${Math.ceil((t - state.t) / 60)} 小时`;
  if (state.effects.pain > state.t) out.push(`蝎蜇：剧痛，无法入睡（${left(state.effects.pain)}）`);
  if (state.effects.sting > state.t) out.push(`蝎毒：心跳加速，代谢 +20%（${left(state.effects.sting)}）`);
  if (state.effects.bite > state.t) out.push(`蛇咬：小腿肿胀，步速减半（${left(state.effects.bite)}）`);
  return out;
}

export function actions(state) {
  if (state.over) return [];
  const tile = here(state);
  const env = envNow(state);
  const list = [];
  const add = (id, label, desc, ok = true, why = '') => list.push({ id, label, desc, enabled: ok, why });

  add('drink', '喝水 0.25 L', `水囊 ${state.inv.water.toFixed(2)} / ${BOTTLE_L} L`, state.inv.water > 0.001, '水囊空了');
  add('rest', '休息 30 分钟', tile.shelter ? '在遮阴沟里' : tile.shade > 0 ? '在阴凉处' : '无遮蔽');
  add('wait', env.isDay ? '休息到日落' : '休息到日出', '身体出状况时会中断');
  const pain = state.effects.pain > state.t;
  add('sleep', '睡觉（至多 6 小时）', `疲劳 ${Math.round(state.body.fatigue)}`, state.body.fatigue >= 15 && !pain, pain ? '蜇伤疼得睡不着' : '还不困');
  add('search', '搜索此地', '30 分钟', !tile.searched, '已经搜过');

  const pool = tile.poolFound ? tile.pool : 0;
  const well = wellWater(tile, state.t);
  if (tile.type === 'oasis') add('take', '饮水并灌满水囊', '泉水');
  else if (pool > 0.01) add('take', '取岩窝积水', `约 ${pool.toFixed(1)} L`);
  else if (tile.well) add('take', '从渗水坑取水', `已渗出 ${well.toFixed(1)} L`, well > 0.05, '还没渗出水');

  if (tile.type === 'wadi' && !tile.well && !tile.dry) {
    add('digWater', '向下挖水', `1 小时 · 已挖 ${tile.dug.toFixed(1)} m`);
  }
  if (tile.plants > 0) add('forage', '割取多肉植物', `剩 ${tile.plants} 株 · 20 分钟`);
  if (!tile.shelter && tile.type !== 'oasis') add('digShelter', '挖遮阴沟', '90 分钟重体力');
  if (tile.still) add('packStill', '收起蒸馏器', `已凝结 ${tile.still.l.toFixed(2)} L`);
  else if (state.inv.sheet) add('still', '布置太阳能蒸馏器', '1 小时 · 只在白天产水');
  return list;
}

export function perform(state, id, arg) {
  if (state.over) return;
  const tile = here(state);
  const body = state.body;

  switch (id) {
    case 'move': {
      const why = canWalk(state);
      if (why) return say(state, why + '。', 'warn');
      let c = moveCost(state, arg.dx, arg.dy);
      if (!c) return say(state, '那边是地图之外的无尽沙海。', 'warn');
      const env0 = envNow(state);
      if (env0.storm > 0.5 && hash01(state.seed + 13, state.t) < 0.5) {
        // 沙暴里没有参照物，人会不知不觉走偏
        const sgn = hash01(state.seed + 17, state.t) < 0.5 ? 1 : -1;
        const alt = arg.dx !== 0 ? moveCost(state, 0, sgn) : moveCost(state, sgn, 0);
        if (alt) {
          c = alt;
          state.drifted = true;
        }
      }
      if (tile.still) packStill(state, tile);
      const speed = 1000 / (c.minutes * 60);
      const half = Math.floor(c.minutes / 2);
      const r1 = advance(state, half, { met: c.met, kind: 'walk', speed });
      if (state.over) return;
      if (r1.interrupted) return say(state, '你走不动了，退回原地。', 'warn');
      state.pos = { x: c.dest.x, y: c.dest.y };
      state.stats.km += 1;
      advance(state, c.minutes - half, { met: c.met, kind: 'walk', speed });
      if (state.over) return;
      look(state);
      if (env0.storm > 0.5) say(state, `在风沙里摸索了 ${c.minutes} 分钟，不知道走到了哪里。`);
      else if (c.dest.type !== tile.type) say(state, `走了 ${c.minutes} 分钟，来到${TERRAIN[c.dest.type].name}。`);
      // 夜里沙面上有伏击的角蝰
      if (!env0.isDay && env0.storm === 0 && c.dest.type !== 'oasis' && state.effects.bite <= state.t) {
        const risk = c.dest.type === 'wadi' || c.dest.type === 'rock' ? 0.03 : 0.02;
        if (hash01(state.seed + 29, state.t) < risk) {
          state.sight = { kind: 'viper', until: state.t + 30 };
          if (hash01(state.seed + 31, state.t) < 0.35) {
            state.effects.bite = state.t + 1440;
            state.body.waterDeficit += 0.3; // 肿胀处渗出的体液
            state.body.fatigue = Math.min(100, state.body.fatigue + 15);
            say(state, '脚踝上像被钉了一下。半埋在沙里的角蝰松开嘴，侧身滑走了。小腿很快肿了起来，每走一步都钻心地疼——接下来一天只能拖着腿走。', 'danger');
          } else {
            say(state, '脚边传来一阵干涩的沙沙声——角蝰在摩擦鳞片示警。你僵在原地，等它侧身滑进黑暗，才绕了一大圈过去。', 'warn');
            advance(state, 10, { met: 1.5, kind: 'rest' });
            if (state.over) return;
          }
        }
      }
      if (c.dest.type === 'oasis') {
        state.over = { win: true };
        say(state, '棕榈树下有一汪泉水。你跪下去，把脸埋进水里。第一幕结束——你活下来了。', 'good');
      }
      break;
    }
    case 'drink': {
      const d = Math.min(0.25, state.inv.water);
      state.inv.water -= d;
      drink(body, d);
      state.stats.drunk += d;
      advance(state, 2, { met: 1.2, kind: 'rest' });
      say(state, `喝了 ${d.toFixed(2)} L 水。`);
      break;
    }
    case 'rest':
      advance(state, 30, { met: 1.2, kind: 'rest' });
      break;
    case 'wait': {
      const tod = state.t % 1440;
      const target = envNow(state).isDay ? 1120 : 320;
      const mins = ((target - tod + 1440) % 1440) || 1440;
      const r = advance(state, mins, { met: 1.2, kind: 'rest', long: true });
      if (!state.over) say(state, r.interrupted ? `休息了 ${fmtDur(r.elapsed)}，身体的状况让你无法再等下去。` : `休息了 ${fmtDur(r.elapsed)}。`);
      break;
    }
    case 'sleep': {
      const r = advance(state, 360, { met: 0.95, kind: 'sleep', long: true });
      if (!state.over) say(state, r.interrupted ? `睡了 ${fmtDur(r.elapsed)}，被身体的不适惊醒。` : `睡了 ${fmtDur(r.elapsed)}。`);
      break;
    }
    case 'search': {
      advance(state, 30, { met: 2.5, kind: 'work' });
      if (state.over) return;
      tile.searched = true;
      if (tile.type === 'rock' && state.effects.sting <= state.t && hash01(state.seed + 53, state.t) < 0.06) {
        sting(state, '你把手伸进石缝，指尖一阵剧痛——石头下面躲着一只蝎子。伤处又肿又麻，心跳得厉害。');
      }
      if (tile.pool > 0) {
        tile.poolFound = true;
        say(state, `岩缝深处有一个背阴的石窝，里面积着约 ${tile.pool.toFixed(1)} L 雨水。`, 'good');
      } else if (tile.type === 'wadi') {
        if (tile.waterDepth == null) say(state, '河床的沙子又干又松，往下掏了一臂深也没有潮气。');
        else if (tile.waterDepth < 1.1) say(state, '弯道外侧的沙子颜色发暗，掏开一层就有潮气——地下水很浅。', 'hint');
        else say(state, '深处的沙子略带潮气，往下挖一两米或许有水。', 'hint');
      } else if (tile.type === 'rock') {
        say(state, '岩石间只有风化的碎屑。不过岩壁下有一片可靠的阴影。');
      } else {
        say(state, '除了沙砾，什么也没有。');
      }
      break;
    }
    case 'take': {
      advance(state, 10, { met: 1.5, kind: 'rest' });
      let r;
      if (tile.type === 'oasis') r = takeWater(state, 99);
      else if (tile.poolFound && tile.pool > 0.01) {
        r = takeWater(state, tile.pool);
        tile.pool = r.left;
      } else {
        r = takeWater(state, wellWater(tile, state.t));
        tile.well = { l: r.left, since: state.t };
      }
      say(state, `喝下 ${r.drank.toFixed(2)} L，往水囊里灌了 ${r.filled.toFixed(2)} L。`, 'good');
      break;
    }
    case 'digWater': {
      const r = advance(state, 60, { met: 6, kind: 'work' });
      if (state.over) return;
      tile.dug += (DIG_RATE * r.elapsed) / 60;
      if (tile.waterDepth != null && tile.dug >= tile.waterDepth) {
        tile.well = { l: 0.1, since: state.t };
        say(state, `挖到 ${tile.dug.toFixed(1)} m，坑底的沙子变成了泥浆，浑水慢慢渗了出来。`, 'good');
      } else if (tile.dug >= 2.4) {
        tile.dry = true;
        say(state, '挖到两米半仍是干沙。这里没有水，白流了一身汗。', 'warn');
      } else {
        say(state, `挖了 ${fmtDur(r.elapsed)}，坑深 ${tile.dug.toFixed(1)} m。${tile.dug > 0.6 ? '沙子摸起来凉了一些。' : ''}`);
      }
      break;
    }
    case 'forage': {
      advance(state, 20, { met: 3, kind: 'work' });
      if (state.over) return;
      tile.plants--;
      drink(body, 0.25);
      eat(body, 120);
      state.stats.drunk += 0.25;
      say(state, '削去硬皮，嚼下苦涩多汁的茎肉。（约 0.25 L 水，120 kcal）', 'good');
      break;
    }
    case 'digShelter': {
      const r = advance(state, 90, { met: 6, kind: 'work' });
      if (state.over) return;
      if (r.interrupted) return say(state, '还没挖完，身体先撑不住了。', 'warn');
      tile.shelter = true;
      say(state, '挖出一条半米深的沟，把长袍下摆撑在上面。沟底的沙子比地面凉二三十度，夜里又比地面暖。', 'good');
      break;
    }
    case 'still': {
      const r = advance(state, 60, { met: 5, kind: 'work' });
      if (state.over) return;
      if (r.interrupted) return say(state, '还没布置好，身体先撑不住了。', 'warn');
      tile.still = { l: 0 };
      state.inv.sheet = false;
      say(state, '挖了个浅坑，蒙上塑料布，中间压一块石头。阳光会把沙里的湿气蒸出来，凝在布的内侧。');
      break;
    }
    case 'packStill':
      packStill(state, tile);
      break;
    default:
      return;
  }
  if (!state.over) refreshFlux(state);
}

export function clock(state) {
  if (state.sight && state.sight.until <= state.t) state.sight = null;
  const day = Math.floor(state.t / 1440) + 1;
  const m = state.t % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return { day, text: `${hh}:${mm}`, survivedH: (state.t - state.t0) / 60 };
}
