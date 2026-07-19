'use strict';
/* ============================================================
 * 大狗Tap —— 仿 Mikutap：点击/拖动屏幕，狗叫会卡在节拍上
 * 背景音轨：Web Audio 实时合成的劲爆鼓组 + 洗脑和弦循环
 * 视觉（仿 Mikutap）：
 *   · 全屏几何特效，以屏幕正中心为原点铺满全屏
 *   · 新特效叠在旧特效之上，旧特效随即退场
 *   · 固定米白背景；限定调色板：主色黄 + 次色灰（极少点缀色）
 *   · 特效带常驻动效（旋转 / 漂浮 / 环绕 / 波动）并随节拍强烈脉动
 * ============================================================ */

/* ---------- 节奏常量 ---------- */
const BPM = 128;          // 激情劲爆的速度
const SPB = 60 / BPM;     // 每拍秒数
const S16 = SPB / 4;      // 16 分音符（调度步长）
const S8  = SPB / 2;      // 8 分音符（点击量化的最小节奏点）

/* ---------- 全局状态 ---------- */
let ctx = null;           // AudioContext
let master = null;        // 总线增益
let noiseBuf = null;      // 白噪声（鼓组用）
let started = false;

let startTime = 0;        // 第 0 步对应的 audio 时间
let nextNoteTime = 0;     // 调度器下一个音符时间
let stepCount = 0;        // 16 分步进计数（0..63 循环 = 4 小节）

const buffers = {};       // 解码后的狗叫样本

let cols = 4, rows = 3;   // 分区网格（纯逻辑分区，无可见格子）
let zones = [];           // 每个分区的音色配置

let mouthTimer = 0;       // 闭嘴定时器
let lastGlobalHit = -1;   // 全局最近一次发声的节奏点（保证没有两个音同时响）
const pointers = new Map();// 拖动中的指针 pointerId -> 上次触发的分区

/* ---------- DOM ---------- */
const stage     = document.getElementById('stage');
const fxCanvas  = document.getElementById('fx');
const flashEl   = document.getElementById('beatflash');
const dogEl     = document.getElementById('dog');
const dogInner  = document.getElementById('dog-inner');
const overlay   = document.getElementById('overlay');
const subEl     = overlay.querySelector('.sub');
const fx2d      = fxCanvas.getContext('2d');

/* ---------- 和弦走向：C - G - Am - F（简单洗脑） ---------- */
const CHORDS = [
  { bass: 65.41, notes: [261.63, 329.63, 392.00, 523.25] }, // C
  { bass: 49.00, notes: [196.00, 246.94, 293.66, 392.00] }, // G
  { bass: 55.00, notes: [220.00, 261.63, 329.63, 440.00] }, // Am
  { bass: 43.65, notes: [174.61, 220.00, 261.63, 349.23] }, // F
];
const HAT_VEL = [0.34, 0.16, 0.42, 0.16];

/* ============================================================
 * 主色调色板（全页面只用这几支颜色）
 * ==========================================================*/
const C = {
  cream: '#fff2dc',   // 背景 · 米白（固定不变）
  amber: '#ffb400',   // 主色 · 黄
  gray:  '#87837e',   // 次要 · 灰
  coral: '#ff5a5f',   // 点缀（少量）
  teal:  '#16c2a3',   // 点缀（少量）
  blue:  '#3e7bfa',   // 点缀（少量）
};
const ACCENTS = [C.coral, C.teal, C.blue];

/* 形状取色：约 62% 主色黄，28% 灰，10% 点缀色 */
function pickColor(rng) {
  const r = rng();
  if (r < 0.62) return C.amber;
  if (r < 0.9) return C.gray;
  return ACCENTS[(rng() * ACCENTS.length) | 0];
}

/* ---------- 12 个全屏特效（均以屏幕正中心为原点，铺满全屏） ---------- */
const EFFECTS = [
  'rings',    // 同心环爆发
  'poly',     // 多边形绽放
  'spiral',   // 螺旋弹珠
  'rays',     // 放射光芒
  'confetti', // 几何纸屑
  'zigzag',   // 折线穿越
  'pop',      // 弹性几何雨
  'cross',    // 巨大十字
  'orbit',    // 环绕轨道
  'wave',     // 波浪丝带
  'stars',    // 星星弹跳
  'grid',     // 旋转线栅
];

