// 物理内核：沙漠气候 + 人体热平衡 / 水平衡 / 能量平衡。
// 全部使用国际单位（W、°C、kPa、L、kcal），不依赖 DOM，可在 Node 中直接测试。

export const LATENT = 2.426e6; // 汗液汽化潜热 J/kg（约 30°C）
export const CP_BODY = 3470; // 人体平均比热 J/(kg·K)
export const KCAL = 4184; // J
export const FAT_KCAL_PER_KG = 7700;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (d) => (d * Math.PI) / 180;

/** 饱和水汽压 (kPa)，Magnus 公式 */
export function satVaporKPa(T) {
  return 0.61094 * Math.exp((17.625 * T) / (T + 243.04));
}

/** 确定性哈希 → [0,1) */
export function hash01(a, b = 0) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const DEFAULT_CLIMATE = {
  lat: 24, // 北纬，度
  doy0: 172, // 第 0 天是一年中的第几天（夏至前后）
  tMin: 19, // 黎明最低气温 °C
  tMax: 43, // 午后最高气温 °C
  vapor: 0.9, // 水汽压 kPa（露点约 5.5°C，几乎不随昼夜变化）
  seed: 1,
  storms: [], // [{ start, end, peak }]，分钟与 m/s
};

/**
 * 给定时刻（从第 0 天 00:00 起的分钟数）的环境状态。
 */
export function climate(tMin, c = DEFAULT_CLIMATE) {
  const day = Math.floor(tMin / 1440);
  const hour = (tMin % 1440) / 60;

  // —— 太阳位置 ——
  const doy = c.doy0 + day;
  const decl = rad(23.44) * Math.sin((2 * Math.PI * (doy - 81)) / 365);
  const lat = rad(c.lat);
  const ha = rad(15 * (hour - 12));
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const sunElev = Math.asin(clamp(sinEl, -1, 1));

  // —— 晴空辐射（Kasten-Young 大气质量 + 经验透过率）——
  let dni = 0;
  let dhi = 0;
  if (sinEl > 0.01) {
    const elDeg = (sunElev * 180) / Math.PI;
    const am = 1 / (sinEl + 0.50572 * Math.pow(elDeg + 6.07995, -1.6364));
    dni = 1361 * Math.pow(0.7, Math.pow(am, 0.678));
    dhi = 0.1 * dni;
  }
  // —— 沙暴：0 无 → 1 最强，前后各有 20 分钟的渐变 ——
  let storm = 0;
  let stormPeak = 0;
  for (const s of c.storms ?? []) {
    if (tMin >= s.start && tMin < s.end) {
      storm = Math.min(1, (tMin - s.start + 1) / 20, (s.end - tMin) / 20);
      stormPeak = s.peak;
    }
  }
  if (storm > 0) {
    // 悬浮的沙尘挡掉九成直射光，其中一部分变成散射光
    const clear = dni * Math.max(0, sinEl) + dhi;
    dni *= 1 - 0.9 * storm;
    dhi = dhi * (1 - storm) + 0.22 * clear * storm;
  }
  const ghi = dni * Math.max(0, sinEl) + dhi;

  // —— 气温：05:30 最低，15:00 最高，余弦插值 ——
  const off = (hash01(c.seed, day) - 0.5) * 4; // 每天 ±2°C
  const lo = c.tMin + off;
  const hi = c.tMax + off;
  let airT;
  if (hour >= 5.5 && hour <= 15) {
    airT = lo + ((hi - lo) * (1 - Math.cos((Math.PI * (hour - 5.5)) / 9.5))) / 2;
  } else {
    const h2 = hour < 5.5 ? hour + 24 : hour;
    airT = lo + ((hi - lo) * (1 + Math.cos((Math.PI * (h2 - 15)) / 14.5))) / 2;
  }

  if (storm > 0) airT -= 3 * storm; // 沙尘遮日，气温略降

  // —— 地表温度：白天被日照烤热，夜间辐射冷却 ——
  const groundT = airT - 4 + 0.03 * ghi;
  const soilT = (c.tMin + c.tMax) / 2; // 沙面下约半米，全天接近日均温

  // —— 风：午后最强，夜间近乎静风 ——
  const base = 1 + 3 * hash01(c.seed + 7919, day);
  const wind = 0.4 + base * (0.25 + 0.75 * Math.max(0, Math.sin((Math.PI * (hour - 7)) / 12)));

  const windNow = wind + (stormPeak - wind) * storm;

  const vapor = c.vapor;
  const rh = clamp((vapor / satVaporKPa(airT)) * 100, 1, 100);

  return { day, hour, sunElev, dni, dhi, ghi, airT, groundT, soilT, wind: storm > 0 ? windNow : wind, vapor, rh, storm, isDay: sinEl > 0 };
}

