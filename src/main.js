// 界面层：把游戏状态画出来，把点击翻译成行动。
import { createBody, dehydrationPct, currentMass, climate } from './physics.js';
import { CITY, DISTRICTS, EVENTS, lightsOn } from './city.js';
import { systems, residency } from './act2.js';
import { TERRAIN, tileAt } from './world.js';
import { newGame, perform, actions, advice, ailments, moveCost, envNow, here, clock, refreshFlux, BOTTLE_L } from './game.js';

import { create as createView3D } from './view3d.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'born-in-sand-act1';
let state = null;
let view3d = null; // 3D 视角；没有 WebGL 时保持 null，用 2D 画面
try {
  view3d = createView3D(document.getElementById('scene3d'));
} catch {
  view3d = null;
}

// —— 存档 ——
function save() {
  try {
    if (state) localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    else localStorage.removeItem(SAVE_KEY);
  } catch {}
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    return s && s.version === 5 ? s : null;
  } catch {
    return null;
  }
}

// —— 出生设定 ——
function formCfg() {
  const num = (id, lo, hi, d) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  const seedText = $('f-seed').value.trim();
  const seed = /^\d+$/.test(seedText) ? Number(seedText) % 4294967296 : undefined;
  return {
    name: $('f-name').value.trim() || '无名者',
    sex: $('f-sex').value,
    age: num('f-age', 16, 70, 26),
    heightCm: num('f-height', 140, 210, 172),
    massKg: num('f-mass', 40, 130, 68),
    difficulty: $('f-diff').value,
    seed,
  };
}
function renderDerived() {
  const b = createBody(formCfg());
  const rows = [
    ['体表面积', `${b.bsa.toFixed(2)} m²`],
    ['基础代谢', `${Math.round(b.bmrKcal)} kcal/天 · ${Math.round(b.bmrW)} W`],
    ['体内水量', `${b.waterL0.toFixed(1)} L`],
    ['致命失水量', `${(b.mass0 * 0.15).toFixed(1)} L`],
    ['脂肪储备', `${b.fatKg.toFixed(1)} kg · ${Math.round(b.fatKg * 7700)} kcal`],
    ['BMI', b.bmi.toFixed(1)],
  ];
  $('derived').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// —— 颜色工具 ——
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => Math.round(lerp(v, c2[i], Math.min(1, Math.max(0, t)))));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function fitCanvas(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(50, Math.round(cv.clientWidth));
  const h = Math.max(50, Math.round(cv.clientHeight));
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// —— 场景：天空、太阳、地表、人 ——
function drawScene() {
  const { ctx, w, h } = fitCanvas($('scene'));
  const env = envNow(state);
  const tile = here(state);
  const el = (env.sunElev * 180) / Math.PI;
  const light = Math.min(1, Math.max(0, (el + 6) / 18)); // 0 夜 → 1 昼
  const low = Math.max(0, 1 - Math.abs(el) / 14); // 太阳贴近地平线

  // 天空
  let top = mix([8, 10, 32], [52, 132, 214], light);
  let bot = mix([26, 26, 58], [206, 228, 244], light);
  bot = mix(bot, [236, 128, 72], low * 0.85);
  top = mix(top, [88, 84, 150], low * 0.5);
  const hz = h * 0.6;
  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, rgb(top));
  sky.addColorStop(1, rgb(bot));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, hz);

  // 星星
  if (light < 0.6) {
    ctx.fillStyle = rgb([255, 250, 235], 1 - light / 0.6);
    for (let i = 0; i < 70; i++) {
      const x = ((i * 9301 + 49297) % 233280) / 233280;
      const y = ((i * 4621 + 8191) % 10007) / 10007;
      ctx.fillRect(x * w, y * hz * 0.92, i % 7 === 0 ? 2 : 1, i % 7 === 0 ? 2 : 1);
    }
  }
  // 太阳：自东（左）向西（右）
  if (el > -3) {
    const sx = w * (0.08 + (0.84 * (env.hour - 5.3)) / 13.4);
    const sy = hz - Math.sin(env.sunElev) * hz * 0.88;
    const g = ctx.createRadialGradient(sx, sy, 2, sx, sy, 60);
    g.addColorStop(0, 'rgba(255,244,214,0.9)');
    g.addColorStop(1, 'rgba(255,244,214,0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - 60, sy - 60, 120, 120);
    ctx.fillStyle = rgb(mix([255, 150, 80], [255, 250, 230], Math.min(1, el / 20)));
    ctx.beginPath();
    ctx.arc(sx, sy, 11, 0, 7);
    ctx.fill();
  }

  // 远处沙丘
  const sandFar = mix([40, 38, 66], [214, 178, 122], light);
  const sand = mix([52, 48, 74], [231, 201, 143], light);
  ctx.fillStyle = rgb(sandFar);
  ctx.beginPath();
  ctx.moveTo(0, hz);
  for (let x = 0; x <= w; x += 8) {
    const k = x / w + state.pos.x * 0.37 + state.pos.y * 0.61;
    ctx.lineTo(x, hz - 6 - 10 * Math.sin(k * 5.1) - 7 * Math.sin(k * 11.7 + 1));
  }
  ctx.lineTo(w, hz + 4);
  ctx.lineTo(0, hz + 4);
  ctx.fill();
  ctx.fillStyle = rgb(sand);
  ctx.fillRect(0, hz, w, h - hz);

  const dark = (c) => rgb(mix([24, 22, 40], c, 0.25 + 0.75 * light));
  const cx = w * 0.5;
  const gy = h * 0.86;

  // 地形特征
  if (tile.type === 'dune') {
    ctx.fillStyle = dark([240, 176, 98]);
    ctx.beginPath();
    ctx.moveTo(w * 0.05, h);
    ctx.quadraticCurveTo(w * 0.42, hz - h * 0.12, w * 0.7, hz + h * 0.1);
    ctx.quadraticCurveTo(w * 0.85, h * 0.9, w, h);
    ctx.fill();
  } else if (tile.type === 'rock') {
    ctx.fillStyle = dark([112, 94, 84]);
    ctx.beginPath();
    ctx.moveTo(w * 0.56, gy + 6);
    ctx.lineTo(w * 0.6, hz - h * 0.16);
    ctx.lineTo(w * 0.7, hz - h * 0.24);
    ctx.lineTo(w * 0.8, hz - h * 0.1);
    ctx.lineTo(w * 0.88, gy + 6);
    ctx.fill();
    ctx.fillStyle = dark([80, 66, 62]);
    ctx.fillRect(w * 0.52, gy - 2, w * 0.2, 8);
  } else if (tile.type === 'wadi' || tile.type === 'oasis') {
    ctx.fillStyle = dark(tile.type === 'oasis' ? [70, 150, 190] : [190, 180, 140]);
    ctx.beginPath();
    ctx.ellipse(w * 0.62, gy + 4, w * 0.3, h * 0.07, 0, 0, 7);
    ctx.fill();
    const trees = tile.type === 'oasis' ? [0.3, 0.68, 0.8] : tile.shade > 0 ? [0.66] : [];
    for (const tx of trees) {
      const x = w * tx;
      ctx.strokeStyle = dark([92, 70, 50]);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, gy + 2);
      ctx.quadraticCurveTo(x + 6, gy - h * 0.2, x + 2, gy - h * 0.38);
      ctx.stroke();
      ctx.fillStyle = dark(tile.type === 'oasis' ? [52, 140, 90] : [110, 130, 80]);
      ctx.beginPath();
      ctx.ellipse(x + 2, gy - h * 0.4, tile.type === 'oasis' ? 26 : 34, tile.type === 'oasis' ? 12 : 10, 0, 0, 7);
      ctx.fill();
    }
  }
  if (tile.shaft) {
    // 竖井：沙堆里露出的井圈，中间一口黑井
    const mx = w * 0.72;
    ctx.fillStyle = dark([196, 164, 112]);
    ctx.beginPath();
    ctx.moveTo(mx - 60, gy + 6);
    ctx.quadraticCurveTo(mx, gy - 34, mx + 60, gy + 6);
    ctx.fill();
    ctx.fillStyle = dark([120, 104, 92]);
    ctx.beginPath();
    ctx.ellipse(mx, gy - 13, 19, 6, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#0d0b14';
    ctx.beginPath();
    ctx.ellipse(mx, gy - 13, 13, 3.5, 0, 0, 7);
    ctx.fill();
  }
  if (tile.gateFound) {
    // 岩壁根部的闸门，积沙随清理而降低
    const dx0 = w * 0.655;
    const dw = 34;
    const dh = 44;
    ctx.fillStyle = dark([150, 130, 112]);
    ctx.fillRect(dx0 - 5, gy - dh - 5, dw + 10, dh + 11);
    ctx.fillStyle = '#0d0b14';
    ctx.fillRect(dx0, gy - dh, dw, dh + 6);
    const sandH = (dh + 6) * (1 - 0.85 * tile.gateDug);
    ctx.fillStyle = rgb(sand);
    ctx.beginPath();
    ctx.moveTo(dx0 - 30, gy + 6);
    ctx.quadraticCurveTo(dx0 + dw / 2, gy + 6 - sandH * 1.7, dx0 + dw + 30, gy + 6);
    ctx.fill();
  }
  if (tile.plants > 0 && tile.type !== 'oasis') {
    ctx.fillStyle = dark([96, 140, 86]);
    for (let i = 0; i < tile.plants; i++) {
      ctx.beginPath();
      ctx.ellipse(w * 0.2 + i * 16, gy + 2, 5, 9, 0, 0, 7);
      ctx.fill();
    }
  }
  if (tile.still) {
    ctx.fillStyle = 'rgba(190,220,235,0.75)';
    ctx.beginPath();
    ctx.ellipse(w * 0.36, gy + 6, 22, 6, 0, 0, 7);
    ctx.fill();
  }
  if (tile.shelter) {
    ctx.fillStyle = dark([70, 56, 50]);
    ctx.fillRect(cx - 34, gy + 1, 68, 7);
  }

  // 影子：长度随太阳高度变化
  const inShade = tile.shelter || tile.shade > 0.5;
  if (el > 2 && !(inShade && state.posture !== 'stand')) {
    const len = Math.min(140, 34 / Math.tan(env.sunElev));
    const dir = env.hour < 12.2 ? 1 : -1;
    ctx.fillStyle = 'rgba(30,24,40,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx + (dir * len) / 2, gy + 3, len / 2 + 5, 3.5, 0, 0, 7);
    ctx.fill();
  }
  // 人
  ctx.fillStyle = dark([238, 232, 220]);
  const skin = dark([150, 104, 78]);
  if (state.posture === 'sleep' || state.over?.win === false) {
    ctx.fillRect(cx - 18, gy - 5, 32, 8);
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(cx + 19, gy - 2, 4.5, 0, 7);
    ctx.fill();
  } else {
    const sit = state.posture === 'sit';
    const bh = sit ? 18 : 30;
    ctx.beginPath();
    ctx.moveTo(cx - 7, gy);
    ctx.lineTo(cx - 4, gy - bh);
    ctx.lineTo(cx + 4, gy - bh);
    ctx.lineTo(cx + 8, gy);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(cx, gy - bh - 5, 4.5, 0, 7);
    ctx.fill();
  }

  // 夜间动物
  const sight = state.sight && state.sight.until > state.t ? state.sight.kind : null;
  if (sight) {
    const ax = w * 0.3;
    ctx.fillStyle = dark(sight === 'fennec' ? [226, 196, 150] : sight === 'viper' ? [170, 140, 96] : [70, 52, 40]);
    ctx.strokeStyle = ctx.fillStyle;
    if (sight === 'fennec') {
      ctx.beginPath();
      ctx.ellipse(ax, gy - 6, 11, 5, 0, 0, 7); // 身体
      ctx.ellipse(ax + 11, gy - 11, 4.5, 4, 0, 0, 7); // 头
      ctx.fill();
      ctx.beginPath(); // 大耳朵
      ctx.moveTo(ax + 8, gy - 13);
      ctx.lineTo(ax + 6, gy - 25);
      ctx.lineTo(ax + 12, gy - 15);
      ctx.moveTo(ax + 12, gy - 14);
      ctx.lineTo(ax + 15, gy - 25);
      ctx.lineTo(ax + 16, gy - 13);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.beginPath(); // 尾巴
      ctx.moveTo(ax - 10, gy - 6);
      ctx.quadraticCurveTo(ax - 20, gy - 8, ax - 22, gy - 1);
      ctx.stroke();
      ctx.fillRect(ax - 7, gy - 3, 2, 5);
      ctx.fillRect(ax + 6, gy - 3, 2, 5);
    } else if (sight === 'viper') {
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax - 22, gy + 3);
      ctx.bezierCurveTo(ax - 12, gy - 6, ax - 6, gy + 10, ax + 4, gy + 1);
      ctx.bezierCurveTo(ax + 10, gy - 5, ax + 16, gy + 4, ax + 22, gy - 3);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(ax, gy + 2, 6, 3, 0, 0, 7);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.beginPath(); // 翘起的尾刺
      ctx.moveTo(ax - 5, gy + 1);
      ctx.quadraticCurveTo(ax - 14, gy - 10, ax - 5, gy - 9);
      ctx.moveTo(ax + 5, gy + 1); // 螯
      ctx.lineTo(ax + 11, gy - 3);
      ctx.moveTo(ax + 5, gy + 3);
      ctx.lineTo(ax + 12, gy + 4);
      ctx.stroke();
    }
  }

  // 沙暴：土黄色的幕和横飞的沙
  if (env.storm > 0) {
    const s = env.storm;
    ctx.fillStyle = rgb(mix([58, 44, 30], [196, 150, 84], light), 0.86 * s);
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = rgb(mix([120, 96, 66], [236, 206, 150], light), 0.5 * s);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 90; i++) {
      const x = ((i * 7919 + state.t * 37) % 1000) / 1000;
      const y = ((i * 4813 + state.t * 11) % 997) / 997;
      ctx.moveTo(x * w, y * h);
      ctx.lineTo(x * w + 26 + (i % 5) * 8, y * h + 3);
    }
    ctx.stroke();
  }

  const coming = state.climate.storms.find((st) => state.t >= st.start - 45 && state.t < st.start);
  $('storm').hidden = !(env.storm > 0 || coming);
  $('storm').textContent = env.storm > 0 ? '沙暴' : '沙暴将至';

  $('place').textContent = `${tile.gateFound ? '地下世界入口' : tile.shaft ? `${TERRAIN[tile.type].name} · 竖井` : TERRAIN[tile.type].name}${tile.shelter ? ' · 遮阴沟' : tile.shade > 0 ? ' · 有阴凉' : ''}`;
}

