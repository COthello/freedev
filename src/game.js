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
import { BOTTLE_L, say, computeLevels, metMul, WARN, fmtDur } from './common.js';
import { initAct2, actions2, perform2, env2 } from './act2.js';

export { BOTTLE_L };

export const DIFFICULTY = {
  easy: { label: '宽松', water: 4, hazard: 0.4 },
  normal: { label: '标准', water: 3, hazard: 0.7 },
  hard: { label: '严酷', water: 1.5, hazard: 1 },
};

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
    version: 5,
    name: cfg.name || '无名者',
    difficulty: diff,
    seed,
    t: START_MIN,
    t0: START_MIN,
    climate: { ...DEFAULT_CLIMATE, seed, storms: scheduleStorms(seed).filter((st) => diff === 'hard' || st.start >= 1440) }, // 宽松和标准：第一天不起沙暴
    hazard: DIFFICULTY[diff].hazard, // 动物和走偏的概率系数
    clue: null, // 已知的水源方位线索
    body: createBody(cfg),
    world,
    pos: { ...world.start },
    inv: { water: DIFFICULTY[diff].water, sheet: true },
    levels: { dehyd: 0, heat: 0, cold: 0, tired: 0, hungry: 0 },
    act: 1,
    stats: { km: 0, drunk: 0 },
    effects: { sting: 0, pain: 0, bite: 0 }, // 各自的结束时刻
    sight: null, // 刚看见的动物，供画面使用
    drifted: false,
    posture: 'stand',
    log: [],
    over: null,
    flux: null,
  };
  say(state, `公元 2226 年。${state.name}在沙漠中睁开眼睛。东方刚刚泛白，沙子还是凉的。两百年前这里据说是有河的。`, 'story');
  say(
    state,
    `身上只有一件长袍、一只 ${BOTTLE_L} L 的水囊（里面有 ${state.inv.water.toFixed(1)} L 水）和一张旧时代留下来的塑料布。地表已经养不活人了——老人们说，活路在地下。但得先找到水。`,
    'story',
  );
  look(state);
  refreshFlux(state);
  return state;
}

export function here(state) {
  return tileAt(state.world, state.pos.x, state.pos.y);
}

export function envNow(state) {
  if (state.act === 2) return env2(state);
  return climate(state.t, state.climate);
}

function look(state) {
  const tile = here(state);
  const env = envNow(state);
  const r = env.storm > 0.5 ? 0 : env.isDay ? TERRAIN[tile.type].view : 1;
  reveal(state.world, state.pos.x, state.pos.y, r);
  if (!env.isDay || env.storm > 0.5) return;
  // 白天，沙漠里的一点绿色和井圈的影子隔很远就能看见
  const far = tile.type === 'dune' ? 7 : 5;
  const o = state.world.oasis;
  const ot = tileAt(state.world, o.x, o.y);
  const d = Math.hypot(o.x - state.pos.x, o.y - state.pos.y);
  if (!ot.seen && d <= far) {
    ot.seen = true;
    const dir = bearing(state.pos, o);
    say(state, `${dir}方的地平线上有一小片绿色，在热浪里一晃一晃。树——有树就有水。约 ${Math.round(d)} km。`, 'hint');
    state.clue = { dir, what: '看见绿洲在', t: state.t };
  }
  for (const t of state.world.tiles) {
    if (t.shaft && !t.seen && Math.hypot(t.x - state.pos.x, t.y - state.pos.y) <= far - 2) t.seen = true;
  }
  // 走近了能看出入口那片岩壁不对劲
  const g = state.world.gate;
  const gt = tileAt(state.world, g.x, g.y);
  const dg = Math.hypot(g.x - state.pos.x, g.y - state.pos.y);
  if (!gt.gateSpotted && dg > 0 && dg <= r + 1) {
    gt.gateSpotted = true;
    gt.seen = true;
    say(state, `${bearing(state.pos, g)}方约 ${Math.round(dg)} km 处有一片岩壁，根部有一道笔直的暗影——不像天然的东西。`, 'hint');
  }
}

function restCtx(state, met, lying) {
  const tile = here(state);
  return { met, shade: tile.shade, shelter: tile.shelter, draft: tile.shaft, lying };
}

/** 刷新界面上显示的“此刻静息热流” */
export function refreshFlux(state) {
  if (state.act === 2) {
    state.flux = heatFluxes(state.body, env2(state), { met: 1.2, shelter: true, indoor: true });
    return;
  }
  state.flux = heatFluxes(state.body, envNow(state), restCtx(state, 1.2, false));
}