/** 根据初始设定创建身体 */
export function createBody({ sex = 'male', age = 25, heightCm = 172, massKg = 68 } = {}) {
  const male = sex === 'male';
  const bmi = massKg / Math.pow(heightCm / 100, 2);
  const bsa = 0.007184 * Math.pow(massKg, 0.425) * Math.pow(heightCm, 0.725); // DuBois
  const bmrKcal = 10 * massKg + 6.25 * heightCm - 5 * age + (male ? 5 : -161); // Mifflin-St Jeor
  const fatFrac = clamp((1.2 * bmi + 0.23 * age - 10.8 * (male ? 1 : 0) - 5.4) / 100, 0.06, 0.5); // Deurenberg
  return {
    sex,
    age,
    heightCm,
    mass0: massKg,
    bmi,
    bsa,
    bmrKcal,
    bmrW: (bmrKcal * KCAL) / 86400,
    waterL0: massKg * (male ? 0.6 : 0.52), // 体内总水量
    coreT: 37,
    waterDeficit: 0, // L，相对正常含水量的亏缺
    fatKg: massKg * fatFrac,
    fatKg0: massKg * fatFrac,
    glycogenKcal: 1500,
    fatigue: 10, // 0–100
    maxCoreT: 37,
    maxDehydration: 0,
  };
}

export function dehydrationPct(body) {
  return (Math.max(0, body.waterDeficit) / body.mass0) * 100;
}

/**
 * 某一瞬间的人体热流（W，流入身体为正）。
 * ctx: { met, shade(0–1), shelter(bool), draft(bool), speed(m/s), lying(bool), clothed(bool) }
 */
export function heatFluxes(body, env, ctx) {
  const met = ctx.met ?? 1.2;
  const shade = ctx.shelter ? 0.95 : ctx.shade ?? 0;
  const clothed = ctx.clothed !== false;
  const pct = dehydrationPct(body);
  // 竖井口的气流来自地下，温度接近全年均温：白天凉，夜里暖
  const airT = env.airT + (ctx.draft ? 0.6 * (env.soilT - env.airT) : 0);

  // 代谢产热（含寒战）
  const shiver = body.coreT < 36.6 ? Math.min(2.5 * body.bmrW, 400 * (36.6 - body.coreT)) : 0;
  const metabolic = body.bmrW * met + shiver;

  // 太阳辐射：直射（按太阳高度的投影面积）+ 天空散射 + 沙面反射
  let solar = 0;
  if (env.sunElev > 0) {
    const fp = 0.08 + 0.22 * Math.cos(env.sunElev);
    const absorb = clothed ? 0.45 : 0.7;
    solar =
      absorb *
      body.bsa *
      (fp * env.dni * (1 - shade) + 0.35 * (env.dhi * (1 - 0.7 * shade) + 0.35 * env.ghi * (1 - shade)));
  }

  // 干热交换：对流 + 长波辐射，经过衣物与皮下组织两层热阻
  const v = env.wind * (ctx.shelter && !ctx.indoor ? 0.3 : 1) + (ctx.speed ?? 0); // 室内的风速已是实际值
  const hc = Math.max(3, 8.3 * Math.pow(v, 0.6));
  const hr = 4.7;
  let tMrt;
  if (ctx.shelter) {
    tMrt = 0.7 * env.soilT + 0.3 * airT;
  } else {
    const ground = env.groundT * (1 - shade) + Math.min(env.groundT, airT + 2) * shade;
    const sky = (airT - 15) * (1 - 0.5 * shade) + airT * 0.5 * shade;
    tMrt = 0.5 * ground + 0.5 * sky;
  }
  const tOp = (hc * airT + hr * tMrt) / (hc + hr);
  const dilation = clamp((body.coreT - 36.5) / 0.5, 0, 1); // 血管舒张程度
  const rTissue = 0.11 - 0.08 * dilation;
  const rCl = clothed ? 0.093 : 0;
  const area = body.bsa * (ctx.lying ? 0.75 : 1);
  const dry = (area * (tOp - body.coreT)) / (rTissue + rCl + 1 / (hc + hr));

  // 蒸发散热：由体温调节驱动，受环境最大蒸发量与出汗能力限制
  const load = metabolic + solar + dry;
  const target = 37 + 0.1 * Math.max(0, met - 1.2) + 0.15 * pct;
  const need = Math.max(0, load + 300 * (body.coreT - target));
  const eMax = area * 16.5 * hc * Math.max(0, satVaporKPa(35) - env.vapor) * (clothed ? 0.45 : 1);
  const sweatCapLh = 1.5 * (body.bsa / 1.8) * clamp(1 - (pct - 2) / 12, 0.15, 1);
  const ratio = eMax > 0 ? need / eMax : 1;
  const eta = ratio < 0.5 ? 1 : Math.max(0.55, 1 - 0.6 * (ratio - 0.5)); // 汗水滴落的浪费
  const evap = Math.min(need, eMax, (sweatCapLh / 3600) * LATENT * eta);
  const sweatLh = (evap / eta / LATENT) * 3600;

  // 不显性失水：呼吸 + 皮肤扩散 + 最低尿量
  const insensibleLh = 0.04 + 0.0125 * Math.pow(met, 0.8);

  return {
    metabolic,
    shiver,
    solar,
    dry,
    evap,
    storage: load - evap,
    sweatLh,
    waterLossLh: sweatLh + insensibleLh,
    tOp,
    met,
  };
}