// —— 第二幕的画面：城市剖面。上面一条是此刻真实的地表，下面是岩层里的各个区域 ——
const CITY_LAYOUT = {
  gate: [0.5, 0], hall: [0.22, 1], school: [0.78, 1], market: [0.5, 2], homes: [0.3, 3.2],
  archive: [0.13, 4.4], farms: [0.62, 4.4], water: [0.82, 5.6], heat: [0.82, 7.4],
};
const CITY_EDGES = [['gate', 'market'], ['market', 'hall'], ['market', 'school'], ['market', 'homes'], ['market', 'farms'], ['homes', 'archive'], ['homes', 'farms'], ['farms', 'water'], ['water', 'heat']];
function drawCity() {
  const { ctx, w, h } = fitCanvas($('scene'));
  const surf = climate(state.t, state.climate);
  const el = (surf.sunElev * 180) / Math.PI;
  const light = Math.min(1, Math.max(0, (el + 6) / 18));
  const ys = h * 0.13;
  // 地表
  const sky = ctx.createLinearGradient(0, 0, 0, ys);
  sky.addColorStop(0, rgb(mix([8, 10, 32], [52, 132, 214], light)));
  sky.addColorStop(1, rgb(mix([26, 26, 58], [206, 228, 244], light)));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, ys);
  if (surf.storm > 0) {
    ctx.fillStyle = rgb([196, 150, 84], 0.8 * surf.storm);
    ctx.fillRect(0, 0, w, ys);
  }
  if (el > 0) {
    ctx.fillStyle = '#fff6dc';
    ctx.beginPath();
    ctx.arc(w * (0.08 + (0.84 * (surf.hour - 5.3)) / 13.4), ys - Math.sin(surf.sunElev) * ys * 0.8, 5, 0, 7);
    ctx.fill();
  }
  // 岩层
  const rock = ctx.createLinearGradient(0, ys, 0, h);
  rock.addColorStop(0, '#4a3f3a');
  rock.addColorStop(0.5, '#2c2630');
  rock.addColorStop(1, '#3a1f1c'); // 越深越热
  ctx.fillStyle = rock;
  ctx.fillRect(0, ys, w, h - ys);
  ctx.fillStyle = rgb(mix([52, 48, 74], [231, 201, 143], light));
  ctx.fillRect(0, ys - 3, w, 6);

  const rowH = (h - ys - 20) / 8.4;
  const cw = Math.min(104, w * 0.2);
  const ch = Math.min(26, rowH * 0.92);
  const pos = (id) => [CITY_LAYOUT[id][0] * w, ys + 16 + CITY_LAYOUT[id][1] * rowH + ch / 2];

  // 竖井、溢流渠、通道
  ctx.strokeStyle = 'rgba(210,214,220,0.35)';
  ctx.lineWidth = 2;
  const [gx, gy] = pos('gate');
  ctx.beginPath();
  ctx.moveTo(gx, ys);
  ctx.lineTo(gx, gy);
  ctx.stroke();
  const [wx, wy] = pos('water');
  ctx.strokeStyle = 'rgba(120,190,230,0.6)';
  ctx.beginPath();
  ctx.moveTo(wx + cw / 2, wy);
  ctx.lineTo(w - 10, wy);
  ctx.lineTo(w - 10, ys);
  ctx.stroke();
  ctx.fillStyle = '#2f8f6a';
  ctx.fillRect(w - 16, ys - 7, 12, 5); // 绿洲
  ctx.strokeStyle = 'rgba(235,228,214,0.3)';
  ctx.lineWidth = 3;
  for (const [a, b] of CITY_EDGES) {
    const [x1, y1] = pos(a);
    const [x2, y2] = pos(b);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  // 各区
  const on = lightsOn(state.t);
  const sys = systems(state);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(10, Math.min(13, ch * 0.5))}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`;
  for (const [id, d] of Object.entries(DISTRICTS)) {
    const [x, y] = pos(id);
    const glow = id === 'farms' ? 0.25 + 0.75 * sys.lit : id === 'heat' || id === 'gate' ? 0.85 : on ? 1 : 0.35;
    ctx.fillStyle = rgb(mix([40, 36, 48], d.hue, glow));
    ctx.beginPath();
    ctx.roundRect(x - cw / 2, y - ch / 2, cw, ch, 5);
    ctx.fill();
    if (id === state.c2.loc) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = glow > 0.6 ? '#1c1822' : '#e8e0d0';
    ctx.fillText(d.name, x, y + 1);
  }
  const [px, py] = pos(state.c2.loc);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#b3261e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(px - cw / 2, py - ch / 2, 5, 0, 7);
  ctx.fill();
  ctx.stroke();

  const d = DISTRICTS[state.c2.loc];
  $('storm').hidden = true;
  $('place').textContent = `${d.name} · 地下 ${d.depth} m · 剖面示意，不按比例`;
}

function renderCity() {
  const c = state.c2;
  const d = DISTRICTS[c.loc];
  const list = actions(state);
  const btn = (a) => `<button type="button" data-act="${a.id}" ${a.enabled ? '' : 'disabled'}>${a.label}<small>${a.enabled ? a.desc : a.why}</small></button>`;
  $('locName').textContent = `${d.name} · 地下 ${d.depth} m`;
  $('locDesc').textContent = d.desc;
  const people = list.filter((a) => a.group === 'talk');
  $('people').innerHTML = people.length ? people.map(btn).join('') : `<span class="none">${lightsOn(state.t) ? '这会儿没有认识的人在。' : '夜里，人都回家睡了。'}</span>`;
  $('goes').innerHTML = list.filter((a) => a.group === 'go').map(btn).join('');
  $('acts').innerHTML = list.filter((a) => a.group === 'here').map(btn).join('');

  const s = systems(state);
  const rows = [
    ['今天', EVENTS[s.event].name],
    ['地热发电 / 用电', `${s.supplyMW.toFixed(0)} / ${s.demandMW.toFixed(0)} MW`],
    ['光田亮灯', s.lit > 0 ? `${Math.round(s.lit * 100)} % · ${s.farmMW.toFixed(0)} MW` : '熄灯（夜间）'],
    ['产粮 / 吃粮', `${(s.growKcalH / 1e6).toFixed(2)} / ${(s.eatKcalH / 1e6).toFixed(2)} 百万 kcal/h`],
    ['存粮', `${state.city.foodDays.toFixed(1)} 天`],
    ['蓄水库', `${Math.round(state.city.reservoirM3).toLocaleString('en-US')} m³ · 回收 ${Math.round(s.recycle * 100)} %`],
    ['溢流到地表', `${s.overflowLs.toFixed(1)} L/s`],
    ['产氧 / 耗氧', `${Math.round(s.o2MakeKgH)} / ${Math.round(s.o2UseKgH)} kg/h`],
    ['中庭 CO₂', `${s.co2ppm} ppm`],
    ['需排出的热', `${s.heatMW.toFixed(0)} MW`],
    ['人口', CITY.pop.toLocaleString('en-US')],
  ];
  $('sys').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// —— 地图 ——
const TILE_COLOR = { flat: '#d9c08a', dune: '#e9a85a', rock: '#7d6a5d', wadi: '#9aa37a', oasis: '#2f8f6a' };
const VIEW_W = 15;
const VIEW_H = 11;
function drawMap() {
  const cv = $('map');
  const { ctx, w, h } = fitCanvas(cv);
  const c = w / VIEW_W;
  const ox = state.pos.x - (VIEW_W - 1) / 2;
  const oy = state.pos.y - (VIEW_H - 1) / 2;
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--fog').trim() || '#bbb';
  ctx.fillRect(0, 0, w, h);
  for (let j = 0; j < VIEW_H; j++) {
    for (let i = 0; i < VIEW_W; i++) {
      const t = tileAt(state.world, ox + i, oy + j);
      const x = i * c;
      const y = j * c;
      if (!t) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x, y, c + 0.5, c + 0.5);
        continue;
      }
      if (!t.seen) continue;
      ctx.fillStyle = TILE_COLOR[t.type];
      ctx.fillRect(x, y, c + 0.5, c + 0.5);
      if (t.shade > 0 && t.type === 'wadi') {
        ctx.fillStyle = '#4f6b3c';
        ctx.beginPath();
        ctx.arc(x + c * 0.3, y + c * 0.3, c * 0.16, 0, 7);
        ctx.fill();
      }
      if (t.plants > 0) {
        ctx.fillStyle = '#5f8f4e';
        ctx.fillRect(x + c * 0.62, y + c * 0.6, c * 0.12, c * 0.26);
      }
      if (t.well || (t.poolFound && t.pool > 0.01)) {
        ctx.fillStyle = '#1f6f9c';
        ctx.beginPath();
        ctx.arc(x + c / 2, y + c / 2, c * 0.2, 0, 7);
        ctx.fill();
      }
      if (t.shaft) {
        ctx.strokeStyle = '#26222e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x + c / 2, y + c / 2, c * 0.14, 0, 7);
        ctx.stroke();
      }
      if (t.gateFound || t.gateSpotted) {
        ctx.fillStyle = '#17141f';
        ctx.fillRect(x + c * 0.36, y + c * 0.3, c * 0.28, c * 0.42);
      }
      if (t.shelter) {
        ctx.strokeStyle = '#26222e';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 3, y + 3, c - 6, c - 6);
      }
    }
  }
  if (envNow(state).storm > 0.5) {
    ctx.fillStyle = 'rgba(176,138,84,0.93)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#26222e';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('沙暴中，辨不清方向', w / 2, h / 2 - c);
  }
  // 你
  const px = ((VIEW_W - 1) / 2) * c + c / 2;
  const py = ((VIEW_H - 1) / 2) * c + c / 2;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#b3261e';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(px, py, c * 0.24, 0, 7);
  ctx.fill();
  ctx.stroke();
}

// —— 仪表 ——
function meter(label, frac, value, note, level, ticks = []) {
  const cls = level >= 2 ? 'bad' : level === 1 ? 'warn' : '';
  return `<div class="meter"><span>${label}</span><div class="bar"><i class="${cls}" style="width:${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%"></i>${ticks
    .map((t) => `<b class="tick" style="left:${t * 100}%"></b>`)
    .join('')}</div><span class="num">${value}</span><span class="note ${cls}">${note}</span></div>`;
}
function renderMeters() {
  const b = state.body;
  const lv = state.levels;
  const p = dehydrationPct(b);
  const T = b.coreT;
  const tLevel = Math.max(lv.heat >= 2 ? 2 : lv.heat, lv.cold >= 2 ? 2 : lv.cold);
  const tNote = lv.heat >= 3 ? '中暑虚脱' : lv.heat === 2 ? '热衰竭' : lv.heat === 1 ? '偏高' : lv.cold >= 2 ? '失温' : lv.cold === 1 ? '偏低，在发抖' : '正常';
  const dNote = ['水分充足', '口渴', '头痛，行动变慢', '头晕，出汗能力锐减', '无法行走'][lv.dehyd];
  $('meters').innerHTML =
    meter('核心体温', (T - 33) / 9, `${T.toFixed(1)} °C`, `${tNote} · 33–42°C 刻度，42°C 致命`, tLevel, [4 / 9]) +
    meter('失水', p / 15, `${p.toFixed(1)} %`, `${dNote} · 亏缺 ${Math.max(0, b.waterDeficit).toFixed(1)} L，15% 致命`, lv.dehyd >= 3 ? 2 : lv.dehyd >= 2 ? 1 : 0, [2 / 15, 5 / 15, 8 / 15, 11 / 15]) +
    meter('疲劳', b.fatigue / 100, `${Math.round(b.fatigue)}`, lv.tired >= 2 ? '体力耗尽' : lv.tired === 1 ? '很累，走得慢' : '还撑得住', lv.tired) +
    meter('水囊', state.inv.water / BOTTLE_L, `${state.inv.water.toFixed(2)} L`, `容量 ${BOTTLE_L} L${state.inv.sheet ? ' · 带着塑料布' : ''}`, 0) +
    meter('能量', b.glycogenKcal / 2000, `${Math.round(b.glycogenKcal)} kcal`, `糖原 · 另有脂肪 ${b.fatKg.toFixed(1)} kg · 体重 ${currentMass(b).toFixed(1)} kg`, b.glycogenKcal < 200 ? 1 : 0) +
    ailments(state)
      .map((a) => `<p class="ail">${a}</p>`)
      .join('') +
    (state.act === 2 ? cityStatus() : '');
}

function cityStatus() {
  const c = state.c2;
  const r = residency(state);
  const mark = (ok, text) => `<span class="${ok ? 'yes' : 'no'}">${ok ? '✓' : '○'} ${text}</span>`;
  const goal = c.resident
    ? `<b>${CITY.name}居民</b> · 当前版本的故事到这里，城里的日子可以继续过。`
    : !c.examined
      ? '<b>临时身份</b> · 先在闸口接受检疫。'
      : `<b>落户</b>（在议事厅办理）<br>${mark(r.shiftsOk, `干满三个工（${Math.min(3, r.shifts)}/3）`)}　${mark(!!r.sponsor, r.sponsor ? `保人：${r.sponsor}` : '一位居民愿意作保（多和人来往）')}`;
  return `<div class="meter"><span>度</span><div></div><span class="num">${c.credits} 度</span><span class="note">这里的钱，1 度 = 1 kWh 的配额</span></div><p class="goal">${goal}</p>`;
}

function renderEnv() {
  if (state.act === 2) {
    const e = envNow(state);
    const d = DISTRICTS[state.c2.loc];
    const rows = [
      ['气温', `${e.airT.toFixed(1)} °C`],
      ['相对湿度', `${e.rh.toFixed(0)} %`],
      ['风速', `${e.wind.toFixed(1)} m/s`],
      ['深度', `${d.depth} m`],
      ['照明', lightsOn(state.t) ? '大灯（昼）' : '廊灯（夜）'],
    ];
    $('env').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    return;
  }
  const e = envNow(state);
  const rows = [
    ['气温', `${e.airT.toFixed(1)} °C`],
    ['沙面温度', `${e.groundT.toFixed(0)} °C`],
    ['日照', `${Math.round(e.ghi)} W/m²`],
    ['太阳高度', `${((e.sunElev * 180) / Math.PI).toFixed(0)}°`],
    ['风速', `${e.wind.toFixed(1)} m/s`],
    ['相对湿度', `${e.rh.toFixed(0)} %`],
    ['能见度', e.storm > 0.5 ? '不足 5 m' : e.storm > 0 ? '约 200 m' : e.isDay ? '良好' : '夜间，约 1 km'],
  ];
  $('env').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderFlux() {
  const f = state.flux;
  if (!f) return;
  const rows = [
    ['代谢产热', f.metabolic],
    ['日照', f.solar],
    ['对流与辐射', f.dry],
    ['出汗蒸发', -f.evap],
    ['净储热', f.storage],
  ];
  const scale = Math.max(300, ...rows.map((r) => Math.abs(r[1])));
  $('fluxTitle').textContent = '热平衡（此地静坐时）';
  if (state.over) return;
  $('flux').innerHTML =
    rows
      .map(([k, v]) => {
        const pct = (Math.abs(v) / scale) * 50;
        const style = v >= 0 ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%`;
        return `<span>${k}</span><div class="track"><i class="${v < 0 ? 'neg' : ''}" style="${style}"></i></div><span class="num">${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))} W</span>`;
      })
      .join('') + `<span>失水速率</span><span></span><span class="num">${f.waterLossLh.toFixed(2)} L/h</span>`.replace(' L/h', '&nbsp;L/h');
}

