// Lectra MV: every frame is drawn by code on a 1920x1080 canvas.
// renderFrame(t) is a pure function of time, so render.js can step through it
// frame by frame; opening mv.html plays it live with music.wav.
'use strict';

const W = 1920, H = 1080, DUR = 96;
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const off = document.createElement('canvas');
off.width = W; off.height = H;
const octx = off.getContext('2d');

// the app's own design tokens (frontend/styles.css)
const C = {
  bg: '#0e1022', canvas: '#0d0e21', text: '#eeecfa', muted: '#a09ec4',
  v: '#7c5cff', c: '#00d4ff', lav: '#a78bfa',
  topicBg: '#161433', topicBorder: '#34296f', nodeBg: '#241e4f',
  danger: '#ff5c7a', ok: '#34d399', edge: '#8e8bc0',
};
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const MONO = '"Cascadia Mono", Consolas, monospace';

// ---------- math ----------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const P = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - x, 3);
const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const eback = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const eexp = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// kick pattern from music.js, so the visuals breathe with the beat
const groove = (t) => { const b = Math.floor(t / 2); return (b >= 7 && b <= 23) || (b >= 28 && b <= 43); };
const pulse = (t) => (groove(t) ? Math.exp(-(t % 0.5) * 7) : 0);

// ---------- drawing primitives ----------
const font = (size, weight = 600, f = FONT) => `${weight} ${size}px ${f}`;
function tw(s, size, weight = 600, f = FONT, ls = 0) {
  ctx.save(); ctx.font = font(size, weight, f); ctx.letterSpacing = ls + 'px';
  const w = ctx.measureText(s).width; ctx.restore(); return w;
}
function rr(x, y, w, h, r, c = ctx) { c.beginPath(); c.roundRect(x, y, w, h, r); }
function grad(x0, x1, y, c = ctx, a = C.v, b = C.c) {
  const g = c.createLinearGradient(x0, y, x1, y); g.addColorStop(0, a); g.addColorStop(1, b); return g;
}
function T(s, x, y, o = {}) {
  const c = o.ctx || ctx;
  c.save();
  c.font = font(o.size || 32, o.weight || 600, o.font || FONT);
  c.letterSpacing = (o.ls || 0) + 'px';
  c.textAlign = o.align || 'left'; c.textBaseline = o.base || 'middle';
  c.globalAlpha *= o.alpha ?? 1;
  if (o.grad) {
    const w = c.measureText(s).width;
    const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    c.fillStyle = grad(x0, x0 + w, y, c);
  } else c.fillStyle = o.color || C.text;
  if (o.glow) { c.shadowColor = o.glowColor || C.v; c.shadowBlur = o.glow; }
  c.fillText(s, x, y);
  c.restore();
}
function wrap(s, maxW, size, weight = 500, f = FONT) {
  const words = s.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (tw(next, size, weight, f) > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
function glow(x, y, r, col) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
function glass(x, y, w, h, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  if (o.glow) { ctx.shadowColor = o.glowColor || 'rgba(124,92,255,0.5)'; ctx.shadowBlur = o.glow; }
  rr(x, y, w, h, o.r ?? 18);
  ctx.fillStyle = o.fill || 'rgba(20,19,48,0.86)'; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = o.lw || 1.5; ctx.strokeStyle = o.stroke || 'rgba(167,139,250,0.26)'; ctx.stroke();
  ctx.restore();
}
function dots(x, y, w, h, step = 26, a = 0.11) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = `rgba(167,139,250,${a})`;
  for (let yy = y + step / 2; yy < y + h; yy += step) for (let xx = x + step / 2; xx < x + w; xx += step) ctx.fillRect(xx - 1, yy - 1, 2, 2);
  ctx.restore();
}
function chip(label, x, y, o = {}) {
  const size = o.size || 18;
  ctx.save();
  ctx.font = font(size, 700); ctx.letterSpacing = (o.ls ?? 3) + 'px';
  const w = ctx.measureText(label).width + size * 1.7, h = size * 2.1;
  const x0 = o.align === 'center' ? x - w / 2 : x;
  ctx.globalAlpha *= o.alpha ?? 1;
  rr(x0, y - h / 2, w, h, h / 2);
  ctx.fillStyle = o.fill || 'rgba(0,212,255,0.10)'; ctx.fill();
  ctx.strokeStyle = o.stroke || 'rgba(0,212,255,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = o.color || C.c; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText(label, x0 + size * 0.85, y + 1);
  ctx.restore();
  return w;
}
function chipW(label, size = 18, ls = 3) { return tw(label, size, 700, FONT, ls) + size * 1.7; }
function arrowHead(x, y, ux, uy, s, col) {
  ctx.fillStyle = col; ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * s - uy * s * 0.55, y - uy * s + ux * s * 0.55);
  ctx.lineTo(x - ux * s + uy * s * 0.55, y - uy * s - ux * s * 0.55);
  ctx.closePath(); ctx.fill();
}
function button(label, x, y, w, h, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  rr(x, y, w, h, o.r ?? 10);
  if (o.primary) {
    ctx.shadowColor = 'rgba(124,92,255,0.6)'; ctx.shadowBlur = 24;
    ctx.fillStyle = grad(x, x + w, y); ctx.fill(); ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = o.fill || 'rgba(124,92,255,0.07)'; ctx.fill();
    ctx.strokeStyle = o.stroke || 'rgba(139,114,246,0.85)'; ctx.lineWidth = o.lw || 1.5; ctx.stroke();
  }
  T(label, o.textAlign === 'left' ? x + 20 : x + w / 2, y + h / 2 + 1, { size: o.size || 22, weight: 650, align: o.textAlign || 'center', color: o.color || (o.primary ? '#fff' : C.lav) });
  ctx.restore();
}

// mouse cursor with click ripple; keys = [[t, x, y], ...]
function cursorAt(lt, keys) {
  if (lt <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (lt <= keys[i][0]) {
      const p = eio(P(lt, keys[i - 1][0], keys[i][0]));
      return [lerp(keys[i - 1][1], keys[i][1], p), lerp(keys[i - 1][2], keys[i][2], p)];
    }
  }
  const k = keys[keys.length - 1]; return [k[1], k[2]];
}
function cursor(x, y, lt, clicks = [], alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  let press = 0;
  for (const c of clicks) {
    const p = P(lt, c, c + 0.6);
    if (p > 0 && p < 1) {
      ctx.save(); ctx.globalAlpha *= 1 - p; ctx.strokeStyle = C.c; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 8 + 46 * eo(p), 0, 7); ctx.stroke(); ctx.restore();
    }
    if (lt >= c - 0.05 && lt < c + 0.12) press = 1;
  }
  ctx.translate(x, y); const s = press ? 1.25 : 1.45; ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.lineTo(6, 17); ctx.lineTo(10, 26); ctx.lineTo(14, 24); ctx.lineTo(10, 15.5); ctx.lineTo(17, 15.5); ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10;
  ctx.fillStyle = '#fff'; ctx.fill(); ctx.shadowBlur = 0;
  ctx.strokeStyle = '#0e1022'; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.restore();
}

