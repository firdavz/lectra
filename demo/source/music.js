// Lectra MV soundtrack: synthesized from scratch, no samples.
// 120 BPM, A minor (Am - F - C - G), 96 s, structured to match the scenes in mv.js.
// Usage: node music.js out.wav
const fs = require('fs');

const SR = 44100, DUR = 96, N = SR * DUR;
const BAR = 2, BEAT = 0.5;

// buses: drums (not ducked), music (sidechained to the kick), reverb send, arp delay send
const DL = new Float32Array(N), DR = new Float32Array(N);
const ML = new Float32Array(N), MR = new Float32Array(N);
const SL = new Float32Array(N), SR_ = new Float32Array(N);
const AL = new Float32Array(N), AR = new Float32Array(N);
const kickTimes = [];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 12345;
const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
const panGains = (p) => [Math.cos((p + 1) * Math.PI / 4) * Math.SQRT2, Math.sin((p + 1) * Math.PI / 4) * Math.SQRT2];

// TPT state-variable filter
function svf() {
  let ic1 = 0, ic2 = 0;
  return (x, fc, q = 0.707) => {
    const g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
  };
}

function write(busL, busR, i, v, pan = 0, send = 0) {
  if (i < 0 || i >= N) return;
  const [gl, gr] = panGains(pan);
  busL[i] += v * gl; busR[i] += v * gr;
  if (send) { SL[i] += v * send; SR_[i] += v * send; }
}

// ---------- instruments ----------
function kick(t, vel = 1) {
  kickTimes.push(t);
  const s0 = Math.round(t * SR), len = Math.round(0.5 * SR);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    const f = 44 + 120 * Math.exp(-tt * 30);
    ph += 2 * Math.PI * f / SR;
    let v = Math.sin(ph) * Math.exp(-tt * 6.5) + noise() * Math.exp(-tt * 400) * 0.25;
    write(DL, DR, s0 + k, Math.tanh(v * 1.6) * 0.9 * vel);
  }
}

function clap(t, vel = 1) {
  const s0 = Math.round(t * SR), len = Math.round(0.35 * SR), f = svf();
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    let env = Math.exp(-tt * 16);
    if (tt < 0.03) env *= 0.6 + 0.4 * Math.cos(tt * 2 * Math.PI / 0.01);
    const v = f(noise(), 1300, 1.3).bp * env * 1.6 * vel;
    write(DL, DR, s0 + k, v, 0, 0.35);
  }
}

function hat(t, vel = 1, open = false, pan = 0) {
  const s0 = Math.round(t * SR), len = Math.round((open ? 0.3 : 0.07) * SR), f = svf();
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    const v = f(noise(), 8000, 0.8).hp * Math.exp(-tt * (open ? 12 : 60)) * vel * 0.5;
    write(DL, DR, s0 + k, v, pan, 0.05);
  }
}

function snare(t, vel = 1) {
  const s0 = Math.round(t * SR), len = Math.round(0.18 * SR), f = svf();
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    ph += 2 * Math.PI * (180 + 60 * Math.exp(-tt * 40)) / SR;
    const v = (f(noise(), 2600, 0.9).bp * 1.4 + Math.sin(ph) * 0.4) * Math.exp(-tt * 22) * vel;
    write(DL, DR, s0 + k, v, 0, 0.2);
  }
}

function bass(t, dur, midi, vel = 1) {
  const s0 = Math.round(t * SR), len = Math.round((dur + 0.05) * SR), f = svf();
  const fr = mtof(midi);
  let ph = 0, sub = 0;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    ph = (ph + fr / SR) % 1; sub += 2 * Math.PI * fr / SR;
    const saw = 2 * ph - 1;
    const cut = 180 + 1100 * Math.exp(-tt * 14);
    let amp = Math.min(1, tt / 0.004) * (tt < dur ? 1 : Math.exp(-(tt - dur) * 60));
    const v = (f(saw, cut, 1.1).lp * 0.8 + Math.sin(sub) * 0.55) * amp * vel;
    write(ML, MR, s0 + k, v);
  }
}