/* ============================================================
 * 音频初始化
 * ==========================================================*/
function initAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  master = ctx.createGain();
  master.gain.value = 0.85;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  master.connect(comp);
  comp.connect(ctx.destination);

  // 1 秒白噪声
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadSamples() {
  for (const n of ['da', 'gou', 'jiao']) {
    buffers[n] = await ctx.decodeAudioData(b64ToArrayBuffer(AUDIO_B64[n]));
  }
}

/* ============================================================
 * 鼓组 / 贝斯 / 和弦 合成音色
 * ==========================================================*/
function kick(t) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
  g.gain.setValueAtTime(0.95, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.26);
}

function snare(t, vol = 0.5) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + 0.18);
  // 军鼓腔体
  const o = ctx.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(240, t);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(vol * 0.5, t);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(g2); g2.connect(master);
  o.start(t); o.stop(t + 0.1);
}

function hat(t, vol, decay) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + decay + 0.02);
}

function crash(t) {
  const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
  n.connect(f); f.connect(g); g.connect(master);
  n.start(t); n.stop(t + 1.3);
}

function stab(t, freqs) {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(2600, t);
  f.frequency.exponentialRampToValueAtTime(600, t + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  f.connect(g); g.connect(master);
  for (const fr of freqs) {
    for (const det of [-6, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = fr;
      o.detune.value = det;
      o.connect(f);
      o.start(t); o.stop(t + 0.3);
    }
  }
}

function bass(t, fr, vol) {
  const o = ctx.createOscillator(); o.type = 'square';
  o.frequency.value = fr * 2;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + S8 * 0.9);
  o.connect(f); f.connect(g); g.connect(master);
  o.start(t); o.stop(t + S8);
}

/* ============================================================
 * 循环音轨调度器（lookahead 模式）
 * ==========================================================*/
function scheduleStep(s, t) {
  const bar = (s / 16) | 0;   // 第几小节 0..3
  const pos = s % 16;         // 小节内 16 分位置
  const ch = CHORDS[bar];

  if (bar === 0 && pos === 0) crash(t);            // 循环开头镲片
  if (pos % 4 === 0) kick(t);                      // 四踩地板鼓
  if (pos === 4 || pos === 12) snare(t);           // 2、4 拍军鼓
  if (bar === 3 && pos === 14) snare(t, 0.3);      // 末尾加花
  hat(t, HAT_VEL[pos % 4], pos === 14 ? 0.12 : 0.04);
  if (pos % 4 === 2) stab(t, ch.notes);            // 反拍和弦刺
  if (pos % 2 === 0) bass(t, ch.bass, pos % 4 === 0 ? 0.4 : 0.26);
}

function scheduler() {
  while (nextNoteTime < ctx.currentTime + 0.12) {
    scheduleStep(stepCount, nextNoteTime);
    nextNoteTime += S16;
    stepCount = (stepCount + 1) % 64;
  }
}

/* ============================================================
 * 点击量化：下一个 8 分节奏点
 * ==========================================================*/
function quantize(unit) {
  const now = ctx.currentTime;
  const k = Math.ceil((now + 0.02 - startTime) / unit);
  let t = startTime + k * unit;
  if (t < now) t += unit;
  return t;
}

function playSample(name, rate, t) {
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = 1.0;
  src.connect(g); g.connect(master);
  src.start(t);
}

/* ============================================================
 * 分区（纯逻辑，无可见格子）
 * ==========================================================*/
function buildGrid() {
  const landscape = innerWidth >= innerHeight;
  cols = landscape ? 4 : 3;
  rows = landscape ? 3 : 4;
  // 横排 = 音节：大 / 狗 / 叫 /（叫！低音收尾）
  const colMap = landscape
    ? [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }, { n: 'jiao', s: '叫！', r: 0.8 }]
    : [{ n: 'da', s: '大' }, { n: 'gou', s: '狗' }, { n: 'jiao', s: '叫' }];
  // 纵排 = 音高（上高下低）
  const rowRates = landscape ? [1.33, 1.12, 1.0] : [1.5, 1.25, 1.0, 0.89];

  zones = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const m = colMap[c];
      zones.push({ sample: m.n, syllable: m.s, rate: rowRates[r] * (m.r || 1) });
    }
  }
}