function wellWater(tile, t) {
  if (!tile.well) return 0;
  return Math.min(WELL_MAX, tile.well.l + ((t - tile.well.since) / 60) * SEEP_RATE);
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

// 旧时代的遗物。两百年前这里还不是沙漠
const RELICS = [
  '沙下露出一段发白的沥青，中间还有褪成灰色的虚线。一条路，通向哪里已经没人知道。',
  '半埋的铁架歪在沙里，上面挂着碎成蛛网的深蓝色玻璃板——旧时代的人用它们从太阳里取电。现在太阳只剩下杀人这一种用处。',
  '一块锈蚀的路牌，字迹只剩下一个箭头和“…水库 12 km”。箭头指着的方向，如今只有沙。',
  '沙里翻出一只塑料瓶，两百年了还没烂。瓶身上印着一条河，蓝得不像真的。',
  '一截倒伏的水泥杆，断口里露出铜线。有人把能拆的都拆走了，很久以前。',
  '风蚀出半堵砖墙，墙根有一排贝壳——不是海贝，是河蚌。这里曾经有过岸。',
];

const SCORPION_RISK = { rock: 0.04, wadi: 0.03, flat: 0.015, dune: 0.005, oasis: 0.02 }; // 每小时

function sting(state, text) {
  state.effects.sting = state.t + 360;
  state.effects.pain = state.t + 120;
  state.body.fatigue = Math.min(100, state.body.fatigue + 8);
  state.sight = { kind: 'scorpion', until: state.t + 30 };
  say(state, text, 'danger');
}

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
        const dir = bearing(state.pos, state.world.oasis);
        say(state, `${tod === 330 ? '天刚亮' : '日落时分'}，一群沙鸡低低掠过，朝${dir}方飞去——它们每天都要去喝水。`, 'hint');
        state.clue = { dir, what: '沙鸡飞向', t: state.t };
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
        const dir = bearing(state.pos, state.world.oasis);
        say(state, `夜深了，${dir}方传来胡狼此起彼伏的嚎叫。胡狼离不开水，不会住得离水源太远。`, 'hint');
        state.clue = { dir, what: '胡狼的嚎叫来自', t: state.t };
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
      if (stationary && state.effects.sting <= state.t && hash01(state.seed + 47, state.t) < (SCORPION_RISK[tile.type] * state.hazard) / 60) {
        sting(state, sleeping ? '小腿上一阵火烧似的剧痛把你惊醒——一只蝎子钻进了长袍。伤处又肿又麻，心跳得厉害。' : '手边的沙子里蹿出一只蝎子，在你手背上蜇了一下。伤处又肿又麻，心跳得厉害。');
        eventStop = true;
      }
    }

    // 黎明最冷的时候，地下世界呼出的暖湿空气会凝成一缕白雾
    if (tod === 315 && !sleeping && env.storm === 0) {
      const g = state.world.gate;
      const dg = Math.hypot(g.x - state.pos.x, g.y - state.pos.y);
      if (dg > 0 && dg <= 7 && !tileAt(state.world, g.x, g.y).gateFound) {
        say(state, `天亮前最冷的那一刻，${bearing(state.pos, g)}方的地面上升起一缕细细的白雾，太阳一出来就散了。沙漠里不该有雾——那是地下的暖湿空气在往外冒。`, 'hint');
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
    if (eventStop || (stop && (act.long || ((act.kind === 'work' || act.kind === 'walk') && lv.heat >= 2) || lv.heat >= 3 || lv.dehyd >= 4 || lv.tired >= 2 || lv.cold >= 3))) {
      interrupted = true;
      break;
    }
    if (sleeping && body.fatigue <= 2) break;
  }
  if (!stationary) state.posture = 'stand';
  return { elapsed, interrupted };
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
  const minutes = Math.round(tr.minutes / speedFactor(state));
  // 按此刻的天气估算这一段路要流掉多少水
  const flux = heatFluxes(state.body, envNow(state), { met: tr.met * metMul(state), speed: 1000 / (minutes * 60) });
  return { dest, minutes, met: tr.met, waterL: (flux.waterLossLh * minutes) / 60 };
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
/** 此刻最要紧的一两条提醒。只说身体和环境的事实，怎么选由玩家定 */
export function advice(state) {
  if (state.over || state.act === 2) return [];
  const out = [];
  const env = envNow(state);
  const tile = here(state);
  const lv = state.levels;
  const sun = heatFluxes(state.body, env, { met: 4.5, speed: 0.8 }).waterLossLh;
  const shade = heatFluxes(state.body, env, { met: 1.2, shade: 0.8 }).waterLossLh;
  const coming = state.climate.storms.find((st) => state.t >= st.start - 45 && state.t < st.end);
  if (coming) out.push(env.storm > 0.5 ? '沙暴里走路会走偏，最好原地躲着。岩石的背风面或遮阴沟最稳妥。' : '沙暴快到了。趁还看得见，找岩石背风处，或者就地挖遮阴沟。');
  if (lv.heat >= 2) out.push('体温过高。立刻停下，到阴凉处休息、喝水，直到体温回到 38°C 以下。');
  else if (lv.dehyd >= 2 && state.inv.water > 0) out.push('已经明显脱水。水要喝进肚子里才算数，别省在水囊里。');
  if (!coming) {
    if (env.isDay && env.airT >= 33) {
      out.push(`现在赶路每小时失水约 ${sun.toFixed(1)} L，在阴凉处坐着只有 ${shade.toFixed(1)} L。${tile.shelter || tile.shade > 0.5 ? '这里有阴凉，可以歇到日落再走。' : '找岩石阴影，或者挖遮阴沟，歇到日落再走。'}`);
    } else {
      out.push(`现在凉快，赶路每小时只失水约 ${sun.toFixed(1)} L——这是走路的时候。`);
    }
  }
  const oasisSeen = tileAt(state.world, state.world.oasis.x, state.world.oasis.y).visited;
  if (oasisSeen) {
    out.push('绿洲的水是从地下流出来的。在绿洲“搜索”，看水从哪个方向来，再沿着竖井走。');
  } else if (state.clue) {
    out.push(`线索：${state.clue.what}${state.clue.dir}方（${Math.max(0, Math.round((state.t - state.clue.t) / 60))} 小时前）。绿洲离出生点不到 10 km。`);
  } else {
    out.push('还不知道水在哪。05:30 天亮和 18:30 日落时醒着，看沙鸡往哪个方向飞。');
  }
  if (tile.type === 'wadi' && !tile.searched && !oasisSeen) out.push('这是干河床，雨季的水曾从这里流向低处。“搜索”能知道沙下有没有潮气。');
  return out.slice(0, 3);
}

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
  if (state.act === 2) return actions2(state);
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
  if (tile.plants > 0) {
    if (tile.type === 'oasis') add('forage', '摘椰枣', `剩 ${tile.plants} 串 · 20 分钟`);
    else add('forage', '割取多肉植物', `剩 ${tile.plants} 株 · 20 分钟`);
  }
  if (tile.gateFound && tile.gateDug < 1) add('clearGate', '清理门前的积沙', `1 小时 · 已清 ${tile.gateDug.toFixed(1)} / 1.0 m`);
  if (tile.gateFound && tile.gateDug >= 1) add('enter', '转开闸门，走进地下', '第一幕的终点');
  if (!tile.shelter && tile.type !== 'oasis') add('digShelter', '挖遮阴沟', tile.shelterMin ? `还差 ${90 - tile.shelterMin} 分钟` : '90 分钟重体力');
  if (tile.still) add('packStill', '收起蒸馏器', `已凝结 ${tile.still.l.toFixed(2)} L`);
  else if (state.inv.sheet) add('still', '布置太阳能蒸馏器', '1 小时 · 只在白天产水');
  return list;
}