/** 用给定热流把身体状态推进 dt 秒 */
export function stepBody(body, flux, dtSec, { sleeping = false } = {}) {
  const mass = currentMass(body);
  body.coreT += (flux.storage * dtSec) / (mass * CP_BODY);
  body.waterDeficit += (flux.waterLossLh * dtSec) / 3600;

  // 能量：运动时优先消耗糖原，其余来自脂肪
  const kcal = (flux.metabolic * dtSec) / KCAL;
  const fromGly = Math.min(body.glycogenKcal, kcal * (flux.met > 2 ? 0.6 : 0.2));
  body.glycogenKcal -= fromGly;
  body.fatKg -= (kcal - fromGly) / FAT_KCAL_PER_KG;

  // 疲劳
  const h = dtSec / 3600;
  if (sleeping) {
    const poor = body.coreT < 36.3 || body.coreT > 38.3 ? 0.5 : 1; // 太冷太热都睡不好
    body.fatigue -= 12 * poor * h;
  } else {
    const wall = body.glycogenKcal < 200 ? 1.5 : 1; // 糖原耗尽，“撞墙”
    body.fatigue += 3 * (1 + 0.2 * Math.max(0, flux.met - 1)) * wall * h;
  }
  body.fatigue = clamp(body.fatigue, 0, 100);

  body.maxCoreT = Math.max(body.maxCoreT, body.coreT);
  body.maxDehydration = Math.max(body.maxDehydration, dehydrationPct(body));
}

export function currentMass(body) {
  return body.mass0 - Math.max(0, body.waterDeficit) - (body.fatKg0 - body.fatKg);
}

/** 喝水。多喝的部分最多储存 0.5 L，其余排出 */
export function drink(body, liters) {
  body.waterDeficit = Math.max(-0.5, body.waterDeficit - liters);
}

export function eat(body, kcal) {
  const room = 2000 - body.glycogenKcal;
  const toGly = Math.min(room, kcal);
  body.glycogenKcal += toGly;
  body.fatKg += (kcal - toGly) / FAT_KCAL_PER_KG;
}

/** 致死判定。返回 null 或死因字符串 */
export function causeOfDeath(body) {
  if (body.coreT >= 42) return '热射病：核心体温超过 42°C，器官衰竭';
  if (body.coreT <= 29) return '失温：核心体温跌破 29°C，心脏停跳';
  if (dehydrationPct(body) >= 15) return '脱水：失去了相当于体重 15% 的水分';
  if (body.fatKg <= body.mass0 * 0.03) return '饥饿：脂肪储备耗尽';
  return null;
}