function zoneIndex(x, y) {
  const c = Math.min(cols - 1, Math.max(0, Math.floor(x / innerWidth * cols)));
  const r = Math.min(rows - 1, Math.max(0, Math.floor(y / innerHeight * rows)));
  return r * cols + c;
}

/* ============================================================
 * 工具：随机数 / 缓动 / 颜色 / 路径
 * ==========================================================*/
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = t => t * t * (3 - 2 * t);
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c = 1.70158, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const easeOutElastic = t =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;

function tracePoly(g, x, y, r, sides, rot) {
  g.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

function traceStar(g, x, y, r, points, rot) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 ? r * 0.46 : r;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
}

/* 画一个小几何体（特效的基本粒子） */
function drawPiece(g, kind, color, x, y, r, rot) {
  if (r <= 0) return;
  g.save();
  g.translate(x, y);
  g.rotate(rot || 0);
  switch (kind) {
    case 'circle':
      g.fillStyle = color;
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
      break;
    case 'ring':
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, r * 0.3);
      g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke();
      break;
    case 'square':
      g.fillStyle = color;
      g.fillRect(-r, -r, r * 2, r * 2);
      break;
    case 'triangle':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.2, 3, -Math.PI / 2); g.fill();
      break;
    case 'diamond':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.15, 4, 0); g.fill();
      break;
    case 'hexagon':
      g.fillStyle = color;
      tracePoly(g, 0, 0, r * 1.1, 6, 0); g.fill();
      break;
    case 'star':
      g.fillStyle = color;
      traceStar(g, 0, 0, r * 1.25, 5, -Math.PI / 2); g.fill();
      break;
    case 'cross': {
      g.fillStyle = color;
      const w = r * 0.62;
      g.fillRect(-r, -w / 2, r * 2, w);
      g.fillRect(-w / 2, -r, w, r * 2);
      break;
    }
  }
  g.restore();
}

/* ============================================================
 * 全屏特效引擎（仿 Mikutap）
 *  - 每次触发生成一个全屏特效实例，叠在旧特效之上
 *  - 旧特效播放退场动画后移除
 *  - 页面背景平滑过渡到新特效的落幕背景色
 * ==========================================================*/
const FX_IN = 0.55;    // 入场时长（秒）
const FX_OUT = 0.4;    // 退场时长（秒）

let fxW = 0, fxH = 0;  // 画布尺寸（CSS 像素）
let fxList = [];       // 活跃特效（数组顺序 = 叠放顺序）
let beatP = 0;         // 节拍脉冲 0..1（tick 每帧更新）

function nowSec() { return ctx ? ctx.currentTime : performance.now() / 1000; }
const prog = (t, delay, dur = FX_IN) => clamp01((t - delay) / dur);
const cx0 = () => fxW / 2, cy0 = () => fxH / 2;   // 屏幕正中心

function fxResize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  fxW = innerWidth; fxH = innerHeight;
  fxCanvas.width = Math.round(fxW * dpr);
  fxCanvas.height = Math.round(fxH * dpr);
  fxCanvas.style.width = fxW + 'px';
  fxCanvas.style.height = fxH + 'px';
  fx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 活跃特效重新对齐屏幕正中心
  for (const e of fxList) { e.cx = cx0(); e.cy = cy0(); }
}

/* ---------- 各特效的随机参数预生成（出生即定型，之后纯函数绘制） ----------
 * 所有尺寸按屏幕对角线 / 短边尽量取大，保证铺满全屏不留空 */
