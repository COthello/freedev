// 第一幕的 3D 视角：用 three.js 实时渲染主人公眼中的沙漠。
// 只负责“看”：地形、天空、光照都从游戏状态和物理模型读出来，不改任何状态。
// 依赖全局 THREE（由页面从 CDN 载入）；没有 WebGL 时 create() 返回 null，界面退回 2D 画面。

const T = 60; // 一格（游戏里的 1 km）在画面里压缩成 60 m，否则走一格什么都不变
const EYE = { stand: 1.7, walk: 1.7, work: 1.3, sit: 0.9, sleep: 0.35 };
const ELEV = { flat: 0, dune: 3, rock: 2, wadi: -2.5, oasis: -3 };
const COLOR = {
  flat: [0.8, 0.68, 0.47],
  dune: [0.9, 0.71, 0.42],
  rock: [0.47, 0.4, 0.35],
  wadi: [0.68, 0.64, 0.47],
  oasis: [0.4, 0.52, 0.3],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function hash(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, s) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = lerp(hash(x0, y0, s), hash(x0 + 1, y0, s), sx);
  const b = lerp(hash(x0, y0 + 1, s), hash(x0 + 1, y0 + 1, s), sx);
  return lerp(a, b, sy);
}

/** 由世界的格子生成连续的地形函数 */
function makeTerrain(world) {
  const n = world.size;
  const at = (x, y) => world.tiles[clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1)];
  // 在格子中心之间做平滑插值
  const sample = (u, v, f) => {
    const fx = u - 0.5;
    const fy = v - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const out = [];
    const a = f(at(x0, y0));
    const b = f(at(x0 + 1, y0));
    const c = f(at(x0, y0 + 1));
    const d = f(at(x0 + 1, y0 + 1));
    for (let i = 0; i < a.length; i++) out.push(lerp(lerp(a[i], b[i], sx), lerp(c[i], d[i], sx), sy));
    return out;
  };
  const props = (t) => [ELEV[t.type], t.type === 'dune' ? 1 : 0, t.type === 'rock' ? 1 : 0, ...COLOR[t.type]];
  const s = world.seed % 100000;
  const info = (x, z) => {
    const u = x / T;
    const v = z / T;
    const [base, dune, rock, r, g, b] = sample(u, v, props);
    const n1 = noise(u * 1.3, v * 1.3, s);
    const n2 = noise(u * 3.1, v * 3.1, s + 5);
    const h =
      base +
      dune * (10 * Math.pow(n1, 1.5) + 2.5 * n2) + // 沙丘的大起伏
      rock * (1.5 + 4 * Math.abs(noise(u * 5, v * 5, s + 9) - 0.5)) + // 岩石的碎台地
      0.25 * noise(u * 14, v * 14, s + 3); // 沙纹
    const shade = 0.9 + 0.2 * noise(u * 9, v * 9, s + 17);
    return { h, color: [r * shade, g * shade, b * shade] };
  };
  return { height: (x, z) => info(x, z).h, info };
}

