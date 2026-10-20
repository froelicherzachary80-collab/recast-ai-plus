/**
 * Offline DSP effects (real signal processing on Float32 PCM). All effects are pure
 * functions returning new buffers so mixer processing stays non-destructive.
 */
import { dbToGain, type Pcm } from './pcm';

export type BiquadType = 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf' | 'bandpass';
export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number; }

/** RBJ Audio-EQ-Cookbook coefficients. */
export function biquad(type: BiquadType, f: number, sr: number, q = 0.707, gainDb = 0): Biquad {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr, cw = Math.cos(w), sw = Math.sin(w);
  const A = Math.pow(10, gainDb / 40), al = sw / (2 * q);
  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
    case 'peaking': b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
    case 'lowshelf': { const s = 2 * Math.sqrt(A) * al;
      b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s; break; }
    case 'highshelf': { const s = 2 * Math.sqrt(A) * al;
      b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; break; }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function applyBiquad(x: Float32Array, c: Biquad): Float32Array {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Magnitude response (dB) of a biquad at frequency f — used by the EQ curve display. */
export function biquadResponseDb(c: Biquad, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr, cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i, dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
}

export interface EqBand { type: BiquadType; freq: number; gain: number; q: number; on: boolean; }
export const mapCh = (p: Pcm, f: (c: Float32Array, i: number) => Float32Array): Pcm => ({ sampleRate: p.sampleRate, channels: p.channels.map(f) });

export function eq(p: Pcm, bands: EqBand[]): Pcm {
  const act = bands.filter((b) => b.on && (b.type === 'highpass' || b.type === 'lowpass' || Math.abs(b.gain) > 0.01));
  if (!act.length) return p;
  return mapCh(p, (c) => { let y = c; for (const b of act) y = applyBiquad(y, biquad(b.type, b.freq, p.sampleRate, b.q, b.gain)); return y; });
}

export interface CompressorParams { threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number; on: boolean; }

/** Feed-forward stereo-linked compressor with soft knee. Returns processed audio and max gain reduction (dB). */
export function compress(p: Pcm, c: CompressorParams): { out: Pcm; maxGr: number } {
  if (!c.on) return { out: p, maxGr: 0 };
  const sr = p.sampleRate, n = p.channels[0].length;
  const aA = Math.exp(-1 / (sr * Math.max(1e-4, c.attack))), aR = Math.exp(-1 / (sr * Math.max(1e-3, c.release)));
  const out = p.channels.map(() => new Float32Array(n)), mk = dbToGain(c.makeup);
  let env = 0, maxGr = 0;
  for (let i = 0; i < n; i++) {
    let lv = 0; for (const ch of p.channels) lv = Math.max(lv, Math.abs(ch[i]));
    const xdb = lv > 1e-9 ? 20 * Math.log10(lv) : -180;
    const over = xdb - c.threshold;
    let gr = 0;
    if (2 * over < -c.knee) gr = 0;
    else if (2 * Math.abs(over) <= c.knee && c.knee > 0) gr = ((1 / c.ratio - 1) * (over + c.knee / 2) ** 2) / (2 * c.knee);
    else gr = over * (1 / c.ratio - 1);
    const target = -gr;
    env = target > env ? aA * env + (1 - aA) * target : aR * env + (1 - aR) * target;
    if (env > maxGr) maxGr = env;
    const g = dbToGain(-env) * mk;
    for (let k = 0; k < out.length; k++) out[k][i] = p.channels[k][i] * g;
  }
  return { out: { sampleRate: sr, channels: out }, maxGr };
}

/** Look-ahead brickwall peak limiter (sample-peak). */
export function limit(p: Pcm, ceilingDb = -1, releaseMs = 80, lookaheadMs = 5): Pcm {
  const sr = p.sampleRate, n = p.channels[0].length, ceil = dbToGain(ceilingDb);
  const la = Math.max(1, Math.round((lookaheadMs / 1000) * sr)), aR = Math.exp(-1 / ((releaseMs / 1000) * sr));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (const c of p.channels) m = Math.max(m, Math.abs(c[i])); need[i] = m > ceil ? ceil / m : 1; }
  // sliding-window minimum over look-ahead, then smooth release
  const gmin = new Float32Array(n), dq: number[] = [];
  for (let i = 0; i < n + la; i++) {
    if (i < n) { while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop(); dq.push(i); }
    const o = i - la; if (o < 0) continue;
    while (dq.length && dq[0] < o) dq.shift();
    gmin[o] = dq.length ? need[dq[0]] : 1;
  }
  const out = p.channels.map(() => new Float32Array(n));
  let g = 1;
  for (let i = 0; i < n; i++) {
    const t = gmin[i]; g = t < g ? t : aR * g + (1 - aR) * t; if (g > t) g = t;
    for (let k = 0; k < out.length; k++) { const v = p.channels[k][i] * g; out[k][i] = Math.max(-ceil, Math.min(ceil, v)); }
  }
  return { sampleRate: sr, channels: out };
}

/** Split-band de-esser: reduces the 5–10 kHz band when it exceeds threshold. */
export function deess(p: Pcm, freq = 6500, thresholdDb = -28, maxReductionDb = 10): Pcm {
  const sr = p.sampleRate, hp = biquad('highpass', freq, sr, 0.707);
  const aA = Math.exp(-1 / (sr * 0.001)), aR = Math.exp(-1 / (sr * 0.06));
  return mapCh(p, (c) => {
    const hi = applyBiquad(c, hp), y = new Float32Array(c.length);
    let env = 0;
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(hi[i]); env = a > env ? aA * env + (1 - aA) * a : aR * env + (1 - aR) * a;
      const over = 20 * Math.log10(env + 1e-9) - thresholdDb;
      const red = over > 0 ? Math.min(maxReductionDb, over * 0.75) : 0;
      y[i] = c[i] - hi[i] * (1 - dbToGain(-red));
    }
    return y;
  });
}