const BUILD = {
  rings(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    for (let i = 0; i < 7; i++) inst.shapes.push({
      delay: i * 0.05,
      rEnd: maxD * (0.2 + rng() * 0.42),
      w: 3 + rng() * 7,
      color: pickColor(rng),
    });
    inst.dotR = Math.min(fxW, fxH) * 0.07;
  },
  poly(inst, rng) {
    const sides = 3 + (rng() * 5 | 0);
    const maxD = Math.hypot(fxW, fxH);
    const minD = Math.min(fxW, fxH);
    [[0.95, C.amber, 0], [0.6, C.gray, 0.09], [0.34, C.amber, 0.18]].forEach(([s, color, d], i) =>
      inst.shapes.push({
        sides, delay: d, color,
        rEnd: maxD * s,
        w: minD * (0.024 - i * 0.006),
      }));
  },
  spiral(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 36; i++) inst.shapes.push({
      ang: i * 0.55,
      rad: 6 + i * maxD * 0.019,
      size: minD * (0.009 + i * 0.0008),
      delay: i * 0.018,
      color: pickColor(rng),
    });
  },
  rays(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    const n = 13 + (rng() * 4 | 0);
    inst.r0 = Math.min(fxW, fxH) * 0.06;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang: (i / n) * 2 * Math.PI + rng() * 0.15,
      w: 0.09 + rng() * 0.13,
      len: maxD * (0.6 + rng() * 0.35),
      delay: rng() * 0.12,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  confetti(inst, rng) {
    const maxD = Math.hypot(fxW, fxH);
    const minD = Math.min(fxW, fxH);
    const kinds = ['square', 'circle', 'triangle', 'diamond'];
    for (let i = 0; i < 30; i++) inst.shapes.push({
      ang: rng() * 2 * Math.PI,
      dist: maxD * (0.12 + rng() * 0.46),
      size: minD * (0.026 + rng() * 0.05),
      spin: inst.dir * (1 + rng() * 2) * 2.2,
      delay: rng() * 0.18,
      kind: kinds[(rng() * 4) | 0],
      color: pickColor(rng),
    });
  },
  zigzag(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const horiz = rng() < 0.5;
    const n = 5 + (rng() * 3 | 0);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      if (horiz) pts.push({
        x: -fxW * 0.08 + f * fxW * 1.16,
        y: fxH * (i % 2 ? 0.72 + rng() * 0.14 : 0.14 + rng() * 0.14),
      });
      else pts.push({
        x: fxW * (i % 2 ? 0.7 + rng() * 0.16 : 0.14 + rng() * 0.16),
        y: -fxH * 0.08 + f * fxH * 1.16,
      });
    }
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      lens.push(l); total += l;
    }
    inst.shapes.push({ pts, lens, total, w: minD * (0.02 + rng() * 0.022), color: C.amber });
  },
  pop(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'ring', 'triangle', 'hexagon'];
    for (let i = 0; i < 16; i++) inst.shapes.push({
      x: fxW * (0.06 + rng() * 0.88),
      y: fxH * (0.06 + rng() * 0.88),
      size: minD * (0.036 + rng() * 0.06),
      delay: rng() * 0.28,
      rot: rng() * Math.PI,
      kind: kinds[(rng() * kinds.length) | 0],
      color: pickColor(rng),
    });
  },
  cross(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const size = minD * (0.75 + rng() * 0.35);
    inst.shapes.push({
      size,
      w: size * (0.14 + rng() * 0.08),
      color: rng() < 0.2 ? ACCENTS[(rng() * 3) | 0] : C.amber,
    });
  },
  orbit(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const kinds = ['circle', 'square', 'triangle', 'ring'];
    const n = 10;
    for (let i = 0; i < n; i++) inst.shapes.push({
      ang0: (i / n) * 2 * Math.PI,
      rad: minD * (0.22 + rng() * 0.34),
      speed: inst.dir * (0.45 + rng() * 0.5),
      size: minD * (0.026 + rng() * 0.032),
      delay: rng() * 0.15,
      kind: kinds[i % 4],
      color: pickColor(rng),
    });
    inst.coreR = minD * 0.055;
  },
  wave(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 4; i++) inst.shapes.push({
      y0: fxH * (0.14 + i * 0.24) + (rng() - 0.5) * fxH * 0.08,
      amp: minD * (0.03 + rng() * 0.05),
      wl: fxW * (0.45 + rng() * 0.4),
      speed: inst.dir * (1 + rng() * 1.2),
      th: minD * (0.07 + rng() * 0.06),
      side: i % 2 ? 1 : -1,
      delay: i * 0.08,
      color: rng() < 0.12 ? ACCENTS[(rng() * 3) | 0] : (i % 2 ? C.gray : C.amber),
    });
  },
  stars(inst, rng) {
    const minD = Math.min(fxW, fxH);
    for (let i = 0; i < 12; i++) inst.shapes.push({
      x: fxW * (0.07 + rng() * 0.86),
      y: fxH * (0.07 + rng() * 0.86),
      r: minD * (0.034 + rng() * 0.055),
      delay: rng() * 0.25,
      rot: rng() * Math.PI,
      color: pickColor(rng),
    });
  },
  grid(inst, rng) {
    const minD = Math.min(fxW, fxH);
    const n = 11;
    const radius = minD * 0.52;
    const lines = [];
    for (let i = 0; i < n; i++) lines.push({
      y: (i - (n - 1) / 2) * (radius * 2 / n),
      w: 2.5 + ((i * 7) % 3) * 3,
      delay: i * 0.045,
      color: i % 2 ? C.gray : C.amber,
    });
    inst.shapes.push({ radius, lines });
  },
};