// ---------- lecture-map diagrams (boxes + labelled arrows, like the app's Cytoscape canvas) ----------
const KIND_ICON = { process: '⚙️', timeline: '⏳', concept: '💡', comparison: '⚖️' };
function diagram(def) {
  const s = def.s || 1;
  const nodes = def.nodes.map(([id, l, e, x, y, t]) => ({ id, l, e, x, y, t, s }));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = (def.edges || []).map(([a, b, l, t]) => ({ a: byId[a], b: byId[b], l, t }));
  return { ...def, s, nodes, edges, byId };
}
function sizeNode(n) {
  n.label = (n.e ? n.e + '  ' : '') + n.l;
  n.w = tw(n.label, 22 * n.s, 600) + 40 * n.s;
  n.h = 54 * n.s;
}
function nodeP(n, lt) { return P(lt, n.t, n.t + 0.45); }
function drawNode(n, lt, o = {}) {
  if (n.w == null) sizeNode(n);
  const p = nodeP(n, lt);
  if (p <= 0) return;
  const sc = lerp(0.4, 1, eback(p));
  const base = clamp(p * 2.2) * (o.alpha ?? 1);
  const fresh = o.noGlow ? 0 : clamp(1 - (lt - n.t) / 2.6);
  const hl = o.hl && o.hl.has(n.id);
  ctx.save();
  ctx.translate(n.x, n.y); ctx.scale(sc, sc);
  ctx.globalAlpha *= base;
  const w = n.w, h = n.h;
  if (fresh > 0 || hl) { ctx.shadowColor = hl ? C.c : C.v; ctx.shadowBlur = hl ? 34 : 46 * fresh; }
  rr(-w / 2, -h / 2, w, h, 12 * n.s);
  ctx.fillStyle = o.fill || C.nodeBg; ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = (hl ? 3.5 : 2) * n.s; ctx.strokeStyle = hl ? C.c : o.stroke || C.v; ctx.stroke();
  if (fresh > 0) {
    ctx.save(); ctx.globalAlpha *= fresh;
    rr(-w / 2 - 7, -h / 2 - 7, w + 14, h + 14, 16 * n.s);
    ctx.strokeStyle = 'rgba(124,92,255,0.75)'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
  }
  ctx.font = font(22 * n.s, 600); ctx.fillStyle = o.textColor || C.text;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(n.label, 0, 1.5 * n.s);
  if (o.strike) {
    const sp = eo(P(lt, o.strike, o.strike + 0.4));
    if (sp > 0) {
      ctx.strokeStyle = C.danger; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-w / 2 - 10, 0); ctx.lineTo(-w / 2 - 10 + (w + 20) * sp, 0); ctx.stroke();
    }
  }
  ctx.restore();
}
function clipRect(n, ux, uy, pad) {
  const sx = ux ? (n.w / 2 + pad) / Math.abs(ux) : Infinity, sy = uy ? (n.h / 2 + pad) / Math.abs(uy) : Infinity;
  const s = Math.min(sx, sy);
  return [n.x + ux * s, n.y + uy * s];
}
function drawEdge(e, lt, o = {}) {
  const a = e.a, b = e.b;
  if (a.w == null) sizeNode(a);
  if (b.w == null) sizeNode(b);
  const p = P(lt, e.t, e.t + 0.5);
  if (p <= 0 || nodeP(a, lt) < 0.3 || nodeP(b, lt) < 0.3) return;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  const A = clipRect(a, ux, uy, 4), B = clipRect(b, -ux, -uy, 7);
  const q = eo(p), ex = lerp(A[0], B[0], q), ey = lerp(A[1], B[1], q);
  const hl = o.hl && o.hl.has(a.id + '>' + b.id);
  const col = hl ? C.c : o.color || C.edge;
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  if (hl) { ctx.shadowColor = C.c; ctx.shadowBlur = 18; }
  ctx.strokeStyle = col; ctx.lineWidth = (hl ? 4 : 2.4) * a.s;
  ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(ex, ey); ctx.stroke();
  if (p > 0.6) arrowHead(ex, ey, ux, uy, 13 * a.s, col);
  ctx.shadowBlur = 0;
  if (e.l && !o.noLabels && p > 0.4) {
    const la = clamp((p - 0.4) / 0.4);
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    const fs = 17 * a.s;
    ctx.font = font(fs, 600);
    const w = ctx.measureText(e.l).width + 18 * a.s;
    ctx.globalAlpha *= la;
    rr(mx - w / 2, my - fs * 0.85, w, fs * 1.7, 8 * a.s);
    ctx.fillStyle = C.canvas; ctx.fill();
    ctx.fillStyle = hl ? C.c : C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(e.l, mx, my + 1);
  }
  ctx.restore();
}
// The topic frame grows smoothly around the boxes as they appear.
function frameBounds(d, lt) {
  let B = null;
  const rect = (n) => [n.x - n.w / 2, n.y - n.h / 2, n.x + n.w / 2, n.y + n.h / 2];
  const uni = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  for (const n of d.nodes) {
    if (n.w == null) sizeNode(n);
    const p = nodeP(n, lt);
    if (p <= 0) continue;
    const r = rect(n);
    if (!B) { const c = [n.x, n.y, n.x, n.y]; B = c.map((v, i) => lerp(v, r[i], eo(p))); continue; }
    const U = uni(B, r);
    B = B.map((v, i) => lerp(v, U[i], eo(p)));
  }
  return B;
}
function drawDiagram(d, lt, o = {}) {
  ctx.save();
  if (o.x != null) { ctx.translate(o.x, o.y); ctx.scale(o.scale || 1, o.scale || 1); }
  ctx.globalAlpha *= o.alpha ?? 1;
  if (o.frame !== false) {
    const B = frameBounds(d, lt);
    if (B) {
      const pad = 26 * d.s, top = 58 * d.s;
      const x = B[0] - pad, y = B[1] - top, w = B[2] - B[0] + pad * 2, h = B[3] - B[1] + top + pad;
      ctx.save();
      rr(x, y, w, h, 18 * d.s);
      ctx.fillStyle = 'rgba(22,20,51,0.92)'; ctx.fill();
      ctx.strokeStyle = C.topicBorder; ctx.lineWidth = 2; ctx.stroke();
      ctx.globalAlpha *= clamp(P(lt, d.nodes[0].t, d.nodes[0].t + 0.5));
      ctx.font = font(20 * d.s, 700); ctx.fillStyle = C.text; ctx.textBaseline = 'middle';
      ctx.fillText(`${KIND_ICON[d.kind] || ''}  ${d.title}`, x + 18 * d.s, y + 30 * d.s);
      ctx.restore();
    }
  }
  for (const e of d.edges) drawEdge(e, lt, o);
  for (const n of d.nodes) drawNode(n, lt, o);
  ctx.restore();
}

// ---------- background ----------
const PARTS = (() => { const r = rng(7); return Array.from({ length: 120 }, () => ({ x: r() * W, y: r() * H, s: 0.6 + r() * 2.2, v: 8 + r() * 28, ph: r() * 6.28, c: r() > 0.55 })); })();
function background(t) {
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  const pu = pulse(t);
  glow(W * (0.1 + 0.06 * Math.sin(t * 0.21)), H * (0.08 + 0.06 * Math.cos(t * 0.17)), 1150, `rgba(88,80,196,${0.34 + pu * 0.1})`);
  glow(W * (0.94 + 0.04 * Math.cos(t * 0.19)), H * (0.98 + 0.05 * Math.sin(t * 0.23)), 1000, `rgba(0,150,255,${0.17 + pu * 0.08})`);
  glow(W * (0.55 + 0.25 * Math.sin(t * 0.07)), H * 0.45, 760, 'rgba(124,92,255,0.07)');
  const lx = W * 0.12, ly = H * 0.1;
  ctx.fillStyle = '#a78bfa';
  for (let y = 16; y < H; y += 32) for (let x = 16; x < W; x += 32) {
    const a = 0.12 * (1 - Math.hypot(x - lx, y - ly) / 1500);
    if (a <= 0.008) continue;
    ctx.globalAlpha = a; ctx.fillRect(x - 1, y - 1, 2, 2);
  }
  for (const p of PARTS) {
    const y = (((p.y - t * p.v) % H) + H) % H;
    ctx.globalAlpha = (0.12 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2 + p.ph))) * (1 + pu * 0.6);
    ctx.fillStyle = p.c ? C.c : C.lav;
    ctx.beginPath(); ctx.arc(p.x + Math.sin(t * 0.5 + p.ph) * 22, y, p.s, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function vignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.42, W / 2, H / 2, H * 1.05);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(3,3,12,0.78)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

// section header: numbered chip, headline, sub
function header(lt, num, label, title, sub, o = {}) {
  const p = eo(P(lt, 0.05, 0.6)), x = (o.x ?? 120) - (1 - p) * 50;
  ctx.save(); ctx.globalAlpha *= p;
  chip(`${num}  ·  ${label}`, x, o.y ?? 112);
  if (title) T(title, x, (o.y ?? 112) + 78, { size: o.size || 60, weight: 750, ls: -1, grad: o.gradTitle });
  if (sub) T(sub, x, (o.y ?? 112) + 138, { size: 26, weight: 500, color: C.muted, alpha: eo(P(lt, 0.3, 0.9)) });
  ctx.restore();
}

// word-by-word kinetic line, centred at cx
function kinetic(line, cx, y, lt, t0, step, size, o = {}) {
  const ws = line.split(' ');
  ctx.save(); ctx.font = font(size, o.weight || 760); ctx.letterSpacing = (o.ls ?? -1) + 'px';
  const space = ctx.measureText(' ').width, widths = ws.map((w) => ctx.measureText(w).width);
  ctx.restore();
  const total = widths.reduce((a, b) => a + b, 0) + space * (ws.length - 1);
  let x = cx - total / 2;
  ws.forEach((w, i) => {
    const p = P(lt, t0 + i * step, t0 + i * step + 0.38);
    if (p > 0) {
      ctx.save();
      ctx.globalAlpha *= clamp(p * 1.6) * (o.alpha ?? 1);
      let jx = 0, jy = 0;
      if (o.shake && o.shake(w)) { jx = Math.sin(lt * 61 + i) * 4; jy = Math.cos(lt * 47 + i) * 3; }
      ctx.translate(x + widths[i] / 2 + jx, y + (1 - eo(p)) * 34 + jy);
      const sc = lerp(1.3, 1, eo(p)); ctx.scale(sc, sc);
      ctx.font = font(size, o.weight || 760); ctx.letterSpacing = (o.ls ?? -1) + 'px';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const col = o.colorFor ? o.colorFor(w) : null;
      if (col === 'grad') ctx.fillStyle = grad(-widths[i] / 2, widths[i] / 2, 0);
      else ctx.fillStyle = col || o.color || C.text;
      if (o.glow) { ctx.shadowColor = col === C.danger ? C.danger : C.v; ctx.shadowBlur = o.glow; }
      ctx.fillText(w, 0, 0);
      ctx.restore();
    }
    x += widths[i] + space;
  });
}

// =====================================================================
// SCENES (lt = seconds since the scene started)
// =====================================================================

