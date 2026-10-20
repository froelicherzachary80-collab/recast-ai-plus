import { hann, magSpectrum } from './fft';
import { toMono, type Pcm, peak } from './pcm';
import { resample } from './resample';

/** Tempo estimate from spectral-flux onset envelope autocorrelation with a log-normal tempo prior. */
export function estimateBpm(p: Pcm): { bpm: number; confidence: number } {
  const sr = 22050, x = resample(toMono(p), p.sampleRate, sr);
  const N = 1024, H = 256, w = hann(N), frames = Math.floor((x.length - N) / H);
  if (frames < 64) return { bpm: 0, confidence: 0 };
  const env = new Float64Array(frames);
  let prev = new Float64Array(N / 2 + 1);
  const fr = new Float64Array(N);
  for (let t = 0; t < frames; t++) {
    for (let i = 0; i < N; i++) fr[i] = x[t * H + i] * w[i];
    const m = magSpectrum(fr);
    let f = 0;
    for (let b = 1; b < m.length; b++) { const lm = Math.log1p(100 * m[b]); const d = lm - prev[b]; if (d > 0) f += d; prev[b] = lm; }
    env[t] = f;
  }
  // high-pass the envelope (remove slow trend)
  const sm = new Float64Array(frames), K = 16;
  for (let t = 0; t < frames; t++) { let s = 0, c = 0; for (let k = t - K; k <= t + K; k++) if (k >= 0 && k < frames) { s += env[k]; c++; } sm[t] = Math.max(0, env[t] - s / c); }
  const fps = sr / H, minLag = Math.floor((fps * 60) / 200), maxLag = Math.ceil((fps * 60) / 60);
  let best = 0, bestLag = 0, total = 0, sec = 0;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0; for (let t = 0; t + lag < frames; t++) s += sm[t] * sm[t + lag];
    s /= frames - lag;
    const bpm = (60 * fps) / lag, prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const sc = s * prior; scores.push(sc); total += sc;
    if (sc > best) { sec = best; best = sc; bestLag = lag; } else if (sc > sec) sec = sc;
  }
  if (!bestLag || total <= 0) return { bpm: 0, confidence: 0 };
  // parabolic refine
  const i = bestLag - minLag, a = scores[i - 1] ?? scores[i], b = scores[i], c = scores[i + 1] ?? scores[i];
  const den = a - 2 * b + c, lagF = bestLag + (Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0);
  const mean = total / scores.length;
  return { bpm: Math.round(((60 * fps) / lagF) * 10) / 10, confidence: Math.max(0, Math.min(1, (best - mean) / (best + 1e-12))) };
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function chromagram(p: Pcm): Float64Array {
  const sr = 22050, x = resample(toMono(p), p.sampleRate, sr), N = 8192, H = 4096, w = hann(N);
  const chroma = new Float64Array(12), fr = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += H) {
    for (let i = 0; i < N; i++) fr[i] = x[s + i] * w[i];
    const m = magSpectrum(fr);
    for (let b = 1; b < m.length; b++) {
      const f = (b * sr) / N; if (f < 55 || f > 2000) continue;
      const midi = 69 + 12 * Math.log2(f / 440), pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += m[b] * m[b];
    }
  }
  return chroma;
}

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db + 1e-12);
}

export interface KeyEstimate { tonic: number; mode: 'major' | 'minor'; name: string; confidence: number; alternatives: string[]; }

/** Krumhansl-Schmuckler key finding; confidence is the correlation margin to the runner-up. */
export function estimateKey(p: Pcm): KeyEstimate {
  const ch = Array.from(chromagram(p));
  const res: { name: string; tonic: number; mode: 'major' | 'minor'; r: number }[] = [];
  for (let k = 0; k < 12; k++) for (const [mode, prof] of [['major', MAJOR], ['minor', MINOR]] as const) {
    const rot = prof.map((_, i) => prof[(i - k + 12) % 12]);
    res.push({ name: `${KEY_NAMES[k]} ${mode}`, tonic: k, mode, r: corr(ch, rot) });
  }
  res.sort((a, b) => b.r - a.r);
  const conf = Math.max(0, Math.min(1, (res[0].r - res[1].r) * 4 + Math.max(0, res[0].r) * 0.3));
  return { tonic: res[0].tonic, mode: res[0].mode, name: res[0].name, confidence: conf, alternatives: res.slice(1, 3).map((r) => r.name) };
}