/* ---------- 各特效的绘制（t = 出生至今秒数，fade = 退场透明度） ----------
 * beatP 为节拍脉冲：所有特效都随节拍明显缩放 / 增粗 / 增亮 */
const DRAW = {
  /* 同心环爆发：圆环不断扩张，随节拍呼吸增粗 */
  rings(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) continue;
      const r = k * s.rEnd + t * 16 + beatP * minD * 0.03;
      g.globalAlpha = (1 - k * 0.5) * (0.55 + 0.45 * beatP) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 1.3);
      g.beginPath(); g.arc(inst.cx, inst.cy, r, 0, 7); g.stroke();
    }
    const dk = easeOutBack(prog(t, 0));
    if (dk > 0) {
      g.globalAlpha = fade;
      g.fillStyle = C.amber;
      g.beginPath(); g.arc(inst.cx, inst.cy, inst.dotR * dk * (1 + beatP * 0.45), 0, 7); g.fill();
    }
  },

  /* 多边形绽放：三层多边形描边放大并旋转，随节拍胀缩 */
  poly(g, inst, t, fade) {
    const minD = Math.min(fxW, fxH);
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) continue;
      const r = k * s.rEnd * (1 + beatP * 0.08) + t * 12;
      const rot = inst.rot0 + inst.dir * (1 - k) * 1.3 + t * 0.18 * inst.dir;
      g.globalAlpha = (1 - k * 0.3) * fade;
      g.strokeStyle = s.color;
      g.lineWidth = s.w * (1 + beatP * 0.9) + beatP * minD * 0.004;
      tracePoly(g, inst.cx, inst.cy, r, s.sides, rot);
      g.stroke();
    }
  },

  /* 螺旋弹珠：圆点沿螺旋线依次弹出，整体旋转，随节拍跳动 */
  spiral(g, inst, t, fade) {
    const rot = inst.rot0 + t * 0.45 * inst.dir + beatP * 0.12 * inst.dir;
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang + rot;
      const r = s.rad * k * (1 + beatP * 0.1) + t * 8;
      const x = inst.cx + Math.cos(a) * r;
      const y = inst.cy + Math.sin(a) * r;
      const sz = s.size * k * (1 + beatP * 0.6);
      g.globalAlpha = fade;
      drawPiece(g, i % 6 === 5 ? 'square' : 'circle', s.color, x, y, sz, a);
    });
  },

  /* 放射光芒：楔形光刃旋出，缓慢自转，随节拍伸长 */
  rays(g, inst, t, fade) {
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.5));
      if (k <= 0) continue;
      const rot = inst.rot0 + inst.dir * (1 - k) * 0.8 + t * 0.14 * inst.dir;
      const len = s.len * k * (1 + beatP * 0.22);
      const a = s.ang + rot;
      g.globalAlpha = (0.75 + 0.25 * beatP) * fade;
      g.fillStyle = s.color;
      g.beginPath();
      g.moveTo(inst.cx, inst.cy);
      g.arc(inst.cx, inst.cy, inst.r0 + len, a - s.w, a + s.w);
      g.closePath(); g.fill();
    }
  },

  /* 几何纸屑：小几何体从中心炸开，漂浮 + 随节拍颠簸 */
  confetti(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const x = inst.cx + Math.cos(s.ang) * s.dist * k * (1 + beatP * 0.06);
      const y = inst.cy + Math.sin(s.ang) * s.dist * k * (1 + beatP * 0.06)
        + Math.sin(t * 2.2 + i * 1.3) * 6;
      const sz = s.size * k * (1 + beatP * 0.4);
      const rot = s.spin * k + t * 0.6 * inst.dir;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, sz, rot);
    });
  },

  /* 折线穿越：粗折线横扫全屏（带灰色重影），端点圆点随节拍猛跳 */
  zigzag(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k = easeOutCubic(prog(t, 0, 0.6));
    if (k <= 0) return;
    g.save();
    g.translate(0, Math.sin(t * 1.6) * 7);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // 灰色重影
    g.save();
    g.translate(0, s.w * 2.1);
    g.globalAlpha = 0.4 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = s.w * (1 + beatP * 0.5);
    strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.restore();
    // 主折线
    g.globalAlpha = fade;
    g.strokeStyle = s.color;
    g.lineWidth = s.w * (1 + beatP * 0.7);
    const tip = strokePartial(g, s.pts, s.lens, k * s.total);
    g.stroke();
    g.fillStyle = C.gray;
    g.beginPath(); g.arc(tip.x, tip.y, s.w * (1.1 + beatP * 1.1), 0, 7); g.fill();
    g.restore();
  },

  /* 弹性几何雨：几何体在随机位置 Q 弹冒出，浮动 + 随节拍缩放 */
  pop(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutBack(prog(t, s.delay));
      if (k <= 0) return;
      const y = s.y + Math.sin(t * 2 + i * 1.7) * 7;
      const sz = s.size * k * (1 + beatP * 0.45);
      g.globalAlpha = 0.96 * fade;
      drawPiece(g, s.kind, s.color, s.x, y, sz, s.rot + t * 0.4 * inst.dir + beatP * 0.2 * inst.dir);
    });
  },

  /* 巨大十字：横竖两臂依次弹出并旋转定格，随节拍强烈胀缩 */
  cross(g, inst, t, fade) {
    const s = inst.shapes[0];
    const k1 = easeOutBack(prog(t, 0));
    const k2 = easeOutBack(prog(t, 0.13));
    if (k1 <= 0) return;
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + inst.dir * (1 - k1) * 1.6 + Math.sin(t * 1.3) * 0.07 + beatP * 0.05 * inst.dir);
    const pulse = 1 + beatP * 0.28;
    g.scale(pulse, pulse);
    const L = s.size / 2, w = s.w / 2;
    g.globalAlpha = fade;
    g.fillStyle = s.color;
    g.fillRect(-L * k1, -w, L * 2 * k1, w * 2);
    if (k2 > 0) g.fillRect(-w, -L * k2, w * 2, L * 2 * k2);
    g.globalAlpha = 0.6 * fade;
    g.strokeStyle = C.gray;
    g.lineWidth = Math.max(2, s.w * 0.28);
    g.beginPath(); g.arc(0, 0, s.size * 0.68 * k1 * (1 + beatP * 0.2), 0, 7); g.stroke();
    g.restore();
  },

  /* 环绕轨道：几何体沿轨道持续环绕中心公转，轨道随节拍收缩膨胀 */
  orbit(g, inst, t, fade) {
    inst.shapes.forEach(s => {
      const k = easeOutCubic(prog(t, s.delay));
      if (k <= 0) return;
      const a = s.ang0 + t * s.speed + inst.dir * (1 - k) * 1.8;
      const R = s.rad * k * (1 + beatP * 0.22);
      const x = inst.cx + Math.cos(a) * R;
      const y = inst.cy + Math.sin(a) * R;
      g.globalAlpha = fade;
      drawPiece(g, s.kind, s.color, x, y, s.size * (0.6 + 0.4 * k) * (1 + beatP * 0.35), t * 1.2 * inst.dir);
    });
    const ck = easeOutBack(prog(t, 0));
    if (ck > 0) {
      g.globalAlpha = fade;
      drawPiece(g, 'circle', C.amber, inst.cx, inst.cy,
        inst.coreR * ck * (1 + beatP * 0.5), 0);
    }
  },

  /* 波浪丝带：四条波浪带交替滑入，持续起伏，振幅随节拍加大 */
  wave(g, inst, t, fade) {
    const step = Math.max(14, fxW / 28);
    for (const s of inst.shapes) {
      const k = easeOutCubic(prog(t, s.delay, 0.6));
      if (k <= 0) continue;
      const off = (1 - k) * (fxW + 120) * s.side;
      const amp = s.amp * (0.6 + 0.4 * k) * (1 + beatP * 0.8);
      g.globalAlpha = 0.9 * fade;
      g.fillStyle = s.color;
      g.beginPath();
      for (let x = -60; x <= fxW + 60; x += step) {
        const y = s.y0 + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed) * amp;
        x === -60 ? g.moveTo(x + off, y) : g.lineTo(x + off, y);
      }
      for (let x = fxW + 60; x >= -60; x -= step) {
        const y = s.y0 + s.th * (1 + beatP * 0.3)
          + Math.sin((x / s.wl) * Math.PI * 2 + t * s.speed + 0.9) * amp;
        g.lineTo(x + off, y);
      }
      g.closePath(); g.fill();
    }
  },

  /* 星星弹跳：星星弹性冒出并闪烁自转，随节拍闪烁加剧 */
  stars(g, inst, t, fade) {
    inst.shapes.forEach((s, i) => {
      const k = easeOutElastic(prog(t, s.delay));
      if (k <= 0) return;
      const tw = 1 + 0.15 * Math.sin(t * 3.2 + i * 2.1) + beatP * 0.4;
      g.globalAlpha = 0.97 * fade;
      drawPiece(g, 'star', s.color, s.x, s.y, s.r * k * tw, s.rot + t * 0.7 * inst.dir);
    });
  },

  /* 旋转线栅：圆形视窗内平行线逐条展开，整体旋转，随节拍胀缩增粗 */
  grid(g, inst, t, fade) {
    const s = inst.shapes[0];
    const R = s.radius * (1 + beatP * 0.16) + t * 6;
    g.save();
    g.translate(inst.cx, inst.cy);
    g.rotate(inst.rot0 + t * 0.22 * inst.dir + beatP * 0.06 * inst.dir);
    g.beginPath(); g.arc(0, 0, R, 0, 7); g.clip();
    for (const ln of s.lines) {
      const k = easeOutCubic(prog(t, ln.delay));
      if (k <= 0) continue;
      g.globalAlpha = 0.92 * fade;
      g.strokeStyle = ln.color;
      g.lineWidth = ln.w * (1 + beatP * 0.8);
      g.beginPath();
      g.moveTo(-R * k, ln.y);
      g.lineTo(R * k, ln.y);
      g.stroke();
    }
    g.restore();
    const ok = easeOutBack(prog(t, 0));
    if (ok > 0) {
      g.globalAlpha = fade;
      g.strokeStyle = C.amber;
      g.lineWidth = 4 * (1 + beatP * 0.8);
      g.beginPath(); g.arc(inst.cx, inst.cy, R * ok, 0, 7); g.stroke();
    }
  },
};