// ---- 1. The problem: a lecture that moves too fast ----
const LECTURE = 'photosynthesis converts light energy into chemical energy stored in glucose · chlorophyll in the thylakoid membrane absorbs photons · excited electrons pass along the electron transport chain · producing ATP and NADPH for the Calvin cycle · where rubisco fixes carbon dioxide into three-carbon sugars · ';
function sProblem(lt) {
  const collapse = eio(P(lt, 6.1, 7.7));
  ctx.save();
  ctx.font = font(30, 500, MONO);
  const L = ctx.measureText(LECTURE).width;
  for (let i = 0; i < 11; i++) {
    const dir = i % 2 ? 1 : -1;
    const speed = (240 + i * 23) * (1 + lt * lt * 0.22);
    const yBase = 50 + i * 98;
    const y = lerp(yBase, 540, collapse);
    const shift = (lt * 240 * (1 + lt * lt * 0.073) + i * 310) % L;
    const alpha = (0.1 + 0.1 * Math.sin(i * 1.7)) * clamp(lt * 1.5) * (1 - collapse) * (1 + P(lt, 2.5, 6) * 0.9);
    ctx.save();
    ctx.translate(W / 2, y); ctx.scale(1 - collapse * 0.85, 1 - collapse * 0.9); ctx.translate(-W / 2, 0);
    for (let g = 0; g < 4; g++) {
      ctx.globalAlpha = alpha * (1 - g * 0.24);
      ctx.fillStyle = P(lt, 3, 6) > 0.3 && i % 3 === 0 ? '#c9a5ff' : C.muted;
      const x0 = dir < 0 ? -shift : shift - L;
      const off = dir * g * speed * 0.012;
      ctx.fillText(LECTURE + LECTURE + LECTURE, x0 - off - (dir > 0 ? L : 0), 0);
    }
    ctx.restore();
  }
  ctx.restore();

  // dark band for legibility
  const band = ctx.createLinearGradient(0, 360, 0, 720);
  band.addColorStop(0, 'rgba(14,16,34,0)'); band.addColorStop(0.5, 'rgba(14,16,34,0.85)'); band.addColorStop(1, 'rgba(14,16,34,0)');
  ctx.fillStyle = band; ctx.fillRect(0, 360, W, 360);

  const out1 = 1 - P(lt, 2.3, 2.6), out2 = 1 - P(lt, 4.8, 5.1), out3 = 1 - P(lt, 6.6, 7.0);
  if (out1 > 0) kinetic('Lectures move fast.', W / 2, 540, lt, 0.35, 0.3, 104, { alpha: out1, glow: 30 });
  if (lt > 2.4 && out2 > 0) {
    kinetic('In a second language,', W / 2, 490, lt, 2.6, 0.22, 88, { alpha: out2 });
    kinetic('they move faster.', W / 2, 600, lt, 3.4, 0.26, 88, { alpha: out2, colorFor: (w) => (w.startsWith('faster') ? C.danger : null), shake: (w) => w.startsWith('faster'), glow: 24 });
  }
  if (lt > 4.9 && out3 > 0) {
    kinetic('By minute three…', W / 2, 490, lt, 5.0, 0.25, 88, { alpha: out3, color: C.muted });
    kinetic("you're lost.", W / 2, 600, lt, 5.7, 0.3, 104, { alpha: out3, colorFor: () => C.danger, glow: 30 });
  }
  // everything collapses into a point of light
  const lp = P(lt, 6.8, 8);
  if (lp > 0) {
    glow(W / 2, H / 2, 40 + 900 * Math.pow(lp, 3), `rgba(200,190,255,${0.9 * lp})`);
    glow(W / 2, H / 2, 20 + 120 * lp, `rgba(255,255,255,${lp})`);
  }
}

