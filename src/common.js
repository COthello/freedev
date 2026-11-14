// 两幕共用的小工具：日志、身体警报等级、文字格式。
import { dehydrationPct } from './physics.js';

export const BOTTLE_L = 4;

export function say(state, text, kind = 'info') {
  state.log.push({ t: state.t, text, kind });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

export function computeLevels(body) {
  const p = dehydrationPct(body);
  const T = body.coreT;
  return {
    dehyd: p >= 11 ? 4 : p >= 8 ? 3 : p >= 5 ? 2 : p >= 2 ? 1 : 0,
    heat: T >= 40.5 ? 3 : T >= 39.2 ? 2 : T >= 38.3 ? 1 : 0,
    cold: T <= 33 ? 3 : T <= 35 ? 2 : T <= 36 ? 1 : 0,
    tired: body.fatigue >= 100 ? 2 : body.fatigue >= 75 ? 1 : 0,
    hungry: body.glycogenKcal < 300 ? 1 : 0,
  };
}

export function metMul(state) {
  return (state.effects.sting > state.t ? 1.2 : 1) * (state.effects.bite > state.t ? 1.15 : 1);
}

export const WARN = {
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
  hungry: [null, '饿得发慌，手脚发软。身体开始烧脂肪了。'],
};

export function fmtDur(min) {
  return min >= 60 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分钟`;
}