const DIRS = [
  { key: 'n', label: '北', dx: 0, dy: -1 },
  { key: 'w', label: '西', dx: -1, dy: 0 },
  { key: 'e', label: '东', dx: 1, dy: 0 },
  { key: 's', label: '南', dx: 0, dy: 1 },
];
function renderMoves() {
  $('moves').innerHTML = DIRS.map((d) => {
    const c = moveCost(state, d.dx, d.dy);
    const dis = !c || state.over ? 'disabled' : '';
    const blind = envNow(state).storm > 0.5;
    const sub = c ? `${blind ? '看不见' : c.dest.seen ? TERRAIN[c.dest.type].name : '未知'} · ${blind ? '可能走偏' : `${c.minutes} 分钟 · 失水 ${c.waterL.toFixed(2)} L`}` : '地图边缘';
    return `<button type="button" id="mv-${d.key}" data-dx="${d.dx}" data-dy="${d.dy}" ${dis}>向${d.label}走 1 km<small>${sub}</small></button>`;
  }).join('');
}
function renderActions() {
  $('acts').innerHTML = actions(state)
    .map((a) => `<button type="button" id="act-${a.id}" data-act="${a.id}" ${a.enabled ? '' : 'disabled'}>${a.label}<small>${a.enabled ? a.desc : a.why}</small></button>`)
    .join('');
}
function fmtT(t) {
  const d = Math.floor(t / 1440) + 1;
  const m = t % 1440;
  return `${d}日 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function renderLog() {
  $('log').innerHTML = state.log
    .slice(-60)
    .reverse()
    .map((l) => `<li><time>${fmtT(l.t)}</time><span class="${l.kind}">${esc(l.text)}</span></li>`)
    .join('');
}
function renderEnd() {
  const el = $('end');
  if (!state.over) {
    el.hidden = true;
    return;
  }
  const c = clock(state);
  const b = state.body;
  el.hidden = false;
  el.innerHTML = `<h2>${state.over.win ? '你走进了地下世界' : `${esc(state.name)}没能走出沙漠`}</h2>
    <p>${state.over.win ? '第一幕结束。地表留在了头顶上。下面是什么人建的、为什么还在运转、为什么没人回来过——答案都在更深的地方。' : esc(state.over.cause) + '。'}</p>
    <dl class="readout" style="max-width:24em">
      <dt>存活时间</dt><dd>${c.survivedH.toFixed(1)} 小时</dd>
      <dt>步行距离</dt><dd>${state.stats.km} km</dd>
      <dt>喝下的水</dt><dd>${state.stats.drunk.toFixed(1)} L</dd>
      <dt>最高核心体温</dt><dd>${b.maxCoreT.toFixed(1)} °C</dd>
      <dt>最严重失水</dt><dd>${b.maxDehydration.toFixed(1)} %</dd>
      <dt>沙漠编号</dt><dd>${state.seed}</dd>
    </dl>
    <div class="row"><button class="primary" type="button" id="again">再走一次这片沙漠</button><button type="button" id="fresh">换一片沙漠</button></div>`;
}

function render() {
  const playing = !!state;
  $('setup').hidden = playing;
  $('play').hidden = !playing;
  $('clock').hidden = !playing;
  if (!playing) {
    $('end').hidden = true;
    return renderDerived();
  }
  const c = clock(state);
  $('day').textContent = c.day;
  $('time').textContent = c.text;
  const city = state.act === 2;
  $('scene').classList.toggle('city', city);
  $('scene3d').hidden = city || !view3d;
  $('scene').hidden = !city && !!view3d;
  $('surfaceMap').hidden = city;
  $('cityPanel').hidden = !city;
  $('sysBox').hidden = !city;
  $('actLabel').textContent = city ? `公元 2226 · 第二幕 · ${CITY.name}` : '公元 2226 · 第一幕 · 地表';
  if (city) {
    drawCity();
    renderCity();
  } else {
    drawScene();
    if (view3d) {
      view3d.sync(state, envNow(state));
      $('place').textContent += ` · 面朝${view3d.facing()} · 拖动画面环顾四周`;
    }
    drawMap();
    renderMoves();
    renderActions();
  }
  $('advice').innerHTML = advice(state).map((a) => `<li>${a}</li>`).join('');
  renderMeters();
  renderEnv();
  renderFlux();
  renderLog();
  renderEnd();
}

function act(id, arg) {
  if (!state || state.over) return;
  perform(state, id, arg);
  save();
  render();
}

function start(cfg) {
  state = newGame(cfg);
  state.cfg = cfg;
  save();
  render();
  window.scrollTo(0, 0);
}

// —— 事件 ——
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  start(formCfg());
});
$('form').addEventListener('input', renderDerived);
$('acts').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (b && !b.disabled) act(b.dataset.act);
});
$('cityPanel').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (b && !b.disabled) act(b.dataset.act);
});
$('moves').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dx]');
  if (b && !b.disabled) act('move', { dx: Number(b.dataset.dx), dy: Number(b.dataset.dy) });
});
$('map').addEventListener('click', (e) => {
  if (!state || state.act === 2) return;
  const r = $('map').getBoundingClientRect();
  const c = r.width / VIEW_W;
  const dx = Math.floor((e.clientX - r.left) / c) - (VIEW_W - 1) / 2;
  const dy = Math.floor((e.clientY - r.top) / c) - (VIEW_H - 1) / 2;
  if (Math.abs(dx) + Math.abs(dy) === 1) act('move', { dx, dy });
});
document.addEventListener('keydown', (e) => {
  if (!state || state.over || state.act === 2 || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const k = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] }[e.key];
  if (k) {
    e.preventDefault();
    act('move', { dx: k[0], dy: k[1] });
  }
});
$('quit').addEventListener('click', () => {
  state = null;
  save();
  render();
});
$('end').addEventListener('click', (e) => {
  if (e.target.id === 'again') start({ ...state.cfg, seed: state.seed });
  if (e.target.id === 'fresh') start({ ...state.cfg, seed: undefined });
});
window.addEventListener('resize', () => state && (state.act === 2 ? drawCity() : (drawScene(), drawMap())));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state && state.act !== 2 && drawMap());

state = load();
if (state && !state.over) refreshFlux(state);
render();