// ---- 2. Title ----
const BURST = (() => { const r = rng(11); return Array.from({ length: 160 }, () => ({ a: r() * 6.283, v: 400 + r() * 1300, s: 1 + r() * 3, c: r() > 0.5 })); })();
function sTitle(lt) {
  // shockwave + burst
  for (const [d, w] of [[0, 6], [0.15, 3]]) {
    const p = P(lt, d, d + 1.4);
    if (p > 0 && p < 1) {
      ctx.save(); ctx.globalAlpha = (1 - p) * 0.8; ctx.strokeStyle = grad(0, W, 0); ctx.lineWidth = w * (1 - p) + 1;
      ctx.beginPath(); ctx.arc(W / 2, 470, 60 + 1300 * eo(p), 0, 7); ctx.stroke(); ctx.restore();
    }
  }
  for (const b of BURST) {
    const k = 2.2, d = (b.v * (1 - Math.exp(-k * lt))) / k, a = clamp(1 - lt / 2.4);
    if (a <= 0) break;
    ctx.globalAlpha = a; ctx.fillStyle = b.c ? C.c : C.lav;
    ctx.beginPath(); ctx.arc(W / 2 + Math.cos(b.a) * d, 470 + Math.sin(b.a) * d * 0.7, b.s, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  logo(lt, 470, 1);

  const tg = eo(P(lt, 1.5, 2.2));
  T('Your lectures, made visible.', W / 2, 640 + (1 - tg) * 20, { size: 48, weight: 600, align: 'center', alpha: tg });
  const tg2 = eo(P(lt, 2.2, 2.9));
  T('Fast lectures in a second language  →  simple, live diagrams you understand at a glance.', W / 2, 712, { size: 27, weight: 500, align: 'center', color: C.muted, alpha: tg2 });

  const chips = ['🎤  LIVE SPEECH', '✨  GEMINI', '🗺️  LECTURE MAP', '❓  QUIZ', '💾  SAVED SESSIONS'];
  const ws = chips.map((c) => chipW(c, 18, 2)), gap = 22;
  let x = W / 2 - (ws.reduce((a, b) => a + b, 0) + gap * (chips.length - 1)) / 2;
  chips.forEach((c, i) => {
    const p = eback(P(lt, 3.1 + i * 0.16, 3.6 + i * 0.16));
    ctx.save(); ctx.globalAlpha = clamp(p);
    ctx.translate(0, (1 - clamp(p)) * 30);
    chip(c, x, 820, { size: 18, ls: 2 });
    ctx.restore();
    x += ws[i] + gap;
  });
}
// "🎓 Lectra" wordmark with letter drop, glow and a shine sweep
function logo(lt, y, scale, o = {}) {
  const word = 'Lectra', size = 210 * scale;
  octx.clearRect(0, 0, W, H);
  octx.font = font(size, 800); octx.textBaseline = 'middle'; octx.letterSpacing = '-4px';
  const total = octx.measureText(word).width;
  let x = W / 2 - total / 2 + 60 * scale;
  octx.fillStyle = grad(x, x + total, y, octx, '#8f6bff', '#19dcff');
  for (let i = 0; i < word.length; i++) {
    const ch = word[i], w = octx.measureText(ch).width;
    const p = o.static ? 1 : eback(P(lt, 0.1 + i * 0.07, 0.65 + i * 0.07));
    octx.save(); octx.globalAlpha = clamp(p * 1.5);
    octx.fillText(ch, x, y - (1 - p) * 90);
    octx.restore();
    x += w - 4;
  }
  // shine
  const sp = o.static ? P(lt, 0.8, 1.8) : P(lt, 1.1, 2.0);
  if (sp > 0 && sp < 1) {
    octx.save(); octx.globalCompositeOperation = 'source-atop';
    const sx = lerp(W / 2 - total, W / 2 + total, sp);
    const g = octx.createLinearGradient(sx - 120, 0, sx + 120, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    octx.fillStyle = g; octx.fillRect(0, y - size, W, size * 2); octx.restore();
  }
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.shadowColor = 'rgba(124,92,255,0.8)'; ctx.shadowBlur = 50 + pulse(o.t ?? 0) * 30;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
  // cap
  const cp = o.static ? 1 : eback(P(lt, 0.45, 1.0));
  ctx.save(); ctx.globalAlpha *= clamp(cp) * (o.alpha ?? 1);
  ctx.translate(W / 2 - total / 2 - 70 * scale, y - (1 - cp) * 120); ctx.rotate((1 - cp) * -0.6);
  ctx.font = font(150 * scale, 400); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🎓', 0, 0);
  ctx.restore();
}

// ---- 3. Listen: mic -> Scribe -> live transcript ----
const SPOKEN = ['Photosynthesis is how plants make their own food.', 'Sunlight powers the leaf.', 'The leaf takes in water and carbon dioxide,', 'and it makes glucose and gives off oxygen.'];
function sListen(lt) {
  header(lt, '01', 'LISTEN', null, null);
  const hp = eo(P(lt, 0.15, 0.8));
  ctx.save(); ctx.globalAlpha *= hp; ctx.translate((1 - hp) * -40, 0);
  T('Speak.', 120, 300, { size: 92, weight: 800, ls: -2 });
  T('Lectra listens.', 120, 400, { size: 92, weight: 800, ls: -2, grad: true });
  ctx.restore();
  const sp = eo(P(lt, 0.6, 1.2));
  ['Live transcription with ElevenLabs', 'Scribe v2 Realtime. Audio is relayed', 'by our server, so the API key never', 'reaches the browser.'].forEach((l, i) =>
    T(l, 120, 500 + i * 40, { size: 27, weight: 500, color: C.muted, alpha: sp }));
  const facts = ['Speech counts even before a pause', 'Stop still keeps the last sentence', 'Lecture terms boosted for accuracy'];
  facts.forEach((f, i) => {
    const p = eo(P(lt, 5.4 + i * 0.35, 6.0 + i * 0.35));
    ctx.save(); ctx.globalAlpha *= p; ctx.translate((1 - p) * -30, 0);
    ctx.fillStyle = C.c; ctx.beginPath(); ctx.arc(132, 700 + i * 54, 6, 0, 7); ctx.fill();
    T(f, 156, 700 + i * 54, { size: 26, weight: 600 });
    ctx.restore();
  });

  // app window
  const wp = eo(P(lt, 0.2, 0.9));
  ctx.save(); ctx.globalAlpha *= wp; ctx.translate((1 - wp) * 80, 0);
  const X = 860, Y = 150;
  glass(X, Y, 940, 790, { glow: 50, r: 22, fill: 'rgba(16,15,40,0.92)' });
  T('🎓', X + 36, Y + 52, { size: 30 });
  T('Lectra', X + 80, Y + 52, { size: 32, weight: 800, grad: true });
  T('Your lectures, made visible.', X + 194, Y + 54, { size: 19, color: C.muted, weight: 500 });

  // control row
  const rec = lt >= 1.05, recT = Math.max(0, lt - 1.05);
  glass(X + 30, Y + 98, 880, 84, { r: 14, fill: 'rgba(139,128,255,0.06)' });
  const rx = X + 80, ry = Y + 140;
  ctx.strokeStyle = 'rgba(167,139,250,0.22)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(rx, ry, 24, 0, 7); ctx.stroke();
  if (rec) {
    ctx.strokeStyle = C.c; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(rx, ry, 24, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, recT / 8.5)); ctx.stroke(); ctx.lineCap = 'butt';
  }
  T('⚡', rx, ry + 1, { size: 22, align: 'center' });
  // waveform
  const env = (tt) => rec ? (0.25 + 0.75 * Math.abs(Math.sin(tt * 7.3) * Math.sin(tt * 2.9 + 1))) : 0.06;
  for (let i = 0; i < 54; i++) {
    const bx = X + 130 + i * 10.6;
    const n = 0.5 + 0.5 * Math.sin(i * 1.7 + lt * 13 + Math.sin(i * 0.6 + lt * 5));
    const h = 4 + 52 * env(lt + i * 0.01) * n * Math.sin((i / 53) * Math.PI);
    ctx.fillStyle = rec ? C.c : 'rgba(167,139,250,0.3)';
    ctx.globalAlpha = rec ? 0.55 + 0.45 * n : 1;
    rr(bx, ry - h / 2, 5, h, 2.5); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const secs = Math.floor(recT * 4.2);
  T(`00:${String(secs).padStart(2, '0')}`, X + 822, ry + 1, { size: 24, weight: 700, font: MONO, align: 'right' });
  // mic button
  const mx = X + 870, my = ry;
  if (rec) {
    const pp = (recT % 1.6) / 1.6;
    ctx.save(); ctx.globalAlpha = 0.5 * (1 - pp); ctx.fillStyle = C.danger;
    ctx.beginPath(); ctx.arc(mx, my, 26 + 18 * pp, 0, 7); ctx.fill(); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(mx, my, 26, 0, 7);
  ctx.fillStyle = rec ? C.danger : grad(mx - 26, mx + 26, my); ctx.fill();
  T('🎤', mx, my + 1, { size: 22, align: 'center' });

  // transcript card
  glass(X + 30, Y + 206, 880, 300, { r: 14, fill: 'rgba(139,128,255,0.05)' });
  ctx.fillStyle = C.muted; ctx.fillRect(X + 60, Y + 244, 26, 1.5);
  T('LIVE TRANSCRIPT', X + 98, Y + 245, { size: 16, weight: 700, ls: 3, color: C.muted });
  // words flow in at speaking speed; a sentence turns solid once Scribe commits it
  let wx = X + 60, wy = Y + 300, k = 0, caret = null;
  const wps = 2.7, start = 1.5;
  ctx.font = font(29, 500);
  SPOKEN.forEach((sent, si) => {
    const words = sent.split(' ');
    const doneAt = start + (k + words.length) / wps + 0.45;
    words.forEach((w) => {
      const wt = start + k / wps;
      const ww = tw(w, 29, 500);
      if (wx + ww > X + 870) { wx = X + 60; wy += 46; }
      if (lt >= wt) {
        const committed = lt >= doneAt;
        T(w, wx, wy, { size: 29, weight: committed ? 560 : 500, color: committed ? C.text : C.muted, alpha: clamp((lt - wt) * 6) * (committed ? 1 : 0.85) });
        caret = [wx + ww + 6, wy];
      }
      wx += ww + tw(' ', 29, 500);
      k++;
    });
    // committed tick
    if (lt >= doneAt) T('✓', wx - 4, wy, { size: 20, color: C.ok, alpha: clamp((lt - doneAt) * 4) * (1 - P(lt, doneAt + 1, doneAt + 1.6)) });
  });
  const lastWord = start + k / wps;
  if (caret && lt < lastWord + 0.3 && Math.floor(lt * 2.5) % 2 === 0) { ctx.fillStyle = C.c; ctx.fillRect(caret[0], caret[1] - 16, 3, 32); }

  // pipeline strip
  const boxes = [['🎤  Browser mic', 'PCM16 · 16 kHz'], ['⚡  FastAPI', '/ws/lecture relay'], ['🎧  Scribe v2', 'realtime speech-to-text'], ['📝  Transcript', 'partial → committed']];
  boxes.forEach(([a, b], i) => {
    const p = eback(P(lt, 2.8 + i * 0.3, 3.3 + i * 0.3));
    const bx = X + 30 + i * 226, by = Y + 545;
    ctx.save(); ctx.globalAlpha *= clamp(p); ctx.translate(bx + 100, by + 50); ctx.scale(lerp(0.7, 1, p), lerp(0.7, 1, p)); ctx.translate(-bx - 100, -by - 50);
    glass(bx, by, 200, 100, { r: 14, fill: 'rgba(36,30,79,0.9)', stroke: 'rgba(124,92,255,0.8)', lw: 2 });
    T(a, bx + 100, by + 38, { size: 21, weight: 700, align: 'center' });
    T(b, bx + 100, by + 70, { size: 16, weight: 500, color: C.muted, align: 'center' });
    ctx.restore();
    if (i < 3 && P(lt, 3.3 + i * 0.3, 3.6 + i * 0.3) > 0) {
      const ax = bx + 203, ay = by + 50;
      ctx.strokeStyle = C.edge; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + 18, ay); ctx.stroke();
      arrowHead(ax + 23, ay, 1, 0, 8, C.edge);
    }
  });
  // packets flowing through the pipeline
  if (lt > 4.2) {
    for (let j = 0; j < 7; j++) {
      const f = ((lt * 0.55 + j / 7) % 1);
      const px = X + 130 + f * 680, py = Y + 595 + Math.sin(f * Math.PI * 6) * 2;
      ctx.globalAlpha = Math.sin(f * Math.PI) * clamp((lt - 4.2) * 2);
      glow(px, py, 22, 'rgba(0,212,255,0.8)');
    }
    ctx.globalAlpha = 1;
  }
  T('Every update is saved with the speech it came from.', X + 470, Y + 720, { size: 21, weight: 500, color: C.muted, align: 'center', alpha: eo(P(lt, 4.6, 5.2)) });
  ctx.restore();

  const [cx, cy] = cursorAt(lt, [[0.3, 1500, 900], [0.95, X + 874, Y + 146], [1.7, X + 874, Y + 146], [2.4, 1900, 1000]]);
  cursor(cx, cy, lt, [1.0], 1 - P(lt, 2.0, 2.4));
}

// ---- 4. The live map grows ----
const PHOTO = diagram({
  title: 'Photosynthesis', kind: 'process',
  nodes: [['sun', 'Sunlight', '☀️', 375, 200, 2.7], ['leaf', 'Leaf', '🍃', 375, 370, 2.95], ['water', 'Water', '💧', 135, 200, 3.2], ['glu', 'Glucose', '🍬', 245, 550, 3.45],
    ['co2', 'Carbon dioxide', '', 610, 200, 7.7], ['oxy', 'Oxygen', '', 515, 550, 7.95]],
  edges: [['sun', 'leaf', 'powers', 3.1], ['water', 'leaf', 'goes into', 3.4], ['leaf', 'glu', 'makes', 3.65], ['co2', 'leaf', 'goes into', 8.1], ['leaf', 'oxy', 'gives off', 8.3]],
});
function orb(x, y, r, t, energy) {
  glow(x, y, r * 3.2, `rgba(124,92,255,${0.25 + energy * 0.35})`);
  glow(x, y, r * 1.6, `rgba(0,212,255,${0.15 + energy * 0.35})`);
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, '#9fe9ff'); g.addColorStop(0.6, '#7c5cff'); g.addColorStop(1, '#2a1f73');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * (1 + energy * 0.08 * Math.sin(t * 20)), 0, 7); ctx.fill();
  for (let i = 0; i < 3; i++) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(t * (0.6 + i * 0.35) * (i % 2 ? -1 : 1) + i);
    ctx.strokeStyle = i === 1 ? 'rgba(0,212,255,0.6)' : 'rgba(167,139,250,0.55)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, r * (1.55 + i * 0.22), r * (0.42 + i * 0.08), 0, 0, 7); ctx.stroke();
    ctx.fillStyle = C.c; ctx.beginPath(); ctx.arc(r * (1.55 + i * 0.22), 0, 4, 0, 7); ctx.fill();
    ctx.restore();
  }
}
function sMap(lt) {
  header(lt, '02', 'THE LIVE MAP', 'Every ~20 seconds, the map grows.', 'Gemini adds only what is new. Nothing is redrawn, nothing is dropped.');
  // new speech card
  const cp = eo(P(lt, 0.2, 0.8));
  ctx.save(); ctx.globalAlpha *= cp;
  glass(120, 330, 500, 380, { r: 18 });
  ctx.fillStyle = C.muted; ctx.fillRect(150, 372, 26, 1.5);
  T('NEW SPEECH', 188, 373, { size: 16, weight: 700, ls: 3, color: C.muted });
  const second = lt >= 5.8;
  const chunk = second ? 'The leaf also takes in carbon dioxide, and it gives off oxygen.' : 'Sunlight powers the leaf. The leaf takes in water and makes glucose.';
  const keys = second ? ['leaf', 'carbon', 'dioxide,', 'oxygen.'] : ['Sunlight', 'leaf.', 'water', 'glucose.'];
  const swap = second ? eo(P(lt, 5.8, 6.2)) : 1 - P(lt, 5.5, 5.8);
  const lines = wrap(chunk, 440, 30, 500);
  let k = 0;
  lines.forEach((ln, li) => {
    let x = 150;
    for (const w of ln.split(' ')) {
      const isKey = keys.includes(w);
      const flying = isKey && (second ? P(lt, 6.4, 7.0) : P(lt, 1.0, 1.6));
      T(w, x, 432 + li * 48, { size: 30, weight: isKey ? 700 : 500, color: isKey ? C.c : C.text, alpha: swap });
      const ww = tw(w, 30, isKey ? 700 : 500);
      if (isKey && flying > 0 && flying < 1) {
        // token flies into Gemini
        const sx = x + ww / 2, sy = 432 + li * 48, ex = 805, ey = 470;
        const f = eio(flying), qx = lerp(sx, ex, f), qy = lerp(sy, ey, f) - Math.sin(f * Math.PI) * 120;
        ctx.save(); ctx.globalAlpha = 1 - f * 0.6; T(w.replace(/[.,]/g, ''), qx, qy, { size: 26 - f * 10, weight: 700, color: C.c, align: 'center', glow: 20, glowColor: C.c }); ctx.restore();
      }
      x += ww + tw(' ', 30, 500);
      k++;
    }
  });
  ctx.restore();

  // Gemini core
  const busy = Math.max(P(lt, 1.0, 1.3) * (1 - P(lt, 2.6, 2.9)), P(lt, 6.3, 6.6) * (1 - P(lt, 7.6, 7.9)));
  const op = eo(P(lt, 0.4, 1.0));
  ctx.save(); ctx.globalAlpha *= op;
  orb(805, 470, 58, lt, busy);
  T('Gemini', 805, 585, { size: 28, weight: 750, align: 'center' });
  T('flash-lite · JSON schema', 805, 620, { size: 18, weight: 500, color: C.muted, align: 'center' });
  ctx.restore();
  // JSON card
  const json = lt < 6.3
    ? ['{', '  "new_topic_title": "Photosynthesis",', '  "new_topic_kind": "process",', '  "new_topic": {', '    "nodes": [ 4 boxes ],', '    "edges": [ 3 arrows ] }', '}']
    : ['{', '  "add": {', '    "nodes": [ 2 boxes ],', '    "edges": [ 2 arrows ]', '  },', '  "new_topic": { }', '}'];
  const jStart = lt < 6.3 ? 2.2 : 7.2;
  const jp = P(lt, jStart, jStart + 0.5);
  if (jp > 0) {
    ctx.save(); ctx.globalAlpha *= clamp(jp * 3) * (lt < 6.3 ? 1 - P(lt, 5.8, 6.1) : 1);
    glass(628, 670, 392, 248, { r: 14, fill: 'rgba(8,9,24,0.85)' });
    const chars = Math.floor(jp * 400);
    let used = 0;
    json.forEach((ln, i) => {
      const s = ln.slice(0, Math.max(0, chars - used)); used += ln.length;
      T(s, 648, 700 + i * 31, { size: 16.5, weight: 500, font: MONO, color: /"[a-z_]+":/.test(ln) ? C.lav : C.text });
    });
    ctx.restore();
  }

  // the canvas
  const mp = eo(P(lt, 0.3, 0.9));
  ctx.save(); ctx.globalAlpha *= mp;
  const PX = 1040, PY = 250, PW = 760, PH = 700;
  glass(PX, PY, PW, PH, { r: 18, fill: 'rgba(13,14,33,0.95)', glow: 30 });
  dots(PX, PY, PW, PH);
  // countdown ring + status
  let status, ring;
  if (lt < 1.2) { status = 'Next update in 1s'; ring = 0.95 + lt * 0.04; }
  else if (lt < 2.7) { status = 'Updating…'; ring = 1; }
  else if (lt < 6.0) { const s = 20 - Math.floor((lt - 2.7) * 1.4); status = `Next update in ${s}s`; ring = (lt - 2.7) * 1.4 / 20; }
  else if (lt < 7.7) { status = 'Updating now ⚡'; ring = 1; }
  else { const s = 20 - Math.floor((lt - 7.7) * 1.4); status = `Next update in ${s}s`; ring = (lt - 7.7) * 1.4 / 20; }
  const busyRing = (lt >= 1.2 && lt < 2.7) || (lt >= 6.0 && lt < 7.7);
  const rx = PX + PW - 50, ry = PY + 46;
  ctx.strokeStyle = 'rgba(167,139,250,0.25)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(rx, ry, 24, 0, 7); ctx.stroke();
  ctx.save(); ctx.globalAlpha *= busyRing ? 0.5 + 0.5 * Math.sin(lt * 12) : 1;
  ctx.strokeStyle = C.c; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(rx, ry, 24, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * clamp(ring)); ctx.stroke(); ctx.restore();
  T('⚡', rx, ry + 1, { size: 22, align: 'center' });
  T(status, rx - 42, ry + 1, { size: 20, weight: 600, align: 'right', color: busyRing ? C.c : C.muted });
  T('LECTURE MAP', PX + 30, PY + 46, { size: 16, weight: 700, ls: 3, color: C.muted });
  ctx.save(); ctx.beginPath(); ctx.rect(PX, PY, PW, PH); ctx.clip();
  drawDiagram(PHOTO, lt, { x: PX, y: PY + 30, scale: 1 });
  ctx.restore();
  // sparks from Gemini to each new box
  for (const n of PHOTO.nodes) {
    const f = P(lt, n.t - 0.5, n.t);
    if (f > 0 && f < 1) {
      const q = eio(f);
      glow(lerp(805, PX + n.x, q), lerp(470, PY + 30 + n.y, q) - Math.sin(q * Math.PI) * 80, 26, 'rgba(0,212,255,0.9)');
    }
  }
  ctx.restore();

  const [cx, cy] = cursorAt(lt, [[4.9, 1900, 1000], [5.85, rx + 4, ry + 4], [6.4, rx + 4, ry + 4], [7.1, 1920, 700]]);
  cursor(cx, cy, lt, [6.0], P(lt, 4.9, 5.1) * (1 - P(lt, 6.7, 7.1)));

  const badges = ['✓  Schema-enforced JSON', '✓  Duplicates reused', '✓  Bad arrows dropped', '✓  New boxes glow'];
  badges.forEach((b, i) => {
    const p = eback(P(lt, 9.0 + i * 0.25, 9.5 + i * 0.25));
    ctx.save(); ctx.globalAlpha *= clamp(p); ctx.translate(0, (1 - clamp(p)) * 20);
    chip(b, 120 + (i % 2) * 260, 790 + Math.floor(i / 2) * 62, { size: 17, ls: 0.5, fill: 'rgba(52,211,153,0.10)', stroke: 'rgba(52,211,153,0.5)', color: C.ok });
    ctx.restore();
  });
}

