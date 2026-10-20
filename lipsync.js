// RECAST AI+ v0.6 — audio-driven lip-sync for changed lines.
// The new voice take drives the recast face's mouth: loudness → jaw opening, spectral balance → lip shape
// (spread "ee/s" vs rounded "oo/o"), with attack/release smoothing. The original actor's mouth motion is
// neutralised (closed) for that line, then the new opening is applied to the lips and jaw landmarks before
// the face mesh is warped, and the mouth interior (dark cavity, teeth, tongue) is drawn in.
import { fft } from './beats.js';

export const INNER_LIPS = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
const UPPER_INNER = new Set([191, 80, 81, 82, 13, 312, 311, 310, 415]);
const UPPER_OUTER = new Set([185, 40, 39, 37, 0, 267, 269, 270, 409]);
const LIP_SET = new Set([61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 185, 40, 39, 37, 0, 267, 269, 270, 409, ...INNER_LIPS]);

/** Per-video-frame mouth parameters from a mono take. Returns { open: Float32Array, wide: Float32Array } (0..1, -1..1). */
export function mouthCurve(x, sr, fps, { attack = 0.035, release = 0.09 } = {}) {
  const n = Math.max(1, Math.ceil(x.length / sr * fps)), hop = sr / fps, N = 1024;
  const db = new Float32Array(n), tilt = new Float32Array(n), re = new Float32Array(N), im = new Float32Array(N);
  let peak = -120;
  for (let f = 0; f < n; f++) {
    const c = Math.round(f * hop + hop / 2), a = Math.max(0, c - N / 2);
    let e = 0, cnt = 0;
    for (let i = 0; i < N; i++) { const v = a + i < x.length ? x[a + i] : 0; re[i] = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; e += v * v; cnt++; }
    db[f] = 10 * Math.log10(e / cnt + 1e-12); peak = Math.max(peak, db[f]);
    fft(re, im);
    let lo = 0, hi = 0; const bin = sr / N;
    for (let k = 1; k < N / 2; k++) { const hz = k * bin, m = re[k] * re[k] + im[k] * im[k]; if (hz >= 200 && hz < 1000) lo += m; else if (hz >= 1800 && hz < 5000) hi += m; }
    tilt[f] = Math.log10((hi + 1e-12) / (lo + 1e-12));
  }
  const floor = peak - 32, open = new Float32Array(n), wide = new Float32Array(n);
  const ka = 1 - Math.exp(-1 / (fps * attack)), kr = 1 - Math.exp(-1 / (fps * release));
  let o = 0, w = 0;
  for (let f = 0; f < n; f++) {
    const target = Math.max(0, Math.min(1, (db[f] - floor) / 28)) ** 1.3;
    o += (target - o) * (target > o ? ka : kr); open[f] = o;
    const wt = target > 0.08 ? Math.max(-1, Math.min(1, (tilt[f] + 0.6) / 0.9)) : 0;
    w += (wt - w) * kr; wide[f] = w;
  }
  return { open, wide };
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Close the source mouth and open it by `open`, shaped by `wide`. L: Float32Array(478*3) normalized; aspect = H/W.
 *  neutral: 0..1 how much of the original actor's opening to remove. Returns a new array. */
export function applyMouth(L, { open = 0, wide = 0 }, { neutral = 1, aspect = 1 } = {}) {
  const out = Float32Array.from(L), X = i => L[i * 3], Y = i => L[i * 3 + 1] * aspect;
  const cx = (X(61) + X(291)) / 2, mouthW = Math.hypot(X(291) - X(61), Y(291) - Y(61)) || 1e-3;
  const lineY = (Y(61) + Y(291)) / 2, chinY = Y(152), faceHalf = Math.abs(X(454) - X(234)) / 2 || mouthW;
  const gap = Math.max(0, Y(14) - Y(13)), drop = open * 0.42 * mouthW, lift = open * 0.07 * mouthW, spread = wide * 0.08 * mouthW * (0.6 + 0.4 * (1 - open));
  for (let i = 0; i < L.length / 3; i++) {
    const x = X(i), y = Y(i);
    let dy = 0, dx = 0;
    if (y > lineY - 0.02 * mouthW && !UPPER_INNER.has(i) && !UPPER_OUTER.has(i)) {
      // lower lip and jaw: full weight near the lower lip, fading toward the jaw corners
      const v = (y - lineY) / Math.max(1e-3, chinY - lineY), hf = smooth(0, 1, 1 - Math.abs(x - cx) / (faceHalf * 1.05)) ** 0.8;
      const wj = (v <= 0.35 ? smooth(-0.05, 0.12, v) : 1 - 0.3 * smooth(0.35, 1, v)) * hf * (i === 61 || i === 291 ? 0.35 : 1);
      dy = (-gap * neutral + drop) * wj;
    } else if (UPPER_INNER.has(i) || UPPER_OUTER.has(i)) dy = -lift * (UPPER_INNER.has(i) ? 1 : 0.6);
    if (LIP_SET.has(i)) dx = ((x - cx) / (mouthW / 2)) * spread;
    out[i * 3] = x + dx; out[i * 3 + 1] = (y + dy) / aspect;
  }
  return out;
}

/** Inner-mouth polygon (pixels) from warped face points P (flat xy). */
export const innerPolygon = P => INNER_LIPS.map(i => [P[i * 2], P[i * 2 + 1]]);

/** browser: draw the mouth cavity, upper teeth and tongue inside the inner-lip polygon. */
export function drawMouthInterior(ctx, P, open, { teeth = '#e9e3d8', cavity = '#2a1014', tongue = '#9b3a40' } = {}) {
  if (open < 0.03) return;
  const poly = innerPolygon(P); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = x1 - x0, hh = y1 - y0; if (w < 2 || hh < 1) return;
  ctx.save(); ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.clip();
  const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, '#120607'); g.addColorStop(0.5, cavity); g.addColorStop(1, '#3a1518');
  ctx.fillStyle = g; ctx.fillRect(x0 - 2, y0 - 2, w + 4, hh + 4);
  ctx.fillStyle = tongue; ctx.globalAlpha = Math.min(0.9, open * 1.4); ctx.beginPath(); ctx.ellipse((x0 + x1) / 2, y1 + hh * 0.1, w * 0.32, hh * 0.45, 0, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  const th = Math.min(hh * 0.42, w * 0.11);
  const tg = ctx.createLinearGradient(0, y0, 0, y0 + th); tg.addColorStop(0, teeth); tg.addColorStop(1, '#bdb3a4');
  ctx.fillStyle = tg; ctx.fillRect(x0 + w * 0.08, y0 - 1, w * 0.84, th + 1);
  ctx.strokeStyle = 'rgba(80,60,50,.25)'; ctx.lineWidth = Math.max(0.5, w / 120);
  for (let k = 1; k < 8; k++) { const x = x0 + w * (0.08 + 0.84 * k / 8); ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + th); ctx.stroke(); }
  const sh = ctx.createLinearGradient(0, y0, 0, y0 + hh * 0.3); sh.addColorStop(0, 'rgba(0,0,0,.35)'); sh.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = sh; ctx.fillRect(x0, y0, w, hh * 0.3);
  ctx.restore();
}

/** How much a track's mouth moves in a time window (to guess who is speaking). frames: analysis frames. */
export function mouthActivity(frames, trackId, f0, f1) {
  const v = [];
  for (let f = Math.max(0, f0); f <= Math.min(frames.length - 1, f1); f++) {
    const q = frames[f]?.people.find(p => p.id === trackId); if (!q?.face) continue;
    const F = q.face, w = Math.hypot(F[291 * 3] - F[61 * 3], F[291 * 3 + 1] - F[61 * 3 + 1]) || 1;
    v.push((F[14 * 3 + 1] - F[13 * 3 + 1]) / w);
  }
  if (v.length < 3) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) * Math.min(1, v.length / 10);
}
