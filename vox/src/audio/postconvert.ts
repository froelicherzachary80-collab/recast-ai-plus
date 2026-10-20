/** Post-conversion stages: alignment, expression (envelope) transfer, unvoiced preservation, voice blend. Real DSP. */
import type { F0Track } from './f0';

/** RMS envelope with frame size `win` samples (hop = win/2). */
export function rmsEnvelope(x: Float32Array, win: number): Float32Array {
  const hop = win >> 1, n = Math.ceil(x.length / hop), e = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; const a = f * hop; for (let i = a; i < Math.min(x.length, a + win); i++) s += x[i] * x[i]; e[f] = Math.sqrt(s / win); }
  return e;
}

/** Finds lag (samples, |lag| <= maxLag) that best aligns `y` to `ref` by envelope cross-correlation. */
export function estimateLag(ref: Float32Array, y: Float32Array, sr: number, maxLagSec = 0.1): number {
  const win = Math.round(sr * 0.005), hop = win >> 1, a = rmsEnvelope(ref, win), b = rmsEnvelope(y, win);
  const ml = Math.round((maxLagSec * sr) / hop);
  const mean = (v: Float32Array) => v.reduce((p, c) => p + c, 0) / Math.max(1, v.length);
  const ma = mean(a), mb = mean(b);
  let best = 0, bv = -Infinity;
  for (let l = -ml; l <= ml; l++) {
    let s = 0, c = 0;
    for (let i = 0; i < a.length; i++) { const j = i + l; if (j >= 0 && j < b.length) { s += (a[i] - ma) * (b[j] - mb); c++; } }
    s /= Math.max(1, c);
    if (s > bv) { bv = s; best = l; }
  }
  // reject unreliable estimates: best lag pinned at the search limit, or weak normalised correlation
  if (Math.abs(best) >= ml) return 0;
  let va = 0, vb = 0; for (const v of a) va += (v - ma) ** 2; for (const v of b) vb += (v - mb) ** 2;
  const rho = bv / Math.sqrt((va / a.length) * (vb / b.length) + 1e-20);
  return rho > 0.3 ? best * hop : 0;
}

export function shift(y: Float32Array, lag: number): Float32Array {
  if (!lag) return y;
  const o = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) { const j = i + lag; if (j >= 0 && j < y.length) o[i] = y[j]; }
  return o;
}

/** Transfers the source loudness contour onto the converted vocal (RVC "rms_mix_rate" style). amount 0..1 */
export function transferEnvelope(src: Float32Array, y: Float32Array, sr: number, amount: number): Float32Array {
  if (amount <= 0) return y;
  const win = Math.round(sr * 0.02), hop = win >> 1, es = rmsEnvelope(src, win), ey = rmsEnvelope(y, win);
  const out = new Float32Array(y.length);
  const g = new Float32Array(es.length);
  for (let f = 0; f < g.length; f++) { const r = (es[f] + 1e-4) / ((ey[f] ?? 0) + 1e-4); g[f] = Math.min(4, Math.max(0.05, Math.pow(r, amount))); }
  for (let i = 0; i < y.length; i++) { const p = i / hop, f = Math.floor(p), t = p - f; const gv = (g[f] ?? 1) * (1 - t) + (g[f + 1] ?? g[f] ?? 1) * t; out[i] = y[i] * gv; }
  return out;
}

/** Blends source audio back in on unvoiced frames (consonants/breaths), with 10 ms smoothing. */
export function preserveUnvoiced(src: Float32Array, y: Float32Array, sr: number, tr: F0Track, amount: number): Float32Array {
  if (amount <= 0) return y;
  const hopS = (tr.hop / tr.sampleRate) * sr, out = new Float32Array(y.length), sm = Math.exp(-1 / (0.01 * sr));
  let m = 0;
  for (let i = 0; i < y.length; i++) {
    const f = Math.min(tr.voiced.length - 1, Math.floor(i / hopS));
    const target = tr.voiced[f] ? 0 : amount;
    m = sm * m + (1 - sm) * target;
    out[i] = y[i] * (1 - m) + (src[i] ?? 0) * m;
  }
  return out;
}

export function blend(src: Float32Array, y: Float32Array, wet: number): Float32Array {
  if (wet >= 1) return y;
  const o = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) o[i] = y[i] * wet + (src[i] ?? 0) * (1 - wet);
  return o;
}