// ---- 5. Four diagram shapes ----
const SHAPES = [
  diagram({ title: 'Photosynthesis', kind: 'process', label: 'PROCESS', desc: 'steps & causes, top to bottom', nodes: [['sun', 'Sunlight', '☀️', 410, 95, 0], ['leaf', 'Leaf', '🍃', 410, 215, 0.3], ['water', 'Water', '💧', 160, 215, 0.6], ['glu', 'Glucose', '🍬', 300, 335, 0.9], ['oxy', 'Oxygen', '', 540, 335, 1.2]], edges: [['sun', 'leaf', 'powers', 0.4], ['water', 'leaf', 'goes into', 0.7], ['leaf', 'glu', 'makes', 1.0], ['leaf', 'oxy', 'gives off', 1.3]] }),
  diagram({ title: 'Aristotle', kind: 'timeline', label: 'TIMELINE', desc: 'events in order, left to right', nodes: [['a', 'Born in Greece', '', 130, 140, 0], ['b', 'Studies with Plato', '', 330, 300, 0.3], ['c', 'Teaches Alexander', '', 520, 140, 0.6], ['d', 'Opens his school', '', 700, 300, 0.9]], edges: [['a', 'b', 'at 17', 0.4], ['b', 'c', 'then', 0.7], ['c', 'd', 'in 335 BC', 1.0]], s: 0.88 }),
  diagram({ title: 'Ecosystem', kind: 'concept', label: 'CONCEPT', desc: 'a main idea and its parts', nodes: [['e', 'Ecosystem', '', 410, 215, 0], ['p', 'Plants', '🌱', 170, 110, 0.25], ['an', 'Animals', '🦊', 650, 110, 0.45], ['w', 'Water', '💧', 160, 330, 0.65], ['s', 'Sunlight', '☀️', 660, 330, 0.85]], edges: [['e', 'p', 'has', 0.35], ['e', 'an', 'has', 0.55], ['e', 'w', 'needs', 0.75], ['e', 's', 'needs', 0.95]] }),
  diagram({ title: 'Plant vs animal cell', kind: 'comparison', label: 'COMPARISON', desc: 'things compared, above their features', nodes: [['pc', 'Plant cell', '🌱', 260, 120, 0], ['ac', 'Animal cell', '🐾', 570, 120, 0.2], ['cw', 'Cell wall', '', 120, 320, 0.4], ['ch', 'Chloroplast', '', 320, 320, 0.6], ['nu', 'Nucleus', '', 520, 320, 0.8], ['me', 'Membrane', '', 710, 320, 1.0]], edges: [['pc', 'cw', 'has', 0.5], ['pc', 'ch', 'has', 0.7], ['pc', 'nu', '', 0.9], ['ac', 'nu', 'has', 0.95], ['pc', 'me', '', 1.1], ['ac', 'me', 'has', 1.15]], s: 0.9 }),
];
const PANELS = [[120, 210], [980, 210], [120, 640], [980, 640]];
const PANEL_W = 820, PANEL_H = 400;
function sShapes(lt) {
  const ov = [W / 2, 625, 1], tgt = (i) => [PANELS[i][0] + PANEL_W / 2, PANELS[i][1] + PANEL_H / 2, 1.85];
  const keys = [[0, ov], [0.7, tgt(0)], [2.7, tgt(0)], [3.4, tgt(1)], [5.4, tgt(1)], [6.1, tgt(2)], [8.1, tgt(2)], [8.8, tgt(3)], [10.4, tgt(3)], [11.2, ov]];
  let cam = ov;
  for (let i = 1; i < keys.length; i++) {
    if (lt <= keys[i][0]) { const p = eio(P(lt, keys[i - 1][0], keys[i][0])); cam = keys[i - 1][1].map((v, j) => lerp(v, keys[i][1][j], p)); break; }
    cam = keys[i][1];
  }
  const starts = [0.7, 3.4, 6.1, 8.8];
  ctx.save();
  ctx.translate(W / 2, H / 2 + 40); ctx.scale(cam[2], cam[2]); ctx.translate(-cam[0], -cam[1]);
  SHAPES.forEach((d, i) => {
    const [x, y] = PANELS[i];
    const active = lt >= starts[i] - 0.3 && lt < (starts[i + 1] ?? 10.4);
    glass(x, y, PANEL_W, PANEL_H, { r: 20, fill: 'rgba(13,14,33,0.94)', glow: active ? 40 : 0, stroke: active ? 'rgba(0,212,255,0.55)' : 'rgba(167,139,250,0.26)' });
    dots(x, y, PANEL_W, PANEL_H, 24, 0.09);
    chip(`${KIND_ICON[d.kind]}  ${d.label}`, x + 22, y + 34, { size: 15, ls: 2 });
    T(d.desc, x + 30 + chipW(`${KIND_ICON[d.kind]}  ${d.label}`, 15, 2), y + 35, { size: 17, color: C.muted, weight: 500 });
    drawDiagram(d, lt - starts[i], { x, y: y + 20, frame: false });
  });
  ctx.restore();
  // title bar
  const tp = eo(P(lt, 0.0, 0.5));
  ctx.save(); ctx.globalAlpha *= tp;
  const band = ctx.createLinearGradient(0, 0, 0, 190);
  band.addColorStop(0, 'rgba(14,16,34,0.95)'); band.addColorStop(1, 'rgba(14,16,34,0)');
  ctx.fillStyle = band; ctx.fillRect(0, 0, W, 190);
  chip('03  ·  THE RIGHT SHAPE', W / 2, 62, { align: 'center' });
  T('Gemini picks the shape that fits each topic.', W / 2, 128, { size: 52, weight: 750, align: 'center', ls: -1 });
  ctx.restore();
}