function pad(t, dur, notes, vel, cutoffAt) {
  const rel = 1.2, s0 = Math.round(t * SR), len = Math.round((dur + rel) * SR);
  const bl = new Float32Array(len), br = new Float32Array(len);
  const detune = [-0.11, 0, 0.11], pans = [-0.7, 0, 0.7];
  for (const m of notes) {
    for (let d = 0; d < 3; d++) {
      const fr = mtof(m + detune[d]);
      const [gl, gr] = panGains(pans[d]);
      let ph = (m * 0.37 + d * 0.21) % 1;
      for (let k = 0; k < len; k++) {
        ph = (ph + fr / SR) % 1;
        const v = 2 * ph - 1;
        bl[k] += v * gl; br[k] += v * gr;
      }
    }
  }
  const fl = svf(), fr2 = svf();
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    const amp = Math.min(1, tt / 0.35) * (tt < dur ? 1 : Math.exp(-(tt - dur) * 4)) * vel * 0.12;
    const c = cutoffAt(t + tt);
    const i = s0 + k;
    if (i >= N) break;
    const l = fl(bl[k], c, 0.8).lp * amp, r = fr2(br[k], c, 0.8).lp * amp;
    ML[i] += l; MR[i] += r; SL[i] += (l + r) * 0.25; SR_[i] += (l + r) * 0.25;
  }
}

function pluck(t, midi, vel, bright, pan) {
  const s0 = Math.round(t * SR), len = Math.round(0.3 * SR), f = svf();
  const fr = mtof(midi);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    ph = (ph + fr / SR) % 1;
    const osc = (2 * ph - 1) * 0.6 + (ph < 0.5 ? 0.4 : -0.4);
    const cut = 500 + 3600 * bright * Math.exp(-tt * 18);
    const v = f(osc, cut, 1.4).lp * Math.exp(-tt * 10) * Math.min(1, tt / 0.002) * vel;
    write(ML, MR, s0 + k, v, pan, 0.15);
    if (s0 + k < N) { AL[s0 + k] += v * 0.5; AR[s0 + k] += v * 0.5; }
  }
}

function lead(t, dur, midi, vel) {
  const s0 = Math.round(t * SR), len = Math.round((dur + 0.4) * SR), f = svf();
  const base = mtof(midi);
  let p1 = 0, p2 = 0.3;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, tt / 0.3);
    p1 = (p1 + base * vib * 1.003 / SR) % 1; p2 = (p2 + base * vib * 0.997 / SR) % 1;
    const osc = (2 * p1 - 1) + (2 * p2 - 1);
    const amp = Math.min(1, tt / 0.02) * (tt < dur ? 1 : Math.exp(-(tt - dur) * 9));
    const v = f(osc, 2400 + 800 * Math.exp(-tt * 6), 0.9).lp * amp * vel * 0.5;
    write(ML, MR, s0 + k, v, 0, 0.35);
    if (s0 + k < N) { AL[s0 + k] += v * 0.35; AR[s0 + k] += v * 0.35; }
  }
}

function riser(t0, t1, vel = 1) {
  const s0 = Math.round(t0 * SR), len = Math.round((t1 - t0) * SR), f = svf();
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const p = k / len;
    const fc = 300 * Math.pow(20, p);
    ph += 2 * Math.PI * (180 * Math.pow(6, p)) / SR;
    const v = (f(noise(), fc, 2).bp * 1.2 + Math.sin(ph) * 0.08) * p * p * vel;
    write(DL, DR, s0 + k, v, Math.sin(p * 9) * 0.4, 0.4);
  }
}

function whoosh(t, vel = 0.5) {
  const d = 0.6, s0 = Math.round((t - d) * SR), len = Math.round(d * 1.4 * SR), f = svf();
  for (let k = 0; k < len; k++) {
    const p = k / (d * SR);
    const env = p < 1 ? p * p : Math.exp(-(p - 1) * 12);
    const v = f(noise(), 500 * Math.pow(8, Math.min(p, 1)), 1.5).bp * env * vel;
    write(DL, DR, s0 + k, v, -0.8 + 1.6 * Math.min(p, 1), 0.3);
  }
}