/* 折线按可见长度部分描边，返回当前端点 */
function strokePartial(g, pts, lens, vis) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = lens[i - 1];
    if (acc + seg <= vis) {
      g.lineTo(pts[i].x, pts[i].y);
      acc += seg;
    } else {
      const f = seg > 0 ? (vis - acc) / seg : 0;
      const tx = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
      const ty = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
      g.lineTo(tx, ty);
      return { x: tx, y: ty };
    }
  }
  return pts[pts.length - 1];
}

/* 生成一个全屏特效实例（原点固定在屏幕正中心） */
function buildEffect(type) {
  const rng = mulberry32((Math.random() * 1e9) | 0);
  const inst = {
    type,
    cx: cx0(), cy: cy0(),
    t0: 0, state: 'in', outT0: 0,
    rot0: rng() * Math.PI * 2,
    dir: rng() < 0.5 ? -1 : 1,
    shapes: [],
  };
  BUILD[type](inst, rng);
  return inst;
}

/* 触发全屏特效：新特效叠上，旧特效退场 */
function spawnEffect(zi, when) {
  const type = EFFECTS[zi % EFFECTS.length];
  const now = nowSec();

  for (const e of fxList) {
    if (e.state !== 'out') { e.state = 'out'; e.outT0 = now; }
  }
  while (fxList.length > 6) fxList.shift();   // 快速连打时兜底清理

  const inst = buildEffect(type);
  inst.t0 = Math.min(when, now + 0.05);       // 尽量贴节拍，最多延迟 50ms
  fxList.push(inst);
}