// ---- 6. Simple English + skipping the noise ----
const MUD = diagram({ title: 'Mud baths', kind: 'process', nodes: [['m', 'Mud', '', 160, 120, 1.0], ['s', 'Skin', '', 520, 120, 1.3]], edges: [['m', 's', 'protects', 1.5]], s: 1.3 });
const HARD = diagram({ title: '', kind: 'process', nodes: [['a', 'High volume to surface area', '', 330, 90, 0.5], ['b', 'Acts like a sponge', '', 330, 220, 0.75]], edges: [], s: 1.05 });
const ELE = diagram({ title: 'Elephant skin', kind: 'process', nodes: [['e', 'Elephant', '🐘', 90, 0, 6.2], ['m', 'Mud', '', 340, 0, 6.45], ['s', 'Skin', '', 560, 0, 6.7]], edges: [['e', 'm', 'rolls in', 6.5], ['m', 's', 'protects', 6.8]], s: 1.0 });
function sSimple(lt) {
  const a = 1 - P(lt, 3.7, 4.0), b = P(lt, 3.95, 4.3);
  if (a > 0) {
    ctx.save(); ctx.globalAlpha *= a;
    header(lt, '04', 'SIMPLE ENGLISH', 'Every arrow reads as a simple sentence.', 'Short everyday words for students still learning the language.');
    glass(120, 390, 780, 480, { r: 20, stroke: 'rgba(255,92,122,0.4)' });
    T('✕  Hard to follow', 160, 440, { size: 28, weight: 700, color: C.danger });
    drawDiagram(HARD, lt, { x: 180, y: 520, frame: false, noGlow: true, stroke: 'rgba(255,92,122,0.7)', fill: 'rgba(255,92,122,0.08)', strike: 1.6 });
    glass(1020, 390, 780, 480, { r: 20, stroke: 'rgba(52,211,153,0.45)', glow: 30, glowColor: 'rgba(52,211,153,0.3)' });
    T('✓  Simple and true', 1060, 440, { size: 28, weight: 700, color: C.ok });
    drawDiagram(MUD, lt, { x: 1060, y: 500, frame: false });
    // read the arrow aloud
    const words = [['Mud', 2.2], ['protects', 2.55], ['skin.', 2.9]];
    let x = 1410 - tw('Mud protects skin.', 54, 750) / 2;
    words.forEach(([w, t0]) => {
      const p = eo(P(lt, t0, t0 + 0.3));
      T(w, x, 780 + (1 - p) * 20, { size: 54, weight: 750, alpha: p, color: w === 'protects' ? C.c : C.text });
      x += tw(w + ' ', 54, 750);
    });
    ctx.restore();
  }
  if (b > 0) {
    ctx.save(); ctx.globalAlpha *= b;
    header(lt - 4, '04', 'SIMPLE ENGLISH', 'Small talk is skipped.', 'Greetings, logistics and adverts teach nothing, so they add nothing.');
    // the gate
    const gx = 1000;
    const gl = ctx.createLinearGradient(0, 350, 0, 1000);
    gl.addColorStop(0, 'rgba(0,212,255,0)'); gl.addColorStop(0.5, 'rgba(0,212,255,0.9)'); gl.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = gl; ctx.fillRect(gx - 2, 350, 4, 650);
    glow(gx, 680, 200, 'rgba(0,212,255,0.12)');
    T('✨ Gemini', gx, 330, { size: 22, weight: 700, align: 'center', color: C.c });
    const bubbles = [['“Can everyone hear me?”', false, 4.3], ['“Don’t forget to subscribe!”', false, 4.75], ['“Elephants roll in mud to protect their skin.”', true, 5.2], ['“This video will improve your English.”', false, 5.65]];
    bubbles.forEach(([s, real, t0], i) => {
      const y = 430 + i * 125;
      const go = eio(P(lt, t0, t0 + 0.8));
      const w = tw(s, 25, 600) + 44;
      let x = lerp(-w, gx - 40 - w, go), alpha = 1, fall = 0;
      if (!real) {
        const fp = P(lt, t0 + 0.85, t0 + 1.6);
        fall = eio(fp) * 120; alpha = 1 - fp * 0.75;
      } else {
        const pass = eio(P(lt, t0 + 0.8, t0 + 1.2));
        x = lerp(x, gx + 40, pass); alpha = 1 - pass;
      }
      if (go <= 0) return;
      ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(0, fall);
      glass(x, y - 32, w, 64, { r: 32, fill: real ? 'rgba(0,212,255,0.12)' : 'rgba(255,255,255,0.05)', stroke: real ? 'rgba(0,212,255,0.7)' : 'rgba(167,139,250,0.3)' });
      T(s, x + 22, y + 1, { size: 25, weight: 600, color: real ? C.text : C.muted });
      if (!real && lt > t0 + 0.85) {
        const sp = eo(P(lt, t0 + 0.85, t0 + 1.15));
        ctx.strokeStyle = C.danger; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x + 14, y); ctx.lineTo(x + 14 + (w - 28) * sp, y); ctx.stroke();
        chip('SKIPPED', x + w + 14, y, { size: 14, ls: 2, fill: 'rgba(255,92,122,0.12)', stroke: 'rgba(255,92,122,0.6)', color: C.danger, alpha: sp });
      }
      ctx.restore();
    });
    drawDiagram(ELE, lt, { x: 1130, y: 680 });
    ctx.restore();
  }
}

// ---- 7. Quiz built from the map ----
const QMAP = [
  diagram({ title: 'Photosynthesis', kind: 'process', s: 0.92, nodes: [['sun', 'Sunlight', '☀️', 200, 120, 0.1], ['leaf', 'Leaf', '🍃', 200, 290, 0.25], ['water', 'Water', '💧', 420, 290, 0.4], ['glu', 'Glucose', '🍬', 120, 460, 0.55], ['oxy', 'Oxygen', '', 330, 460, 0.7]], edges: [['sun', 'leaf', 'powers', 0.3], ['water', 'leaf', 'goes into', 0.45], ['leaf', 'glu', 'makes', 0.6], ['leaf', 'oxy', 'gives off', 0.75]] }),
  diagram({ title: 'Elephant skin', kind: 'concept', s: 0.92, nodes: [['ele', 'Elephant', '🐘', 700, 120, 0.4], ['mud', 'Mud', '', 700, 290, 0.55], ['skin', 'Skin', '', 700, 460, 0.7], ['ears', 'Ears', '👂', 900, 210, 0.85], ['blood', 'Blood', '', 900, 390, 1.0]], edges: [['ele', 'mud', 'rolls in', 0.6], ['mud', 'skin', 'protects', 0.75], ['ele', 'ears', 'has', 0.9], ['ears', 'blood', 'cool', 1.05]] }),
];
function sQuiz(lt) {
  header(lt, '05', 'QUIZ', 'A quiz made from the map itself.', 'Fill-the-gap questions from the map’s own arrows. No extra AI call.');
  const MX = 120, MY = 320;
  glass(MX, MY, 1040, 660, { r: 18, fill: 'rgba(13,14,33,0.95)' });
  dots(MX, MY, 1040, 660);
  const q2 = lt >= 5.2;
  const hl = new Set();
  if (lt >= 3.0 && !q2) { hl.add('sun'); hl.add('leaf'); hl.add('sun>leaf'); }
  if (lt >= 7.4) { hl.add('mud'); hl.add('skin'); hl.add('mud>skin'); }
  for (const d of QMAP) drawDiagram(d, lt, { x: MX + 30, y: MY + 60, hl, noGlow: true });

  // quiz panel
  const QX = 1210, QY = 320, QW = 590;
  glass(QX, QY, QW, 660, { r: 18, glow: 30 });
  ctx.fillStyle = C.muted; ctx.fillRect(QX + 30, QY + 48, 26, 1.5);
  T('QUIZ', QX + 68, QY + 49, { size: 18, weight: 700, ls: 3, color: C.muted });
  const right = (lt >= 3.0 ? 1 : 0) + (lt >= 7.4 ? 1 : 0), total = right;
  if (total) T(`${right} / ${total}`, QX + QW - 30, QY + 49, { size: 24, weight: 750, align: 'right', color: C.ok, glow: 16, glowColor: C.ok });
  const qp = q2 ? eo(P(lt, 5.2, 5.6)) : eo(P(lt, 0.6, 1.1));
  ctx.save(); ctx.globalAlpha *= qp; ctx.translate((1 - qp) * 30, 0);
  T('Fill the gap:', QX + 30, QY + 110, { size: 22, weight: 500, color: C.muted });
  const blank = '______';
  if (!q2) {
    T('☀️ Sunlight powers', QX + 30, QY + 168, { size: 36, weight: 700 });
    T(lt >= 3.0 ? '🍃 Leaf' : blank, QX + 30 + tw('☀️ Sunlight powers ', 36, 700), QY + 168, { size: 36, weight: 700, color: lt >= 3.0 ? C.ok : C.c });
  } else {
    T(lt >= 7.4 ? 'Mud' : blank, QX + 30, QY + 168, { size: 36, weight: 700, color: lt >= 7.4 ? C.ok : C.c });
    T('protects Skin', QX + 30 + tw((lt >= 7.4 ? 'Mud' : blank) + ' ', 36, 700), QY + 168, { size: 36, weight: 700 });
  }
  const opts = q2 ? ['Mud', '👂 Ears', '☀️ Sunlight', '🍬 Glucose'] : ['💧 Water', '🍃 Leaf', '🍬 Glucose', 'Oxygen'];
  const ans = q2 ? 0 : 1, at = q2 ? 7.4 : 3.0;
  opts.forEach((o, i) => {
    const y = QY + 230 + i * 78;
    const done = lt >= at;
    const isAns = i === ans;
    button(o, QX + 30, y, QW - 60, 62, {
      textAlign: 'left',
      fill: done && isAns ? 'rgba(52,211,153,0.16)' : undefined,
      stroke: done && isAns ? C.ok : undefined, lw: done && isAns ? 2.5 : 1.5,
      color: done && isAns ? C.ok : done ? 'rgba(167,139,250,0.5)' : C.lav,
    });
  });
  if (lt >= at) {
    const fp = eo(P(lt, at, at + 0.4));
    T(q2 ? '✅ Right!  Mud protects Skin.' : '✅ Right!  Sunlight powers Leaf.', QX + 30, QY + 565, { size: 25, weight: 650, color: C.ok, alpha: fp });
    if (!q2) button('Next question →', QX + 30, QY + 595, 260, 50, { primary: true, size: 20, alpha: fp });
  }
  ctx.restore();

  const [cx, cy] = cursorAt(lt, [[1.2, 1900, 1000], [2.8, QX + 200, QY + 230 + 78 + 34], [3.6, QX + 200, QY + 230 + 78 + 34], [4.8, QX + 150, QY + 622], [6.4, QX + 150, QY + 622], [7.2, QX + 160, QY + 230 + 34], [8.2, QX + 160, QY + 230 + 34], [9.2, 1950, 1100]]);
  cursor(cx, cy, lt, [3.0, 5.1, 7.4], P(lt, 1.2, 1.5));
}