function impact(t, vel = 1) {
  kick(t, vel);
  const s0 = Math.round(t * SR), len = Math.round(2.6 * SR), f = svf();
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const tt = k / SR;
    ph += 2 * Math.PI * (30 + 30 * Math.exp(-tt * 3)) / SR;
    const boom = Math.sin(ph) * Math.exp(-tt * 1.6) * 0.8;
    const crash = f(noise(), 3500, 0.7).hp * Math.exp(-tt * 2.2) * 0.35;
    write(DL, DR, s0 + k, (boom + crash) * vel, 0, 0.6);
  }
}

// ---------- arrangement ----------
const CH = {
  Am: { root: 45, pad: [57, 60, 64], arp: [69, 72, 76, 81, 76, 72, 69, 72] },
  F: { root: 41, pad: [57, 60, 65], arp: [65, 69, 72, 77, 72, 69, 65, 69] },
  C: { root: 48, pad: [55, 60, 64], arp: [67, 72, 76, 79, 76, 72, 67, 72] },
  G: { root: 43, pad: [55, 59, 62], arp: [67, 71, 74, 79, 74, 71, 67, 71] },
};
const PROG = ['Am', 'F', 'C', 'G'];
const chordAt = (bar) => CH[bar >= 46 ? 'Am' : PROG[bar % 4]];
const groove = (bar) => (bar >= 7 && bar <= 23) || (bar >= 28 && bar <= 43);
const breakdown = (bar) => bar >= 24 && bar <= 27;

const padCut = (t) => t < 8 ? 400 + 1100 * (t / 8) : t < 48 ? 1700 : t < 56 ? 1200 + 1800 * ((t - 48) / 8) : t < 88 ? 2000 : 2000 - 1500 * Math.min(1, (t - 88) / 8);
const arpBright = (t) => t < 48 ? 1 : t < 56 ? 0.15 + 0.85 * Math.pow((t - 48) / 8, 2) : t < 88 ? 1 : Math.max(0.2, 1 - (t - 88) / 6);

const MELODY = [ // [beat within 4 bars, length in beats, midi]
  [0, 1, 76], [1, 0.5, 72], [1.5, 0.5, 74], [2, 1, 76], [3, 1, 81],
  [4, 1.5, 81], [5.5, 0.5, 79], [6, 1, 77], [7, 1, 76],
  [8, 1, 76], [9, 1, 79], [10, 1, 84], [11, 1, 79],
  [12, 1.5, 74], [13.5, 0.5, 76], [14, 1, 71], [15, 1, 74],
];

for (let bar = 0; bar < 48; bar++) {
  const ch = chordAt(bar), bt = bar * BAR;

  // pad
  const padVel = bar < 4 ? 0.8 : bar < 7 ? 1.0 : breakdown(bar) ? 1.25 : bar >= 44 ? 1.1 : 0.75;
  if (bar < 46) pad(bt, BAR, ch.pad, padVel, padCut);
  else if (bar === 46) pad(bt, 3.4, CH.Am.pad.concat([69]), 1.1, padCut);

  // bass
  if (groove(bar) || bar === 44) {
    const oct = [0, 0, 12, 0, 0, 12, 0, 12];
    for (let e = 0; e < 8; e++) bass(bt + e * 0.25, 0.2, ch.root + oct[e], 0.55);
  } else if (bar >= 4 && bar <= 6) bass(bt, 1.9, ch.root, 0.4);
  else if (bar === 45) bass(bt, 1.9, ch.root, 0.35);

  // drums
  if (groove(bar)) {
    for (let b = 0; b < 4; b++) kick(bt + b * BEAT, 0.95);
    clap(bt + 1 * BEAT, 0.8); clap(bt + 3 * BEAT, 0.8);
    for (let b = 0; b < 4; b++) hat(bt + b * BEAT + 0.25, 0.55, true, 0.2);
    if ((bar >= 12 && bar <= 23) || (bar >= 32 && bar <= 43))
      for (let s = 0; s < 16; s++) if (s % 2 === 0 || s % 4 === 3) hat(bt + s * 0.125, s % 4 === 0 ? 0.25 : 0.4, false, s % 2 ? -0.35 : 0.35);
  } else if (bar < 4) {
    for (let s = 0; s < 16; s++) hat(bt + s * 0.125, 0.08 + 0.22 * (bar * 16 + s) / 64, false, s % 2 ? -0.3 : 0.3);
    if (bar >= 2) { kick(bt, 0.6); kick(bt + 1, 0.6); }
  } else if ((bar >= 4 && bar <= 6) || bar === 44 || bar === 45) {
    kick(bt, 0.7);
  }

  // arp
  if (bar >= 4 && bar <= 46) {
    for (let s = 0; s < 16; s++) {
      const t = bt + s * 0.125;
      const fade = bar >= 44 ? Math.max(0, 1 - (t - 88) / 7) : 1;
      pluck(t, ch.arp[s % 8], (bar < 7 ? 0.22 : breakdown(bar) ? 0.26 : 0.2) * fade, arpBright(t), s % 2 ? 0.45 : -0.45);
    }
  }

  // lead hook in the second half
  if (bar >= 32 && bar <= 43) {
    const phraseStart = bar - (bar - 32) % 4;
    if ((bar - 32) % 4 === 0) {
      for (const [b, len, m] of MELODY) lead(phraseStart * BAR + b * BEAT, len * BEAT * 0.9, m, 0.22);
    }
  }
}