/* 每帧绘制：固定米白背景 → 各特效（按叠放顺序） */
function fxFrame(now) {
  fx2d.fillStyle = C.cream;
  fx2d.fillRect(0, 0, fxW, fxH);

  for (let i = fxList.length - 1; i >= 0; i--) {
    const inst = fxList[i];
    let outK = 0;
    if (inst.state === 'out') {
      outK = clamp01((now - inst.outT0) / FX_OUT);
      if (outK >= 1) { fxList.splice(i, 1); continue; }   // 退场完毕，移除
    }
    const t = now - inst.t0;
    if (t < 0) continue;                                  // 等待节拍点

    // 常驻特效整体随节拍呼吸；退场特效整体淡出 + 缩小
    const fade = 1 - smooth(outK);
    const sc = inst.state === 'out' ? 1 - 0.22 * outK : 1 + beatP * 0.05;
    fx2d.save();
    fx2d.translate(inst.cx, inst.cy);
    fx2d.scale(sc, sc);
    fx2d.translate(-inst.cx, -inst.cy);
    DRAW[inst.type](fx2d, inst, t, fade);
    fx2d.restore();
  }
}

/* ---------- 张嘴 / 闭嘴（Q弹） ---------- */
function openMouth(holdMs) {
  dogInner.classList.add('bark');
  clearTimeout(mouthTimer);
  mouthTimer = setTimeout(() => dogInner.classList.remove('bark'), holdMs);
}