/** Gentle harmonic saturation (asymmetric tanh) with dry/wet mix. */
export function saturate(p: Pcm, drive = 0.3, mix = 1): Pcm {
  if (drive <= 0 || mix <= 0) return p;
  const k = 1 + drive * 6, norm = 1 / Math.tanh(k);
  return mapCh(p, (c) => { const y = new Float32Array(c.length); for (let i = 0; i < c.length; i++) { const s = Math.tanh(k * (c[i] + 0.05 * drive * c[i] * c[i])) * norm; y[i] = c[i] * (1 - mix) + s * mix; } return y; });
}

/** Freeverb-style stereo reverb (8 damped combs + 4 allpasses per side). */
export function reverb(p: Pcm, opts: { mix: number; size: number; damp: number; preDelayMs: number; width?: number }): Pcm {
  if (opts.mix <= 0) return p;
  const sr = p.sampleRate, sc = sr / 44100, n = p.channels[0].length, tail = Math.round(sr * (1 + opts.size * 2.5));
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
  const fb = 0.7 + opts.size * 0.28, damp = opts.damp * 0.4, pre = Math.round((opts.preDelayMs / 1000) * sr);
  const L = n + tail, input = new Float32Array(L);
  for (let i = 0; i < n; i++) { let s = 0; for (const c of p.channels) s += c[i]; input[i] = (s / p.channels.length) * 0.015; }
  const side = (spread: number) => {
    const out = new Float32Array(L);
    for (const len0 of combs) {
      const len = Math.round((len0 + spread) * sc), buf = new Float32Array(len); let idx = 0, f = 0;
      for (let i = 0; i < L; i++) {
        const xi = i - pre >= 0 ? input[i - pre] : 0, o = buf[idx];
        f = o * (1 - damp) + f * damp; buf[idx] = xi + f * fb; idx = (idx + 1) % len; out[i] += o;
      }
    }
    for (const len0 of aps) {
      const len = Math.round((len0 + spread) * sc), buf = new Float32Array(len); let idx = 0;
      for (let i = 0; i < L; i++) { const b = buf[idx], v = out[i]; out[i] = -v + b; buf[idx] = v + b * 0.5; idx = (idx + 1) % len; }
    }
    return out;
  };
  const wl = side(0), wr = side(23), w = opts.width ?? 1;
  const ch = p.channels.length >= 2 ? p.channels : [p.channels[0], p.channels[0]];
  const outL = new Float32Array(L), outR = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const dl = i < n ? ch[0][i] : 0, dr = i < n ? ch[1][i] : 0;
    const a = wl[i] * (0.5 + w / 2) + wr[i] * (0.5 - w / 2), b = wr[i] * (0.5 + w / 2) + wl[i] * (0.5 - w / 2);
    outL[i] = dl + a * opts.mix * 3; outR[i] = dr + b * opts.mix * 3;
  }
  return { sampleRate: sr, channels: [outL.subarray(0, n), outR.subarray(0, n)].map((c) => c.slice()) };
}