// ---- 8. Paste a transcript ----
const PARAS = [
  'Elephants are the largest land animals. An adult can weigh six tonnes.',
  'Their skin is thick and wrinkled. The wrinkles hold water and keep them cool.',
  'Elephants roll in mud. The mud protects their skin from the sun.',
  'Big ears help them cool down. Blood cools as it flows through the ears.',
  'A baby elephant can stand an hour after it is born, and drinks milk.',
  'The herd is led by the oldest female. She remembers where to find water.',
];
const MINI = [
  ['Size', [['Elephant', '🐘'], ['Land animal', ''], ['Adult', ''], ['Six tonnes', '']]],
  ['Thick skin', [['Skin', ''], ['Wrinkles', ''], ['Water', '💧'], ['Cool body', '']]],
  ['Mud baths', [['Elephant', '🐘'], ['Mud', ''], ['Skin', ''], ['Sun', '☀️']]],
  ['Big ears', [['Ears', '👂'], ['Blood', ''], ['Heat', ''], ['Cool body', '']]],
  ['Baby elephant', [['Baby', '🐘'], ['Stands up', ''], ['Milk', '🥛']]],
  ['The herd', [['Herd', ''], ['Oldest female', ''], ['Water', '💧']]],
].map(([title, boxes], i) => {
  const t0 = 2.0 + i * 0.62;
  const pos = boxes.length === 4 ? [[-62, -30], [70, -30], [-62, 50], [70, 50]] : [[0, -38], [-62, 48], [70, 48]];
  return diagram({
    title, kind: 'concept', s: 0.6,
    nodes: boxes.map(([l, e], k) => [String(k), l, e, pos[k][0], pos[k][1], t0 + 0.15 + k * 0.08]),
    edges: boxes.length === 4 ? [['0', '1', '', t0 + 0.4], ['0', '2', '', t0 + 0.45], ['2', '3', '', t0 + 0.5]] : [['0', '1', '', t0 + 0.4], ['0', '2', '', t0 + 0.45]],
  });
});
function sPaste(lt) {
  header(lt, '06', 'NO MIC? PASTE IT.', 'Paste a transcript, press ⚡', 'Each paragraph tends to become its own topic, built a paragraph at a time.');
  const EX = 120, EY = 330, EW = 700, EH = 640;
  glass(EX, EY, EW, EH, { r: 18 });
  ctx.fillStyle = C.muted; ctx.fillRect(EX + 30, EY + 42, 26, 1.5);
  T('LIVE TRANSCRIPT  ·  ✎ EDIT', EX + 68, EY + 43, { size: 16, weight: 700, ls: 3, color: C.muted });
  rr(EX + 24, EY + 72, EW - 48, EH - 160, 12); ctx.fillStyle = 'rgba(8,9,24,0.6)'; ctx.fill();
  const reveal = eo(P(lt, 0.5, 1.0));
  ctx.save(); ctx.beginPath(); ctx.rect(EX + 24, EY + 72, EW - 48, (EH - 160) * reveal); ctx.clip();
  let y = EY + 104;
  PARAS.forEach((p, i) => {
    const t0 = 2.0 + i * 0.62;
    const active = lt >= t0 && lt < t0 + 0.62;
    const done = lt >= t0 + 0.62;
    const lines = wrap(p, EW - 100, 20, 500);
    if (active) { rr(EX + 34, y - 18, EW - 68, lines.length * 28 + 10, 8); ctx.fillStyle = 'rgba(0,212,255,0.12)'; ctx.fill(); }
    lines.forEach((ln, j) => T(ln, EX + 46, y + j * 28, { size: 20, weight: 500, color: done ? C.muted : C.text }));
    y += lines.length * 28 + 20;
  });
  ctx.restore();
  // ⚡ build button
  const bx = EX + EW - 230, by = EY + EH - 70;
  button('⚡  Build the map', bx, by - 26, 200, 52, { primary: true, size: 20, alpha: eo(P(lt, 0.9, 1.2)) });
  const [cx, cy] = cursorAt(lt, [[0.6, 1000, 1100], [1.4, bx + 100, by], [2.0, bx + 100, by], [2.8, 1000, 1150]]);
  cursor(cx, cy, lt, [1.5], P(lt, 0.6, 0.8) * (1 - P(lt, 2.4, 2.8)));

  // the map fills topic by topic
  const MX = 870, MY = 330, MW = 930, MH = 640;
  glass(MX, MY, MW, MH, { r: 18, fill: 'rgba(13,14,33,0.95)', glow: 24 });
  dots(MX, MY, MW, MH);
  let topics = 0, boxes = 0;
  MINI.forEach((d, i) => {
    const cx2 = MX + 160 + (i % 3) * 305, cy2 = MY + 175 + Math.floor(i / 3) * 270;
    drawDiagram(d, lt, { x: cx2, y: cy2 });
    if (lt >= d.nodes[0].t) topics++;
    boxes += d.nodes.filter((n) => lt >= n.t).length;
    // paragraph packet flying over
    const f = P(lt, d.nodes[0].t - 0.45, d.nodes[0].t);
    if (f > 0 && f < 1) glow(lerp(EX + EW - 40, cx2, eio(f)), lerp(EY + 120 + i * 80, cy2, eio(f)) - Math.sin(f * Math.PI) * 80, 30, 'rgba(0,212,255,0.9)');
  });
  T(`${topics} topics  ·  ${boxes} boxes`, MX + MW - 30, MY + 40, { size: 24, weight: 750, align: 'right', color: topics ? C.c : C.muted });
  T('LECTURE MAP', MX + 30, MY + 40, { size: 16, weight: 700, ls: 3, color: C.muted });
  const cp = eo(P(lt, 6.0, 6.5));
  T('Real run: a 6-paragraph talk became 6 topics and 22 boxes in about a minute.', W / 2, 1020, { size: 23, weight: 600, align: 'center', color: C.muted, alpha: cp });
}

