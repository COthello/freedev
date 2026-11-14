// 第二幕的规则：在地下城市“深泉”里生活。身体仍然由同一套物理模型驱动。
import { heatFluxes, stepBody, causeOfDeath, drink, eat } from './physics.js';
import { BOTTLE_L, say, computeLevels, metMul, WARN, fmtDur } from './common.js';
import { CITY, DISTRICTS, EVENTS, LESSONS, NPCS, links, cityEnv, citySystems, cityTick, eventOn, newCity, peopleAt, lightsOn } from './city.js';

export const JOBS = {
  farms: { name: '采收', hours: 6, pay: 30, met: 3.2, open: [6, 22] },
  water: { name: '巡管', hours: 6, pay: 36, met: 3.8, open: [7, 17] },
  heat: { name: '热井巡检', hours: 4, pay: 60, met: 4.2, open: [14, 22], cooled: true },
};
const PRICE = { meal: 8, snack: 3, bunk: 12, clinic: 25, sheet: 35 };

export function initAct2(state) {
  state.act = 2;
  state.posture = 'stand';
  state.sight = null;
  state.city = newCity(state.seed);
  state.c2 = {
    loc: 'gate',
    examined: false,
    credits: 0,
    shifts: 0,
    resident: false,
    rel: {}, // 与每位居民的熟悉程度
    lastTalk: {},
    lessons: 0,
    day: -1,
    t0: state.t,
  };
  say(state, `台阶尽头是第二道门，门后有灯。一个提着油壶的老人转过身来，看着你，像看着一个不该存在的东西。这里是${CITY.name}——${CITY.founded} 年建成，${CITY.sealed} 年封闸，两万一千人。`, 'story');
  state.flux = heatFluxes(state.body, env2(state), { met: 1.2, shelter: true, indoor: true });
}

export function env2(state) {
  return cityEnv(state.c2.loc, state.t);
}

export function systems(state) {
  return citySystems(state.city, state.t);
}

/** 落户的三个条件 */
export function residency(state) {
  const c = state.c2;
  const sponsor = NPCS.find((n) => n.sponsor && (c.rel[n.id] ?? 0) >= 4);
  return { shifts: c.shifts, shiftsOk: c.shifts >= 3, sponsor: sponsor?.name ?? null, done: c.resident };
}

function advance2(state, minutes, act) {
  const body = state.body;
  const sleeping = act.kind === 'sleep';
  state.posture = sleeping ? 'sleep' : act.kind === 'rest' ? 'sit' : 'stand';
  let elapsed = 0;
  let interrupted = false;
  for (let i = 0; i < minutes; i++) {
    // 热井的规程：干 40 分钟，进冷却舱歇 20 分钟
    const cooling = act.cooled && i % 60 >= 40;
    const env = cityEnv(state.c2.loc, state.t, { cooled: cooling });
    const flux = heatFluxes(body, env, { met: (cooling ? 1.2 : act.met) * metMul(state), shelter: true, indoor: true, lying: sleeping });
    stepBody(body, flux, 60, { sleeping });
    state.flux = flux;
    state.t++;
    elapsed++;
    if (state.t % 60 === 0) cityTick(state.city, state.t);

    const tod = state.t % 1440;
    if (tod === 360) say(state, '大灯一盏一盏亮起来，城里的“早晨”到了。', 'env');
    if (tod === 1320) say(state, '大灯熄了，只剩廊灯。城里的“夜”到了。', 'env');
    announce(state);

    const cause = causeOfDeath(body);
    if (cause) {
      state.over = { win: false, cause };
      say(state, cause, 'death');
      return { elapsed, interrupted: true };
    }
    const lv = computeLevels(body);
    let stop = false;
    for (const k of Object.keys(lv)) {
      if (lv[k] > (state.levels[k] ?? 0)) {
        say(state, WARN[k][lv[k]], lv[k] >= 2 ? 'danger' : 'warn');
        if (lv[k] >= 2) stop = true;
      }
    }
    state.levels = lv;
    if (stop && (act.long || act.kind === 'work' || lv.heat >= 3 || lv.dehyd >= 4 || lv.tired >= 2)) {
      interrupted = true;
      break;
    }
    if (sleeping && body.fatigue <= 2) break;
  }
  state.posture = 'stand';
  return { elapsed, interrupted };
}