export function create(canvas) {
  const THREE = globalThis.THREE;
  if (!THREE) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 10, 400);
  const camera = new THREE.PerspectiveCamera(62, 2, 0.1, 2500);
  camera.rotation.order = 'YXZ';

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x886644, 0.6);
  scene.add(sun, sun.target, hemi);

  // 天穹：随相机移动的大球，顶点颜色从地平线过渡到天顶
  const skyGeo = new THREE.SphereGeometry(1200, 24, 12);
  skyGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 3), 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(26, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff4d6, fog: false }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(70, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff0c8, fog: false, transparent: true, opacity: 0.18, depthWrite: false }));
  const starPos = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) {
    const a = hash(i, 1, 7) * Math.PI * 2;
    const e = Math.asin(0.04 + 0.96 * hash(i, 2, 7));
    starPos.set([Math.cos(a) * Math.cos(e) * 1100, Math.sin(e) * 1100, Math.sin(a) * Math.cos(e) * 1100], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, depthWrite: false }));
  const skyGroup = new THREE.Group();
  skyGroup.add(sky, stars, halo, sunDisc);
  scene.add(skyGroup);

  // 沙暴里横飞的沙粒
  const dustPos = new Float32Array(700 * 3);
  for (let i = 0; i < 700; i++) dustPos.set([(hash(i, 3, 9) - 0.5) * 60, hash(i, 4, 9) * 8, (hash(i, 5, 9) - 0.5) * 60], i * 3);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xe8cf9a, size: 0.12, transparent: true, opacity: 0 }));
  scene.add(dust);

  const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
  const M = {
    rock: mat(0x7a675a, { flatShading: true }),
    cliff: mat(0x6e5c50, { flatShading: true }),
    trunk: mat(0x6a5038),
    acacia: mat(0x6f7f48, { flatShading: true }),
    palm: mat(0x3f7a4a, { flatShading: true }),
    plant: mat(0x6f9a5c, { flatShading: true }),
    water: new THREE.MeshPhongMaterial({ color: 0x3f86a8, shininess: 90, transparent: true, opacity: 0.88 }),
    concrete: mat(0x9a948a, { flatShading: true }),
    dark: new THREE.MeshBasicMaterial({ color: 0x0c0a12 }),
    metal: mat(0x59606a),
    sand: mat(0xd9b676),
    sheet: new THREE.MeshPhongMaterial({ color: 0xcfe6f2, transparent: true, opacity: 0.55, shininess: 120 }),
    cloth: mat(0xe8e0d0, { side: THREE.DoubleSide }),
  };
  const G = {
    rock: new THREE.DodecahedronGeometry(1, 0),
    box: new THREE.BoxGeometry(1, 1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
    tube: new THREE.CylinderGeometry(1, 1, 1, 18, 1, true),
    ball: new THREE.SphereGeometry(1, 10, 7),
    cone: new THREE.ConeGeometry(1, 1, 5),
    disc: new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2),
  };

  let terrain = null;
  let staticGroup = null;
  const dynamic = new THREE.Group();
  scene.add(dynamic);
  let seedBuilt = null;

  const mesh = (g, m, x, y, z, sx = 1, sy = sx, sz = sx) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.scale.set(sx, sy, sz);
    return o;
  };
  const center = (t) => [(t.x + 0.5) * T, (t.y + 0.5) * T];

  function build(world) {
    if (staticGroup) {
      scene.remove(staticGroup);
      staticGroup.traverse((o) => o.isMesh && !Object.values(G).includes(o.geometry) && o.geometry.dispose());
    }
    staticGroup = new THREE.Group();
    scene.add(staticGroup);
    terrain = makeTerrain(world);
    const size = world.size * T;
    const seg = world.size * 5;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    geo.translate(size / 2, 0, size / 2);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const q = terrain.info(pos.getX(i), pos.getZ(i));
      pos.setY(i, q.h);
      col.set(q.color, i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    staticGroup.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // 岩石：每格几块大石，用实例化一次画完
    const rocks = world.tiles.filter((t) => t.type === 'rock' && !t.gate);
    const inst = new THREE.InstancedMesh(G.rock, M.rock, rocks.length * 4);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    rocks.forEach((t, k) => {
      const [cx, cz] = center(t);
      for (let j = 0; j < 4; j++) {
        const a = hash(t.x, t.y, j) * Math.PI * 2;
        const d = (j === 0 ? 24 : 10) + hash(t.x, t.y, j + 10) * (j === 0 ? 5 : 16); // 大石离格子中心远一点，别把人埋进去
        const x = cx + Math.cos(a) * d;
        const z = cz + Math.sin(a) * d;
        const s = j === 0 ? 7 + hash(t.x, t.y, 20) * 5 : 1.2 + hash(t.x, t.y, j + 30) * 2.4;
        e.set(hash(t.x, t.y, j + 40) * 3, hash(t.x, t.y, j + 50) * 6, 0);
        m4.compose(new THREE.Vector3(x, terrain.height(x, z) + s * 0.25, z), q.setFromEuler(e), new THREE.Vector3(s * 1.3, s * 0.75, s));
        inst.setMatrixAt(k * 4 + j, m4);
      }
    });
    staticGroup.add(inst);

    for (const t of world.tiles) {
      const [cx, cz] = center(t);
      const y = terrain.height(cx, cz);
      if (t.type === 'wadi' && t.shade > 0) {
        // 金合欢：细干、扁平的伞形树冠
        const x = cx + 6;
        const z = cz - 5;
        const gy = terrain.height(x, z);
        staticGroup.add(mesh(G.cyl, M.trunk, x, gy + 2, z, 0.28, 4, 0.28), mesh(G.ball, M.acacia, x, gy + 4.6, z, 4.2, 0.9, 4.2), mesh(G.ball, M.acacia, x + 1.6, gy + 5.1, z + 0.8, 2.4, 0.6, 2.4));
      }
      if (t.type === 'oasis') {
        staticGroup.add(mesh(G.disc, M.water, cx, y + 0.5, cz + 4, 15, 1, 11));
        for (let j = 0; j < 9; j++) {
          const a = (j / 9) * Math.PI * 2 + 0.3;
          const d = 14 + hash(j, 3, 2) * 9;
          const x = cx + Math.cos(a) * d * 1.2;
          const z = cz + 4 + Math.sin(a) * d;
          const gy = terrain.height(x, z);
          const hgt = 6 + hash(j, 5, 2) * 4;
          staticGroup.add(mesh(G.cyl, M.trunk, x, gy + hgt / 2, z, 0.32, hgt, 0.32));
          for (let k = 0; k < 7; k++) {
            const f = mesh(G.cone, M.palm, x, gy + hgt, z, 0.55, 4.2, 0.2);
            f.rotation.set(0, (k / 7) * Math.PI * 2, 1.9);
            f.translateY(2);
            staticGroup.add(f);
          }
        }
        // 往外淌水的涵管口
        const p = mesh(G.tube, M.concrete, cx - 13, y + 1.6, cz + 2, 1.5, 5, 1.5);
        p.rotation.z = Math.PI / 2;
        staticGroup.add(p, mesh(G.ball, M.dark, cx - 11, y + 1.6, cz + 2, 1.3, 1.3, 0.2));
      }
      if (t.shaft) {
        const x = cx + 5;
        const z = cz - 6;
        const gy = terrain.height(x, z);
        staticGroup.add(mesh(G.tube, M.concrete, x, gy + 0.6, z, 2.6, 1.6, 2.6), mesh(G.disc, M.dark, x, gy + 1.35, z, 2.5), mesh(G.ball, M.sand, x, gy - 0.6, z, 7, 1.4, 7));
      }
      if (t.gate) {
        // 入口所在的岩壁：一整面断崖
        const wall = mesh(G.box, M.cliff, cx, y + 6, cz - 13, 40, 18, 11);
        wall.rotation.y = 0.04;
        staticGroup.add(wall, mesh(G.rock, M.cliff, cx - 18, y + 5, cz - 12, 12, 9, 8), mesh(G.rock, M.cliff, cx + 19, y + 4, cz - 13, 11, 8, 8));
      }
    }
  }

  /** 会随游戏变化的小物件：遮阴沟、蒸馏器、水坑、植物、闸门 */
  function buildDynamic(state) {
    dynamic.clear();
    for (const t of state.world.tiles) {
      if (!(t.shelter || t.still || t.well || t.plants > 0 || t.gate || (t.poolFound && t.pool > 0.01))) continue;
      const [cx, cz] = center(t);
      const y = terrain.height(cx, cz);
      if (t.shelter) {
        dynamic.add(mesh(G.box, M.dark, cx + 2.2, y + 0.02, cz + 1.5, 0.9, 0.5, 2.3));
        const cover = mesh(G.box, M.cloth, cx + 2.2, y + 0.42, cz + 1.2, 1.5, 0.03, 1.6);
        cover.rotation.z = 0.12;
        dynamic.add(cover);
      }
      if (t.still) dynamic.add(mesh(G.disc, M.sheet, cx - 2.5, y + 0.12, cz + 2, 1.1), mesh(G.rock, M.rock, cx - 2.5, y + 0.1, cz + 2, 0.12));
      if (t.well) dynamic.add(mesh(G.disc, M.dark, cx - 1.5, y + 0.06, cz - 3, 0.9), mesh(G.disc, M.water, cx - 1.5, y + 0.08, cz - 3, 0.45));
      if (t.poolFound && t.pool > 0.01) dynamic.add(mesh(G.disc, M.water, cx + 3, y + 0.3, cz - 4, 1.2, 1, 0.8));
      if (t.type !== 'oasis') {
        for (let j = 0; j < t.plants; j++) {
          const x = cx - 4 + j * 1.4;
          const z = cz - 3 - (j % 2) * 1.2;
          dynamic.add(mesh(G.cone, M.plant, x, terrain.height(x, z) + 0.35, z, 0.3, 0.8, 0.3));
        }
      }
      if (t.gate && (t.gateFound || t.gateSpotted)) {
        const z = cz - 7.3;
        dynamic.add(mesh(G.box, M.concrete, cx, y + 2.4, z - 0.1, 4.2, 5.4, 0.5), mesh(G.box, t.gateFound ? M.metal : M.dark, cx, y + 2.2, z + 0.2, 3.2, 4.8, 0.2));
        if (t.gateFound) dynamic.add(mesh(G.tube, M.dark, cx, y + 2.3, z + 0.34, 0.5, 0.08, 0.5).rotateX(Math.PI / 2));
        const heap = 1 - 0.9 * t.gateDug;
        if (heap > 0.05) dynamic.add(mesh(G.ball, M.sand, cx, y - 0.1, z + 0.9, 3.4, 3.4 * heap, 1.5));
      }
    }
  }

  // —— 相机 ——
  const cam = { x: 0, z: 0, tx: 0, tz: 0, eye: 1.7, teye: 1.7, yaw: -Math.PI / 2, tyaw: -Math.PI / 2, pitch: -0.02, tpitch: -0.02 };
  let last = null; // 上一次同步时的位置
  let storm = 0;
  let wind = 3;
  let needs = true;
  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function sync(state, env) {
    if (seedBuilt !== state.seed) {
      build(state.world);
      seedBuilt = state.seed;
      last = null;
    }
    buildDynamic(state);
    const tile = state.world.tiles[state.pos.y * state.world.size + state.pos.x];
    cam.tx = (state.pos.x + 0.5) * T;
    cam.tz = (state.pos.y + 0.5) * T;
    cam.teye = EYE[state.posture] ?? 1.7;
    if (last && (last.x !== state.pos.x || last.y !== state.pos.y)) {
      // 面朝刚走的方向
      const want = Math.atan2(-(state.pos.x - last.x), -(state.pos.y - last.y));
      cam.tyaw = cam.yaw + Math.atan2(Math.sin(want - cam.yaw), Math.cos(want - cam.yaw));
      cam.tpitch = -0.02;
    } else if (!last) {
      cam.x = cam.tx;
      cam.z = cam.tz;
      cam.yaw = cam.tyaw = -Math.PI / 2; // 醒来时面朝东方，看日出
    }
    if (tile.gate && (tile.gateFound || tile.gateSpotted)) cam.tyaw = cam.yaw + Math.atan2(Math.sin(-cam.yaw), Math.cos(-cam.yaw)); // 面向岩壁
    if (state.posture === 'sleep') cam.tpitch = 0.9; // 躺着看天
    else if (cam.tpitch > 0.5) cam.tpitch = -0.02;
    last = { ...state.pos };
    if (still) Object.assign(cam, { x: cam.tx, z: cam.tz, eye: cam.teye, yaw: cam.tyaw, pitch: cam.tpitch });

    // —— 光照与天空，全部来自物理模型的环境量 ——
    const el = env.sunElev;
    const elDeg = (el * 180) / Math.PI;
    const light = clamp((elDeg + 6) / 18, 0, 1);
    const low = clamp(1 - Math.abs(elDeg) / 14, 0, 1);
    storm = env.storm;
    wind = env.wind;
    let zenith = mix3([0.02, 0.03, 0.1], [0.2, 0.47, 0.84], light);
    let horizon = mix3([0.07, 0.08, 0.18], [0.78, 0.87, 0.95], light);
    horizon = mix3(horizon, [0.95, 0.52, 0.28], low * 0.8);
    zenith = mix3(zenith, [0.34, 0.33, 0.58], low * 0.4);
    const dustC = mix3([0.2, 0.15, 0.1], [0.76, 0.58, 0.33], light);
    horizon = mix3(horizon, dustC, storm);
    zenith = mix3(zenith, dustC, storm * 0.92);
    const sc = skyGeo.attributes.color;
    const sp = skyGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const k = Math.pow(clamp(sp.getY(i) / 1200, 0, 1), 0.55);
      sc.setXYZ(i, lerp(horizon[0], zenith[0], k), lerp(horizon[1], zenith[1], k), lerp(horizon[2], zenith[2], k));
    }
    sc.needsUpdate = true;
    scene.fog.color.setRGB(...horizon);
    // 能见度：晴天白昼约 6 格，夜里约 2 格，沙暴里十几米
    const far = lerp(lerp(2.2 * T, 7 * T, light), 14, Math.pow(storm, 0.6));
    scene.fog.near = far * 0.12;
    scene.fog.far = far;

    const ha = ((env.hour - 12) * 15 * Math.PI) / 180;
    const dir = new THREE.Vector3(-Math.sin(ha) * Math.cos(el), Math.sin(el), 0.25 * Math.cos(el)).normalize();
    sunDisc.position.copy(dir).multiplyScalar(1050);
    halo.position.copy(sunDisc.position);
    sunDisc.visible = halo.visible = elDeg > -2 && storm < 0.6;
    const sunCol = mix3([1, 0.55, 0.3], [1, 0.97, 0.9], clamp(elDeg / 25, 0, 1));
    sunDisc.material.color.setRGB(...sunCol);
    sun.color.setRGB(...sunCol);
    sun.intensity = clamp(Math.sin(el) * 1.5 + 0.1, 0, 1.15) * (env.dni / 900 + 0.05);
    sun.position.copy(dir).multiplyScalar(100);
    hemi.intensity = lerp(0.42, 0.62, light) * (1 - 0.3 * storm); // 夜里留一点星月光，看得出沙丘的轮廓
    hemi.color.setRGB(...mix3([0.35, 0.42, 0.75], [1, 0.98, 0.93], light));
    hemi.groundColor.setRGB(...mix3([0.2, 0.2, 0.3], [0.72, 0.58, 0.4], light));
    stars.material.opacity = (1 - light) * (1 - storm);
    dust.material.opacity = 0.75 * storm;
    needs = true;
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      needs = true;
    }
  }

  let prev = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!terrain || canvas.hidden || !canvas.clientWidth) return;
    resize();
    const dt = Math.min(0.1, (now - prev) / 1000 || 0.016);
    prev = now;
    const k = 1 - Math.exp(-dt * 4.5);
    const moving = Math.abs(cam.tx - cam.x) + Math.abs(cam.tz - cam.z) + Math.abs(cam.tyaw - cam.yaw) + Math.abs(cam.tpitch - cam.pitch) + Math.abs(cam.teye - cam.eye) > 0.002;
    if (!moving && !needs && storm === 0) return; // 没有变化就不重画，省电
    cam.x = lerp(cam.x, cam.tx, k);
    cam.z = lerp(cam.z, cam.tz, k);
    cam.eye = lerp(cam.eye, cam.teye, k);
    cam.yaw = lerp(cam.yaw, cam.tyaw, k);
    cam.pitch = lerp(cam.pitch, cam.tpitch, k);
    camera.position.set(cam.x, terrain.height(cam.x, cam.z) + cam.eye, cam.z);
    camera.rotation.set(cam.pitch, cam.yaw, 0);
    skyGroup.position.copy(camera.position);
    if (storm > 0) {
      const p = dustGeo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i) + wind * dt * 2.2;
        if (x > 30) x -= 60;
        p.setX(i, x);
      }
      p.needsUpdate = true;
      dust.position.set(camera.position.x, camera.position.y - 2, camera.position.z);
    }
    renderer.render(scene, camera);
    needs = false;
  }
  requestAnimationFrame(frame);

  // —— 拖动环顾 ——
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    cam.tyaw += (e.clientX - drag.x) * 0.006;
    cam.tpitch = clamp(cam.tpitch + (e.clientY - drag.y) * 0.004, -0.7, 1.2);
    drag = { x: e.clientX, y: e.clientY };
  });
  const end = () => (drag = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  /** 此刻面朝的方位，供界面显示 */
  function facing() {
    const names = ['北', '西北', '西', '西南', '南', '东南', '东', '东北'];
    const a = ((cam.tyaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return names[Math.round(a / (Math.PI / 4)) % 8];
  }

  return { sync, facing };
}