/** Feedback delay (optionally ping-pong), tempo-syncable by the caller. */
export function delay(p: Pcm, opts: { timeMs: number; feedback: number; mix: number; pingPong: boolean; lowpass?: number }): Pcm {
  if (opts.mix <= 0) return p;
  const sr = p.sampleRate, d = Math.max(1, Math.round((opts.timeMs / 1000) * sr)), n = p.channels[0].length;
  const ch = p.channels.length >= 2 ? p.channels : [p.channels[0], p.channels[0]];
  const bl = new Float32Array(d), br = new Float32Array(d), lp = biquad('lowpass', opts.lowpass ?? 6000, sr);
  let idx = 0, zl = [0, 0, 0, 0], zr = [0, 0, 0, 0];
  const run = (x: number, z: number[]) => { const v = lp.b0 * x + lp.b1 * z[0] + lp.b2 * z[1] - lp.a1 * z[2] - lp.a2 * z[3]; z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = v; return v; };
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dl = run(bl[idx], zl), dr = run(br[idx], zr);
    if (opts.pingPong) { bl[idx] = (ch[0][i] + ch[1][i]) * 0.5 + dr * opts.feedback; br[idx] = dl * opts.feedback; }
    else { bl[idx] = ch[0][i] + dl * opts.feedback; br[idx] = ch[1][i] + dr * opts.feedback; }
    idx = (idx + 1) % d;
    oL[i] = ch[0][i] + dl * opts.mix; oR[i] = ch[1][i] + dr * opts.mix;
  }
  return { sampleRate: sr, channels: [oL, oR] };
}

/** Mid/side stereo width (0 = mono, 1 = unchanged, 2 = extra wide). */
export function stereoWidth(p: Pcm, width: number): Pcm {
  if (p.channels.length < 2 || Math.abs(width - 1) < 1e-3) return p;
  const [l, r] = p.channels, n = l.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) { const m = (l[i] + r[i]) / 2, s = ((l[i] - r[i]) / 2) * width; oL[i] = m + s; oR[i] = m - s; }
  return { sampleRate: p.sampleRate, channels: [oL, oR] };
}

/** Equal-power panning of a mono or stereo source to stereo (-1..1). */
export function pan(p: Pcm, pos: number, gain = 1): Pcm {
  const a = ((pos + 1) * Math.PI) / 4, gl = Math.cos(a) * Math.SQRT2 * gain, gr = Math.sin(a) * Math.SQRT2 * gain;
  const l = p.channels[0], r = p.channels[1] ?? p.channels[0], n = l.length;
  const oL = new Float32Array(n), oR = new Float32Array(n);
  for (let i = 0; i < n; i++) { oL[i] = l[i] * gl; oR[i] = r[i] * gr; }
  return { sampleRate: p.sampleRate, channels: [oL, oR] };
}

