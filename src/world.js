// 世界生成：一片 41×41 km 的沙漠，每格 1 km。同一个种子永远生成同一片沙漠。
import { hash01 } from './physics.js';

export const SIZE = 41;

export const TERRAIN = {
  flat: { name: '砾石平原', minutes: 20, met: 4.5, view: 2 },
  dune: { name: '沙丘', minutes: 35, met: 6.5, view: 4 },
  rock: { name: '岩石露头', minutes: 30, met: 5, view: 3 },
  wadi: { name: '干河床', minutes: 20, met: 4.5, view: 2 },
  oasis: { name: '绿洲', minutes: 20, met: 4.5, view: 2 },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(seed, x, y, scale) {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const s = (t) => t * t * (3 - 2 * t);
  const v = (i, j) => hash01(seed + i * 7349, j * 9151 + seed);
  const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * s(tx);
  const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * s(tx);
  return a + (b - a) * s(ty);
}

export function tileAt(world, x, y) {
  if (x < 0 || y < 0 || x >= world.size || y >= world.size) return null;
  return world.tiles[y * world.size + x];
}

export function generateWorld(seed) {
  const rng = mulberry32(seed);
  const size = SIZE;
  const tiles = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const e = 0.65 * valueNoise(seed, x, y, 6) + 0.35 * valueNoise(seed + 31, x, y, 2.5);
      const r = valueNoise(seed + 977, x, y, 3.5);
      let type = 'flat';
      if (r > 0.74) type = 'rock';
      else if (e > 0.58) type = 'dune';
      tiles.push({
        x,
        y,
        type,
        shade: type === 'rock' ? 0.8 : 0,
        plants: type === 'flat' && rng() < 0.025 ? 2 : 0,
        pool: type === 'rock' && rng() < 0.15 ? 0.5 + rng() * 2 : 0, // 岩窝积水 L
        poolFound: false,
        waterDepth: null, // 干河床下的地下水埋深 m
        dug: 0,
        dry: false,
        well: null,
        shelter: false,
        still: null,
        searched: false,
        visited: false,
        shaft: false, // 涵洞的通风竖井
        gate: false, // 地下世界入口
        gateFound: false,
        gateDug: 0, // 已清开的积沙 m
        seen: false,
      });
    }
  }
  const world = { size, tiles, seed };

  // 出生点在地图中部，绿洲在 10–14 km 外
  const start = { x: 14 + Math.floor(rng() * 13), y: 14 + Math.floor(rng() * 13) };
  let oasis;
  for (let i = 0; i < 200 && !oasis; i++) {
    const ang = rng() * Math.PI * 2;
    const d = 7 + rng() * 3;
    const ox = Math.round(start.x + Math.cos(ang) * d);
    const oy = Math.round(start.y + Math.sin(ang) * d);
    if (ox >= 2 && oy >= 2 && ox < size - 2 && oy < size - 2) oasis = { x: ox, y: oy };
  }
  if (!oasis) oasis = { x: 3, y: 3 };

  // 干河床：从绿洲向两个方向蜿蜒，其中一支大致朝出生点方向延伸
  const toStart = Math.atan2(start.y - oasis.y, start.x - oasis.x);
  const carve = (heading, len) => {
    let x = oasis.x;
    let y = oasis.y;
    let h = heading;
    for (let k = 1; k <= len; k++) {
      h += (rng() - 0.5) * 0.9;
      // 四邻接地走，保证河床是连续可沿着走的
      if (Math.abs(Math.cos(h)) > Math.abs(Math.sin(h))) x += Math.sign(Math.cos(h));
      else y += Math.sign(Math.sin(h));
      const t = tileAt(world, x, y);
      if (!t) break;
      if (t.type === 'oasis') continue;
      t.type = 'wadi';
      t.pool = 0;
      t.shade = rng() < 0.4 ? 0.6 : 0; // 金合欢树荫
      t.plants = rng() < 0.3 ? 2 + Math.floor(rng() * 3) : 0;
      const depth = 0.4 + 0.12 * k + rng() * 0.6;
      t.waterDepth = depth <= 2.2 ? depth : null;
    }
  };
  carve(toStart + (rng() - 0.5) * 1.2, 18);
  carve(toStart + Math.PI + (rng() - 0.5) * 1.2, 14);

  const o = tileAt(world, oasis.x, oasis.y);
  Object.assign(o, { type: 'oasis', shade: 0.85, plants: 5, pool: 0, waterDepth: 0 }); // plants：椰枣

  const s = tileAt(world, start.x, start.y);
  Object.assign(s, { type: 'flat', shade: 0, plants: 0, pool: 0, waterDepth: null });

  // 地下世界：绿洲的水其实是从一条旧时代的涵洞里溢出来的，涵洞另一头就是地下世界。
  // 入口在绿洲另一侧 4–6 km 外的岩壁下，沿途每隔 2 km 有一口通风竖井。
  const away = Math.atan2(oasis.y - start.y, oasis.x - start.x);
  let gate;
  for (let i = 0; i < 2000 && !gate; i++) {
    const ang = away + (rng() - 0.5) * (i < 200 ? 2 : Math.PI * 2);
    const d = 4 + rng() * 2;
    const gx = Math.round(oasis.x + Math.cos(ang) * d);
    const gy = Math.round(oasis.y + Math.sin(ang) * d);
    const t = tileAt(world, gx, gy);
    if (!t || gx < 2 || gy < 2 || gx >= size - 2 || gy >= size - 2) continue;
    if (t.type === 'wadi' || Math.hypot(gx - start.x, gy - start.y) < 6) continue;
    gate = { x: gx, y: gy };
  }
  if (!gate) gate = { x: Math.min(size - 3, Math.max(2, oasis.x + (oasis.x < size / 2 ? 6 : -6))), y: oasis.y };
  const n = Math.round(Math.hypot(gate.x - oasis.x, gate.y - oasis.y));
  for (let k = 2; k < n; k += 2) {
    const t = tileAt(world, Math.round(oasis.x + ((gate.x - oasis.x) * k) / n), Math.round(oasis.y + ((gate.y - oasis.y) * k) / n));
    if (!t || t.type === 'oasis') continue;
    t.shaft = true;
    t.shade = Math.max(t.shade, 0.5); // 井口垒石和弃土堆的影子
  }
  Object.assign(tileAt(world, gate.x, gate.y), { type: 'rock', shade: 0.8, plants: 0, pool: 0, waterDepth: null, shaft: false, gate: true });

  world.start = start;
  world.oasis = oasis;
  world.gate = gate;
  return world;
}

/** 揭开以 (x,y) 为中心、半径 r 的迷雾 */
export function reveal(world, x, y, r) {
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > r * r + 0.5) continue;
      const t = tileAt(world, x + dx, y + dy);
      if (t) t.seen = true;
    }
  }
}

const DIRS = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
/** 从 a 指向 b 的八方位（屏幕坐标，y 向下为南） */
export function bearing(a, b) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  return DIRS[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
}