export function perform(state, id, arg) {
  if (state.over) return;
  if (state.act === 2) return perform2(state, id);
  const tile = here(state);
  const body = state.body;

  switch (id) {
    case 'move': {
      const why = canWalk(state);
      if (why) return say(state, why + '。', 'warn');
      let c = moveCost(state, arg.dx, arg.dy);
      if (!c) return say(state, '那边是地图之外的无尽沙海。', 'warn');
      const env0 = envNow(state);
      if (env0.storm > 0.5 && hash01(state.seed + 13, state.t) < 0.5 * state.hazard) {
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
        if (hash01(state.seed + 29, state.t) < risk * state.hazard) {
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
      if (!c.dest.visited) {
        c.dest.visited = true;
        if (c.dest.type === 'oasis') {
          say(state, '棕榈树下有一汪泉水。你跪下去，把脸埋进水里。喝够了才注意到：水是从一截半埋的混凝土涵管里流出来的，管口的铁箅子早就锈穿了。这不是天然的泉——是地下的什么地方在往外溢水。', 'good');
        } else if (c.dest.gate) {
          say(state, '这片岩壁的根部有一道太直的线，不像是风蚀出来的。值得搜一搜。', 'hint');
        } else if (c.dest.shaft && env0.storm <= 0.5) {
          say(state, '沙丘间露出一圈开裂的混凝土井圈，中间是一口笔直的竖井，井壁上嵌着一排锈断的爬梯。井口往外吹着风，深处隐约有流水声，还有一种低低的、不像是风的嗡鸣。', 'hint');
        }
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
      const target = envNow(state).isDay ? 1120 : 335; // 等到天亮后一刻钟，正好看见沙鸡
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
      if (tile.type === 'rock' && state.effects.sting <= state.t && hash01(state.seed + 53, state.t) < 0.06 * state.hazard) {
        sting(state, '你把手伸进石缝，指尖一阵剧痛——石头下面躲着一只蝎子。伤处又肿又麻，心跳得厉害。');
      }
      const gate = state.world.gate;
      if (tile.type === 'oasis') {
        say(state, `你顺着管口往里看：一条一人高的涵洞笔直地伸进黑暗，朝着${bearing(state.pos, gate)}方。洞顶每隔一段透下一点天光——地面上应该有一串竖井。沿着它们走，就能找到水的源头。`, 'hint');
      } else if (tile.shaft) {
        say(state, `你爬上井圈四下望：同样的井圈每隔两公里一个，排成一条直线。一头通向${bearing(state.pos, state.world.oasis)}方，另一头指向${bearing(state.pos, gate)}方——水是从那边流过来的。井太深，够不着水，但井口的风在白天是凉的。`, 'hint');
      } else if (tile.gate) {
        tile.gateFound = true;
        say(state, '岩壁根部有一道过于平直的缝，被流沙埋了大半。你扒开一点沙：是一扇金属闸门的上沿，漆皮下压着一行旧时代的字，风沙磨得只剩半串编号。缝里往外渗着凉气。', 'good');
      } else if (tile.pool > 0) {
        tile.poolFound = true;
        say(state, `岩缝深处有一个背阴的石窝，里面积着约 ${tile.pool.toFixed(1)} L 雨水。`, 'good');
      } else if (tile.type === 'wadi') {
        if (tile.waterDepth == null) say(state, '河床的沙子又干又松，往下掏了一臂深也没有潮气。');
        else if (tile.waterDepth < 1.1) say(state, '弯道外侧的沙子颜色发暗，掏开一层就有潮气——地下水很浅。', 'hint');
        else say(state, '深处的沙子略带潮气，往下挖一两米或许有水。', 'hint');
      } else if (tile.type === 'rock') {
        say(state, '岩石间只有风化的碎屑。不过岩壁下有一片可靠的阴影。');
      } else {
        const relic = RELICS[Math.floor(hash01(state.seed + 61, tile.x * 97 + tile.y) * RELICS.length * 2.5)];
        say(state, relic ?? '除了沙砾，什么也没有。', relic ? 'story' : 'info');
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
      if (tile.type === 'oasis') {
        eat(body, 400);
        say(state, '爬上树摘下一串熟透的椰枣，甜得发腻。（约 400 kcal）', 'good');
        break;
      }
      drink(body, 0.25);
      eat(body, 120);
      state.stats.drunk += 0.25;
      say(state, '削去硬皮，嚼下苦涩多汁的茎肉。（约 0.25 L 水，120 kcal）', 'good');
      break;
    }
    case 'clearGate': {
      const r = advance(state, 60, { met: 6, kind: 'work' });
      if (state.over) return;
      tile.gateDug = Math.min(1, tile.gateDug + (0.5 * r.elapsed) / 60);
      if (tile.gateDug >= 1) say(state, '最后一捧沙被扒开，整扇闸门露了出来。门中央有一只手轮。两百年了，轴上居然没有锈——有人，或者有什么东西，一直在给它上油。', 'good');
      else say(state, `扒了 ${fmtDur(r.elapsed)}的沙，门露出了 ${Math.round(tile.gateDug * 100)}%。`);
      break;
    }
    case 'enter': {
      say(state, '手轮转了三圈，闸门向内让开。门后是向下的台阶，凉而潮湿的空气扑在脸上，带着水、石头和机油的气味。很深的地方有一点光，不是火光。你回头看了一眼白得刺眼的地表，走了下去。', 'story');
      say(state, `【第一幕 · 地表】完。在地表活了 ${((state.t - state.t0) / 60).toFixed(0)} 小时，步行 ${state.stats.km} km。`, 'good');
      initAct2(state);
      return;
    }
    case 'digShelter': {
      const r = advance(state, 90 - (tile.shelterMin ?? 0), { met: 6, kind: 'work' });
      if (state.over) return;
      tile.shelterMin = (tile.shelterMin ?? 0) + r.elapsed;
      if (tile.shelterMin < 90) return say(state, `挖到一半（${Math.round((tile.shelterMin / 90) * 100)}%），身体先撑不住了。歇一歇再接着挖。`, 'warn');
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