/** 每天第一次醒着的时候，知道今天城里的大事 */
function announce(state) {
  const day = Math.floor(state.t / 1440);
  if (state.c2.day === day || !state.c2.examined) return;
  state.c2.day = day;
  const ev = EVENTS[eventOn(state.seed, day)];
  if (ev !== EVENTS.none) say(state, `今天城里的事：${ev.name}。${ev.note}`, 'env');
}

function hourIn([a, b], t) {
  const h = (t % 1440) / 60;
  return h >= a && h < b;
}

function cost(state, base) {
  return Math.round(base * systems(state).foodPrice);
}

export function actions2(state) {
  const c = state.c2;
  const loc = c.loc;
  const sys = systems(state);
  const list = [];
  const add = (group, id, label, desc, ok = true, why = '') => list.push({ group, id, label, desc, enabled: ok, why });
  const afford = (n) => c.credits >= n;

  // —— 去别处 ——
  for (const l of links(loc)) {
    const d = DISTRICTS[l.to];
    add('go', `go:${l.to}`, `去${d.name}`, `${d.depth > DISTRICTS[loc].depth ? '下' : '上'}行 ${Math.abs(d.depth - DISTRICTS[loc].depth)} m · ${l.minutes} 分钟`, c.examined, '先过检疫');
  }

  // —— 找人说话 ——
  for (const n of peopleAt(loc, state.t)) {
    const recent = state.t - (c.lastTalk[n.id] ?? -999) < 120;
    add('talk', `talk:${n.id}`, `${n.name}`, `${n.role} · ${n.age} 岁`, !recent, '刚聊过，过会儿再来');
  }

  // —— 在这里能做的事 ——
  if (state.inv.water > 0.001) add('here', 'drink', '喝水 0.25 L', `水囊 ${state.inv.water.toFixed(2)} / ${BOTTLE_L} L`);
  if (loc === 'gate' && !c.examined) add('here', 'exam', '接受检疫', '1 小时 · 不过检疫不能进城');
  if (loc === 'market') {
    const meal = cost(state, PRICE.meal);
    const snack = cost(state, PRICE.snack);
    add('here', 'tap', '公共水龙头', '喝够并灌满水囊 · 不要钱');
    add('here', 'meal', '在食堂吃一顿', `${meal} 度 · 约 900 kcal`, afford(meal) && hourIn([5, 21], state.t), afford(meal) ? '食堂 5–21 点开' : '度不够');
    add('here', 'snack', '买一块豆饼', `${snack} 度 · 约 350 kcal`, afford(snack), '度不够');
    if (state.inv.sheet) add('here', 'sellSheet', '把塑料布卖给旧货商', `旧时代的东西 · ${PRICE.sheet} 度`, peopleAt(loc, state.t).some((n) => n.id === 'trader'), '塔依尔不在摊上');
    add('here', 'board', '看告示栏', '今天的大事和招工');
  }
  if (loc === 'homes') add('here', 'bunk', '租铺位睡一觉', `${PRICE.bunk} 度 · 至多 8 小时`, afford(PRICE.bunk) && state.body.fatigue >= 15, afford(PRICE.bunk) ? '还不困' : '度不够');
  if (JOBS[loc]) {
    const j = JOBS[loc];
    const pay = Math.round(j.pay * (loc === 'water' && sys.event === 'pump' ? 1.25 : 1));
    const open = hourIn(j.open, state.t) && (loc !== 'farms' || sys.lit > 0);
    add('here', `work:${loc}`, `上工：${j.name}`, `${j.hours} 小时 · ${pay} 度`, open && state.body.fatigue < 75, open ? '太累了，干不动' : `${j.open[0]}–${j.open[1]} 点招工`);
  }
  if (loc === 'school') {
    add('here', 'lesson', '听一堂课', c.lessons >= LESSONS.length ? '四堂课都听完了' : `第 ${c.lessons + 1} / ${LESSONS.length} 课 · 1 小时`, c.lessons < LESSONS.length && hourIn([8, 16], state.t), c.lessons >= LESSONS.length ? '都听完了' : '学堂 8–16 点上课');
    const hurt = state.effects.bite > state.t || state.effects.sting > state.t;
    if (hurt) add('here', 'clinic', '去医馆处理伤口', `${PRICE.clinic} 度`, afford(PRICE.clinic), '度不够');
  }
  if (loc === 'hall' && !c.resident) {
    const r = residency(state);
    const ok = r.shiftsOk && r.sponsor && hourIn([8, 18], state.t);
    add('here', 'register', '办理居民登记', `干满三个工（${Math.min(3, r.shifts)}/3）· 保人：${r.sponsor ?? '还没有'}`, ok, !hourIn([8, 18], state.t) ? '户籍处 8–18 点办公' : '条件还不够');
  }
  if (loc === 'archive') add('here', 'archive', '查阅卷宗', c.resident ? '开架区' : '需要居民证', c.resident, '需要居民证');
  add('here', 'rest', '歇 30 分钟', '');
  add('here', 'nap', '找个角落打盹', '至多 3 小时 · 睡不踏实', state.body.fatigue >= 30, '还不困');
  return list;
}