// rolls and fx
for (let s = 0; s < 16; s++) snare(54 + s * 0.125, 0.1 + 0.4 * s / 16);
for (let s = 0; s < 16; s++) snare(84 + s * 0.125, 0.12 + 0.2 * s / 16);
for (let s = 0; s < 32; s++) snare(86 + s * 0.0625, 0.3 + 0.4 * s / 32);
riser(5.5, 8, 0.9); riser(54, 56, 0.8); riser(84, 88, 1.0); riser(12.6, 14, 0.35); riser(22.6, 24, 0.4);
impact(8, 1.0); impact(14, 0.5); impact(24, 0.6); impact(36, 0.45); impact(56, 0.9); impact(88, 1.0);
for (const t of [48, 66, 74, 82]) whoosh(t, 0.45);

// ---------- mix ----------
// ping-pong delay on arp/lead (dotted eighth)
const dly = Math.round(0.375 * SR);
for (let i = dly; i < N; i++) {
  AL[i] += AR[i - dly] * 0.38;
  AR[i] += AL[i - dly] * 0.38;
}
for (let i = 0; i < N; i++) { ML[i] += AR[i] * 0.5; MR[i] += AL[i] * 0.5; }

// freeverb-lite on the send bus
function reverb(input, offset) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((d) => ({ buf: new Float32Array(d + offset), i: 0, store: 0 }));
  const aps = [556, 441, 341].map((d) => ({ buf: new Float32Array(d + offset), i: 0 }));
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const x = input[n] * 0.2;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.store = o * 0.7 + c.store * 0.3;
      c.buf[c.i] = x + c.store * 0.84;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = y + b * 0.5;
      y = b - y;
      a.i = (a.i + 1) % a.buf.length;
    }
    out[n] = y;
  }
  return out;
}
const WL = reverb(SL, 0), WR = reverb(SR_, 23);

// sidechain ducking from kick times
const duck = new Float32Array(N).fill(1);
for (const t of kickTimes) {
  const s0 = Math.round(t * SR);
  for (let k = 0; k < 0.35 * SR && s0 + k < N; k++) duck[s0 + k] = Math.min(duck[s0 + k], 1 - 0.55 * Math.exp(-k / SR / 0.09));
}

const outL = new Float32Array(N), outR = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  let l = DL[i] + ML[i] * duck[i] + WL[i] * 0.35;
  let r = DR[i] + MR[i] * duck[i] + WR[i] * 0.35;
  l = Math.tanh(l * 0.9); r = Math.tanh(r * 0.9);
  const t = i / SR;
  const fade = Math.min(1, t / 0.05) * Math.min(1, (DUR - t) / 1.5);
  outL[i] = l * fade; outR[i] = r * fade;
  peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
}

const gain = 0.93 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outL[i] * gain)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outR[i] * gain)) * 32767), 46 + i * 4);
}
fs.writeFileSync(process.argv[2] || 'music.wav', buf);
console.log('wrote', process.argv[2] || 'music.wav', 'peak', peak.toFixed(3));