// ---- 9. Architecture ----
function card(x, y, w, h, icon, title, lines, p, o = {}) {
  if (p <= 0) return;
  ctx.save(); ctx.globalAlpha *= clamp(p * 1.5);
  const s = lerp(0.85, 1, eback(clamp(p)));
  ctx.translate(x + w / 2, y + h / 2); ctx.scale(s, s); ctx.translate(-x - w / 2, -y - h / 2);
  glass(x, y, w, h, { r: 18, glow: 26, fill: o.fill || 'rgba(26,23,62,0.94)', stroke: o.stroke || 'rgba(124,92,255,0.75)', lw: 2 });
  T(icon, x + 28, y + 44, { size: 32 });
  T(title, x + 76, y + 44, { size: 28, weight: 750 });
  lines.forEach((l, i) => T(l, x + 30, y + 92 + i * 36, { size: 20, weight: 500, color: C.muted }));
  ctx.restore();
}
function link(x1, y1, x2, y2, lt, p, label, both = true) {
  if (p <= 0) return;
  ctx.save(); ctx.globalAlpha *= clamp(p * 2);
  ctx.setLineDash([8, 8]); ctx.lineDashOffset = -lt * 40;
  ctx.strokeStyle = 'rgba(160,158,196,0.7)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
  const n = 3;
  for (let i = 0; i < n; i++) {
    const f = (lt * 0.7 + i / n) % 1;
    glow(lerp(x1, x2, f), lerp(y1, y2, f), 18, 'rgba(0,212,255,0.9)');
    if (both) { const g = (lt * 0.6 + i / n + 0.5) % 1; glow(lerp(x2, x1, g), lerp(y2, y1, g), 14, 'rgba(167,139,250,0.9)'); }
  }
  if (label) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.font = font(17, 650); const w = ctx.measureText(label).width + 22;
    rr(mx - w / 2, my - 15, w, 30, 15); ctx.fillStyle = C.bg; ctx.fill();
    ctx.strokeStyle = 'rgba(167,139,250,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    T(label, mx, my + 1, { size: 17, weight: 650, align: 'center', color: C.text });
  }
  ctx.restore();
}
function sArch(lt) {
  header(lt, '07', 'UNDER THE HOOD', 'Built for a live lecture.', null);
  const p = (t) => P(lt, t, t + 0.5);
  link(560, 500, 720, 500, lt, p(1.0), 'audio ↑ map ↓');
  link(1180, 390, 1360, 325, lt, p(1.5), 'PCM');
  link(1180, 500, 1360, 560, lt, p(1.9), 'speech');
  link(1180, 610, 1360, 795, lt, p(2.3), 'map', false);
  link(950, 670, 950, 790, lt, p(2.7), 'merge');
  card(120, 330, 440, 340, '🌐', 'Browser', ['🎤  Mic → PCM16, 16 kHz', '🗺️  Cytoscape.js map', '❓  Quiz from the arrows', '📄  Source per update', '🔁  Resumes on reconnect', '✎  Paste a transcript'], p(0.3));
  card(720, 330, 460, 340, '⚡', 'FastAPI', ['WebSocket /ws/lecture', 'Map grows every 20 s, or ⚡', '8 s floor protects quota', '30 s timeout, then retry', 'REST API for sessions', 'Stop flushes the last words'], p(0.6), { stroke: 'rgba(0,212,255,0.8)' });
  card(1360, 230, 440, 190, '🎧', 'ElevenLabs Scribe', ['v2 Realtime · VAD commits', 'Key lecture terms boosted'], p(1.3));
  card(1360, 465, 440, 190, '✨', 'Gemini', ['response_json_schema', '4 diagram kinds, simple English'], p(1.7));
  card(1360, 700, 440, 190, '💾', 'SQLite', ['sessions · diagrams', 'transcript chunks'], p(2.1));
  card(720, 790, 460, 160, '🧩', 'topics.py', ['dedupe · drop bad arrows', '10 boxes / 5 min per topic'], p(2.5), { fill: 'rgba(30,22,70,0.95)' });
}

// ---- 10. Proof ----
function sProof(lt) {
  const tp = eo(P(lt, 0, 0.5));
  ctx.save(); ctx.globalAlpha *= tp;
  chip('08  ·  VERIFIED', W / 2, 150, { align: 'center' });
  T('Checked end to end, with real speech.', W / 2, 235, { size: 60, weight: 760, align: 'center', ls: -1 });
  ctx.restore();
  const stats = [[45, 'browser checks', 'real page, real mouse'], [26, 'WebSocket checks', 'live loop, resume, retry'], [22, 'map-merge checks', 'boxes only ever added'], [10, 'layout checks', 'one per diagram kind']];
  stats.forEach(([n, a, b], i) => {
    const t0 = 0.5 + i * 0.45, p = P(lt, t0, t0 + 1.0);
    if (p <= 0) return;
    const x = 300 + i * 440, y = 500;
    ctx.save(); ctx.globalAlpha *= clamp(p * 3);
    glass(x - 190, y - 170, 380, 350, { r: 24, glow: 30 + pulse(lt + 82) * 30 });
    T(String(Math.round(n * eo(p))), x, y - 40, { size: 150, weight: 800, align: 'center', grad: true, glow: 30 });
    T(a, x, y + 70, { size: 28, weight: 700, align: 'center' });
    T(b, x, y + 112, { size: 21, weight: 500, align: 'center', color: C.muted });
    ctx.restore();
  });
  const lp = eo(P(lt, 3.0, 3.6));
  T('✅  Mic → Scribe → Gemini → diagram, verified live', W / 2, 800, { size: 30, weight: 650, align: 'center', alpha: lp });
  T('About 3 Gemini calls a minute: well inside the free tier', W / 2, 856, { size: 26, weight: 500, align: 'center', color: C.muted, alpha: eo(P(lt, 3.5, 4.1)) });
}

// ---- 11. Finale ----
function sFinale(lt) {
  // the diagrams drift around the logo like a constellation
  const spots = [[260, 250, -0.08], [1660, 260, 0.07], [270, 850, 0.06], [1650, 840, -0.07]];
  SHAPES.forEach((d, i) => {
    const [x, y, r] = spots[i];
    ctx.save();
    ctx.globalAlpha = 0.28 * eo(P(lt, 0.3 + i * 0.15, 1.3 + i * 0.15)) * (1 - P(lt, 6.6, 7.6));
    ctx.translate(x + Math.sin(lt * 0.5 + i) * 18, y + Math.cos(lt * 0.4 + i) * 14); ctx.rotate(r + Math.sin(lt * 0.3 + i) * 0.03); ctx.scale(0.5, 0.5);
    drawDiagram(d, 99, { x: -410, y: -200, frame: false, noGlow: true });
    ctx.restore();
  });
  for (const [d, w] of [[0, 6], [0.12, 3]]) {
    const p = P(lt, d, d + 1.5);
    if (p > 0 && p < 1) {
      ctx.save(); ctx.globalAlpha = (1 - p) * 0.8; ctx.strokeStyle = grad(0, W, 0); ctx.lineWidth = w * (1 - p) + 1;
      ctx.beginPath(); ctx.arc(W / 2, 440, 60 + 1300 * eo(p), 0, 7); ctx.stroke(); ctx.restore();
    }
  }
  const fade = 1 - P(lt, 6.8, 7.8);
  ctx.save(); ctx.globalAlpha *= fade;
  logo(lt, 430, 1, { t: lt + 88 });
  const a = eo(P(lt, 1.2, 1.8));
  T('Understand any lecture at a glance.', W / 2, 610 + (1 - a) * 20, { size: 54, weight: 700, align: 'center', alpha: a });
  T('Live speech  →  simple diagrams  →  a quiz to check yourself', W / 2, 685, { size: 28, weight: 500, align: 'center', color: C.muted, alpha: eo(P(lt, 1.8, 2.4)) });
  const gp = eback(P(lt, 2.6, 3.2));
  ctx.save(); ctx.globalAlpha *= clamp(gp); ctx.translate(W / 2, 800); ctx.scale(lerp(0.7, 1, gp), lerp(0.7, 1, gp));
  const label = 'github.com/firdavz/lectra', w = tw(label, 30, 700) + 90;
  rr(-w / 2, -36, w, 72, 36); ctx.fillStyle = grad(-w / 2, w / 2, 0); ctx.shadowColor = 'rgba(124,92,255,0.7)'; ctx.shadowBlur = 40; ctx.fill(); ctx.shadowBlur = 0;
  T('⭐', -w / 2 + 34, 1, { size: 26, align: 'center' });
  T(label, 22, 1, { size: 30, weight: 700, align: 'center', color: '#fff' });
  ctx.restore();
  ctx.restore();
}

// =====================================================================
const SCENES = [
  [0, 8, sProblem], [8, 14, sTitle], [14, 24, sListen], [24, 36, sMap], [36, 48, sShapes],
  [48, 56, sSimple], [56, 66, sQuiz], [66, 74, sPaste], [74, 82, sArch], [82, 88, sProof], [88, 96, sFinale],
];
const CUTS = [8, 14, 24, 36, 48, 56, 66, 74, 82, 88];
const HARD_CUTS = new Set([8, 88]);

function renderFrame(t) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
  background(t);
  vignette();
  // camera shake on the two big hits
  let sx = 0, sy = 0;
  for (const h of [8, 56, 88]) {
    const k = P(t, h, h + 0.5);
    if (k > 0 && k < 1) { sx += Math.sin(t * 90) * 14 * (1 - k); sy += Math.cos(t * 77) * 10 * (1 - k); }
  }
  for (const [a, b, fn] of SCENES) {
    if (t < a - 0.0001 || t >= b + 0.35) continue;
    const lt = t - a;
    const fin = HARD_CUTS.has(a) ? 1 : eo(P(lt, 0, 0.4));
    const fout = HARD_CUTS.has(b) ? (t < b ? 1 : 0) : 1 - P(t, b - 0.05, b + 0.3);
    const alpha = fin * fout;
    if (alpha <= 0) continue;
    ctx.save();
    ctx.translate(sx, sy);
    const z = lerp(1.03, 1, fin) * lerp(0.97, 1, fout);
    ctx.translate(W / 2, H / 2); ctx.scale(z, z); ctx.translate(-W / 2, -H / 2);
    ctx.globalAlpha = alpha;
    fn(lt);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  // flashes on cuts
  for (const c of CUTS) {
    const k = t - c;
    if (k >= 0 && k < 0.6) {
      ctx.fillStyle = `rgba(235,230,255,${(HARD_CUTS.has(c) ? 0.9 : 0.16) * Math.exp(-k * 9)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }
  // progress line
  ctx.fillStyle = grad(0, W, 0); ctx.globalAlpha = 0.7 * (1 - P(t, 94, 95.5));
  ctx.fillRect(0, H - 4, W * (t / DUR), 4);
  ctx.globalAlpha = 1;
  // fade to black
  const fb = P(t, 94.6, 96);
  if (fb > 0) { ctx.fillStyle = `rgba(0,0,0,${fb})`; ctx.fillRect(0, 0, W, H); }
}
window.renderFrame = renderFrame;
window.MV_DURATION = DUR;

(async () => {
  await document.fonts.ready;
  renderFrame(0.01);
  window.mvReady = true;
  if (location.search.includes('render')) return;
  // live playback, synced to the music
  const audio = document.getElementById('music'), btn = document.getElementById('play');
  btn.hidden = false;
  renderFrame(9.5);
  btn.onclick = () => {
    btn.hidden = true;
    audio.currentTime = 0; audio.play();
    const loop = () => { renderFrame(Math.min(audio.currentTime, DUR - 0.001)); if (!audio.ended) requestAnimationFrame(loop); else btn.hidden = false; };
    requestAnimationFrame(loop);
  };
})();