/** Click repair: detects impulsive outliers against a local prediction and replaces them by interpolation. */
export function declick(p: Pcm, sensitivity = 0.5): { out: Pcm; repaired: number } {
  let repaired = 0;
  const k = 8 - sensitivity * 5;
  const out = mapCh(p, (c) => {
    const y = c.slice(), n = c.length, W = 64;
    // residual of 2nd-order prediction, robust scale per 256-block
    const B = 256;
    for (let s = 2; s < n - 3; s += B) {
      const e: number[] = [];
      for (let i = s; i < Math.min(n - 1, s + B); i++) e.push(Math.abs(c[i] - 2 * c[i - 1] + c[i - 2]));
      const sorted = e.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1] + 1e-5;
      for (let j = 0; j < e.length; j++) {
        if (e[j] > med * k * 4 && e[j] > 0.05) {
          const i = s + j, a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
          for (let q = a + 1; q < b; q++) y[q] = y[a] + ((y[b] - y[a]) * (q - a)) / (b - a);
          repaired++;
        }
      }
    }
    return y;
  });
  return { out, repaired };
}

/** Downward expander for noise management (gentle, keeps breaths above floor). */
export function expander(p: Pcm, thresholdDb = -50, ratio = 2, rangeDb = 12): Pcm {
  const sr = p.sampleRate, aA = Math.exp(-1 / (sr * 0.002)), aR = Math.exp(-1 / (sr * 0.12));
  const n = p.channels[0].length, out = p.channels.map(() => new Float32Array(n));
  let env = 0;
  for (let i = 0; i < n; i++) {
    let lv = 0; for (const c of p.channels) lv = Math.max(lv, Math.abs(c[i]));
    env = lv > env ? aA * env + (1 - aA) * lv : aR * env + (1 - aR) * lv;
    const db = 20 * Math.log10(env + 1e-9), under = thresholdDb - db;
    const g = under > 0 ? dbToGain(-Math.min(rangeDb, under * (ratio - 1))) : 1;
    for (let k = 0; k < out.length; k++) out[k][i] = p.channels[k][i] * g;
  }
  return { sampleRate: sr, channels: out };
}

/** Chorus via two modulated fractional delay lines. */
export function chorus(p: Pcm, depthMs = 4, rateHz = 0.8, mix = 0.35): Pcm {
  if (mix <= 0) return p;
  const sr = p.sampleRate, base = 0.012 * sr, dep = (depthMs / 1000) * sr;
  const ch = p.channels.length >= 2 ? p.channels : [p.channels[0], p.channels[0]];
  const out = ch.map((c, ci) => {
    const y = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) {
      const d = base + dep * (0.5 + 0.5 * Math.sin((2 * Math.PI * rateHz * i) / sr + ci * Math.PI / 2));
      const pos = i - d, j = Math.floor(pos), f = pos - j;
      const v = j >= 0 && j + 1 < c.length ? c[j] * (1 - f) + c[j + 1] * f : 0;
      y[i] = c[i] * (1 - mix * 0.5) + v * mix;
    }
    return y;
  });
  return { sampleRate: sr, channels: out };
}

export function gainEnvelope(x: Float32Array, sr: number, points: { t: number; db: number }[]): Float32Array {
  if (!points.length) return x;
  const pts = points.slice().sort((a, b) => a.t - b.t), y = new Float32Array(x.length);
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    while (j < pts.length - 1 && pts[j + 1].t <= t) j++;
    let db: number;
    if (t <= pts[0].t) db = pts[0].db; else if (j >= pts.length - 1) db = pts[pts.length - 1].db;
    else { const a = pts[j], b = pts[j + 1]; db = a.db + ((b.db - a.db) * (t - a.t)) / (b.t - a.t || 1); }
    y[i] = x[i] * dbToGain(db);
  }
  return y;
}