/* ============================================================
 * 激活分区（点击或拖动经过）
 * ==========================================================*/
function activate(zi) {
  const z = zones[zi];
  const when = quantize(S8);                  // 量化到下一个 8 分节奏点

  if (when !== lastGlobalHit) {               // 同一节奏点全局只发一个音
    lastGlobalHit = when;
    playSample(z.sample, z.rate, when);
  }

  const waitMs = Math.max(0, (when - ctx.currentTime) * 1000);
  openMouth(waitMs + 280);
  spawnEffect(zi, when);
}

/* ============================================================
 * 节拍动画循环：大狗起伏 + 节拍闪光 + 全屏特效
 * ==========================================================*/
function tick() {
  requestAnimationFrame(tick);
  const now = nowSec();

  if (started && ctx) {
    const t = ctx.currentTime;
    const phase = (((t - startTime) / SPB) % 1 + 1) % 1;  // 当前拍内相位 0..1
    beatP = Math.pow(1 - phase, 2.4);                      // 拍头强、迅速衰减

    dogEl.style.transform =
      `translateY(${(-10 * beatP).toFixed(2)}px) scale(${(1 + 0.05 * beatP).toFixed(4)})`;

    flashEl.style.opacity = (beatP * 0.07).toFixed(3);
  }

  fxFrame(now);
}

/* ============================================================
 * 指针交互：点击 + 长按拖动沿途触发
 * ==========================================================*/
function tryActivate(x, y, zi0) {
  const zi = zoneIndex(x, y);
  if (zi === zi0) return zi0;   // 还在同一分区，不重复触发
  activate(zi);
  return zi;
}

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!started || !buffers.da) { start(); return; }
  pointers.set(e.pointerId, -1);
  pointers.set(e.pointerId, tryActivate(e.clientX, e.clientY, -1));
}, { passive: false });

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  if (!started || !buffers.da) return;
  pointers.set(e.pointerId, tryActivate(e.clientX, e.clientY, pointers.get(e.pointerId)));
}, { passive: false });

function endPointer(e) { pointers.delete(e.pointerId); }
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
window.addEventListener('blur', () => pointers.clear());

window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ============================================================
 * 启动
 * ==========================================================*/
async function start() {
  if (started) return;
  started = true;
  subEl.textContent = '狗 叫 加 载 中 …';

  initAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  await loadSamples();

  startTime = ctx.currentTime + 0.12;
  nextNoteTime = startTime;
  stepCount = 0;
  setInterval(scheduler, 25);

  overlay.classList.add('hide');
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  fxResize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildGrid, 150);
});

buildGrid();
fxResize();
requestAnimationFrame(tick);