// ---- ITU-R BS.1770-4 loudness ----
function biquadCoeffsKWeight(sr: number) {
  // Stage 1: high shelf (pyloudnorm parameterisation), Stage 2: RLB high-pass
  const shelf = (() => {
    const G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.974450955533;
    const K = Math.tan((Math.PI * fc) / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  const hp = (() => {
    const Q = 0.5003270373238773, fc = 38.13547087602444, K = Math.tan((Math.PI * fc) / sr), a0 = 1 + K / Q + K * K;
    return { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
  })();
  return [shelf, hp];
}
function filt(x: Float32Array, c: { b: number[]; a: number[] }) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = c.b[0] * x[i] + c.b[1] * x1 + c.b[2] * x2 - c.a[1] * y1 - c.a[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}

export interface Loudness { integrated: number; shortTermMax: number; momentaryMax: number; lra: number; }

export function loudness(p: Pcm): Loudness {
  const sr = p.sampleRate, [s1, s2] = biquadCoeffsKWeight(sr);
  const kw = p.channels.slice(0, 2).map((c) => filt(filt(c, s1), s2));
  const n = kw[0].length, blk = Math.round(0.4 * sr), step = Math.round(0.1 * sr);
  const ms: number[] = [];
  for (let s = 0; s + blk <= n; s += step) {
    let z = 0; for (const c of kw) { let a = 0; for (let i = s; i < s + blk; i++) a += c[i] * c[i]; z += a / blk; }
    ms.push(z);
  }
  const L = (z: number) => -0.691 + 10 * Math.log10(z + 1e-20);
  const abs = ms.filter((z) => L(z) > -70);
  if (!abs.length) return { integrated: -Infinity, shortTermMax: -Infinity, momentaryMax: -Infinity, lra: 0 };
  const relT = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => L(z) > relT);
  const integrated = L(gated.reduce((a, b) => a + b, 0) / gated.length);
  // short-term 3 s windows
  const st: number[] = [];
  for (let i = 0; i + 30 <= ms.length; i += 10) { let z = 0; for (let k = i; k < i + 30; k += 4) z += ms[k]; st.push(L(z / Math.ceil(30 / 4))); }
  const stg = st.filter((v) => v > -70 && v > integrated - 20).sort((a, b) => a - b);
  const lra = stg.length > 2 ? stg[Math.floor(stg.length * 0.95)] - stg[Math.floor(stg.length * 0.1)] : 0;
  return { integrated, shortTermMax: st.length ? Math.max(...st) : integrated, momentaryMax: Math.max(...ms.map(L)), lra };
}

/** True-peak estimate via 4x band-limited oversampling (BS.1770 Annex 2 approach). */
export function truePeak(p: Pcm): number {
  let m = 0;
  for (const c of p.channels) {
    const seg = c.length > p.sampleRate * 600 ? c.subarray(0, p.sampleRate * 600) : c;
    const up = resample(seg, p.sampleRate, p.sampleRate * 4, 12);
    for (let i = 0; i < up.length; i++) { const v = Math.abs(up[i]); if (v > m) m = v; }
  }
  return Math.max(m, peak(p));
}

export function spectralCentroid(x: Float32Array, sr: number): number {
  const N = 2048, w = hann(N), fr = new Float64Array(N);
  let num = 0, den = 0;
  for (let s = 0; s + N <= x.length; s += N) {
    for (let i = 0; i < N; i++) fr[i] = x[s + i] * w[i];
    const m = magSpectrum(fr);
    for (let b = 1; b < m.length; b++) { num += ((b * sr) / N) * m[b]; den += m[b]; }
  }
  return den > 0 ? num / den : 0;
}