export function perform2(state, id) {
  const c = state.c2;
  const body = state.body;
  const act = actions2(state).find((a) => a.id === id);
  if (!act || !act.enabled) return;
  const sys = systems(state);
  const [kind, arg] = id.split(':');

  switch (kind) {
    case 'go': {
      const l = links(c.loc).find((x) => x.to === arg);
      const r = advance2(state, l.minutes, { met: 2.5, kind: 'walk' });
      if (state.over || r.interrupted) return;
      c.loc = arg;
      const d = DISTRICTS[arg];
      if (!c[`seen_${arg}`]) {
        c[`seen_${arg}`] = true;
        say(state, `${d.name}（地下 ${d.depth} m，${d.airT}°C）。${d.desc}`, 'story');
      }
      break;
    }
    case 'talk': {
      const n = NPCS.find((x) => x.id === arg);
      advance2(state, 15, { met: 1.3, kind: 'rest' });
      if (state.over) return;
      const rel = c.rel[n.id] ?? 0;
      const line = n.lines[Math.min(rel, n.lines.length - 1)];
      say(state, `${n.name}：${typeof line === 'function' ? line(state, sys) : line}`, 'talk');
      c.rel[n.id] = rel + 1;
      c.lastTalk[n.id] = state.t;
      break;
    }
    case 'drink': {
      const d = Math.min(0.25, state.inv.water);
      state.inv.water -= d;
      drink(body, d);
      state.stats.drunk += d;
      advance2(state, 2, { met: 1.2, kind: 'rest' });
      break;
    }
    case 'exam': {
      const pct = (Math.max(0, body.waterDeficit) / body.mass0) * 100;
      advance2(state, 60, { met: 1.1, kind: 'rest' });
      if (state.over) return;
      const hurt = state.effects.bite > state.t || state.effects.sting > state.t;
      drink(body, Math.min(2, Math.max(0, body.waterDeficit)));
      state.effects.bite = state.effects.sting = state.effects.pain = 0;
      c.examined = true;
      c.credits += 40;
      say(state, `检疫记录：核心体温 ${body.coreT.toFixed(1)}°C；入闸时失水 ${pct.toFixed(1)}%，已口服补液；${hurt ? '下肢毒物咬伤，已清创处理；' : ''}皮肤大面积日光灼伤（本馆无此病例先例）。无传染病征象。`, 'good');
      say(state, '医生在一张表上写了很久，最后在“来源”一栏停住，填了两个字：闸外。你拿到一张临时通行证和 40 度安置配额。“度”是这里的钱——一度就是一度电。', 'info');
      break;
    }
    case 'tap': {
      advance2(state, 5, { met: 1.3, kind: 'rest' });
      const d = Math.min(1.5, Math.max(0, body.waterDeficit + 0.3));
      drink(body, d);
      state.stats.drunk += d;
      state.inv.water = BOTTLE_L;
      say(state, `拧开龙头，水就流出来。喝了 ${d.toFixed(2)} L，灌满了水囊。旁边的人奇怪地看着你——没人会对着一个水龙头发呆。`);
      break;
    }
    case 'meal': {
      const p = cost(state, PRICE.meal);
      c.credits -= p;
      advance2(state, 30, { met: 1.3, kind: 'rest' });
      eat(body, 900);
      drink(body, 0.5);
      say(state, `花 ${p} 度在食堂吃了一顿：莴苣、豆子、菌子，一碗热汤。`, 'good');
      break;
    }
    case 'snack': {
      const p = cost(state, PRICE.snack);
      c.credits -= p;
      advance2(state, 5, { met: 1.3, kind: 'rest' });
      eat(body, 350);
      say(state, `花 ${p} 度买了一块豆饼，边走边吃。`);
      break;
    }
    case 'sellSheet': {
      state.inv.sheet = false;
      c.credits += PRICE.sheet;
      advance2(state, 10, { met: 1.3, kind: 'rest' });
      say(state, `塔依尔把塑料布对着灯看了半天。“两百年的东西，一个洞都没有。”他数给你 ${PRICE.sheet} 度。在上面它救过你的命，在这里它是古董。`, 'good');
      break;
    }
    case 'board': {
      advance2(state, 5, { met: 1.3, kind: 'rest' });
      const ev = EVENTS[sys.event];
      say(state, `告示栏。今日：${ev.name}——${ev.note} 招工：光田采收 30 度/6 小时，水厂巡管 36 度/6 小时，热井巡检 60 度/4 小时。存粮 ${state.city.foodDays.toFixed(0)} 天。`, 'env');
      break;
    }
    case 'bunk': {
      c.credits -= PRICE.bunk;
      const r = advance2(state, 480, { met: 0.95, kind: 'sleep', long: true });
      if (!state.over) say(state, `在客栈的铺位上睡了 ${fmtDur(r.elapsed)}。被子是干的，没有沙。`);
      break;
    }
    case 'nap': {
      const r = advance2(state, 180, { met: 1, kind: 'sleep', long: true });
      body.fatigue = Math.min(100, body.fatigue + (r.elapsed / 60) * 5); // 硬地、灯光、脚步声：只恢复一半
      if (!state.over) say(state, `靠着墙睡了 ${fmtDur(r.elapsed)}，被路过的脚步声吵醒了好几回。`);
      break;
    }
    case 'rest':
      advance2(state, 30, { met: 1.2, kind: 'rest' });
      break;
    case 'work': {
      const j = JOBS[arg];
      const pay = Math.round(j.pay * (arg === 'water' && sys.event === 'pump' ? 1.25 : 1));
      const r = advance2(state, j.hours * 60, { met: j.met, kind: 'work', cooled: j.cooled });
      if (state.over) return;
      const part = r.elapsed / (j.hours * 60);
      const got = Math.round(pay * part);
      c.credits += got;
      if (r.interrupted) {
        say(state, `干了 ${fmtDur(r.elapsed)}，身体撑不住，被工友扶了出来。按钟点结了 ${got} 度，这个工不算数。`, 'warn');
      } else {
        c.shifts++;
        say(state, `${j.name}，干满 ${j.hours} 小时，领到 ${got} 度。${WORK_NOTE[arg]}`, 'good');
      }
      break;
    }
    case 'lesson': {
      advance2(state, 60, { met: 1.1, kind: 'rest' });
      if (state.over) return;
      say(state, LESSONS[c.lessons], 'story');
      c.lessons++;
      break;
    }
    case 'clinic': {
      c.credits -= PRICE.clinic;
      advance2(state, 40, { met: 1.1, kind: 'rest' });
      state.effects.bite = state.effects.sting = state.effects.pain = 0;
      say(state, `花 ${PRICE.clinic} 度处理了伤口。`, 'good');
      break;
    }
    case 'register': {
      advance2(state, 45, { met: 1.2, kind: 'rest' });
      c.resident = true;
      say(state, `庞正则在表上自己添了一栏，写上“出生区：闸外”，盖了章。你成了${CITY.name}第 ${CITY.pop + 1} 位居民，也是一百二十八年来唯一一个不是在这里出生的。`, 'good');
      say(state, '【第二幕 · 第一章】完。你有了居民证，可以进档案馆了。封闸的真相在闭架区——这是下一章的事。', 'story');
      break;
    }
    case 'archive': {
      advance2(state, 60, { met: 1.1, kind: 'rest' });
      say(state, '开架区里是两百年的收成表、出生册、议事记录。你翻到 2098 年：那一年的议事记录比别的年份薄得多，中间少了十一页，装订线是后来重新缝的。', 'hint');
      break;
    }
    default:
      return;
  }
  if (!state.over) state.flux = heatFluxes(body, env2(state), { met: 1.2, shelter: true, indoor: true });
}

const WORK_NOTE = {
  farms: '指尖全是莴苣汁，眼睛里全是紫红色的残影。',
  water: '粉笔画了十四个圈。水库边很凉，凉得你有点不习惯。',
  heat: '衣服拧得出水。冷却舱的门一开，所有人都不说话，只喘气。',
};

export { lightsOn };
