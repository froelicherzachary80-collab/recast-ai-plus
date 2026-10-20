/** Planar PCM buffer used throughout the app (independent of Web Audio so DSP is testable in Node). */
export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

export const pcmLength = (p: Pcm) => (p.channels[0]?.length ?? 0);
export const pcmDuration = (p: Pcm) => pcmLength(p) / p.sampleRate;

export function makePcm(sampleRate: number, numChannels: number, length: number): Pcm {
  return { sampleRate, channels: Array.from({ length: numChannels }, () => new Float32Array(length)) };
}

export function toMono(p: Pcm): Float32Array {
  if (p.channels.length === 1) return p.channels[0];
  const n = pcmLength(p), out = new Float32Array(n), k = 1 / p.channels.length;
  for (const ch of p.channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

export function toStereo(p: Pcm): Pcm {
  if (p.channels.length === 2) return p;
  if (p.channels.length === 1) return { sampleRate: p.sampleRate, channels: [p.channels[0], p.channels[0].slice()] };
  return { sampleRate: p.sampleRate, channels: [p.channels[0], p.channels[1]] };
}

export function slicePcm(p: Pcm, startSec: number, endSec: number): Pcm {
  const a = Math.max(0, Math.floor(startSec * p.sampleRate));
  const b = Math.min(pcmLength(p), Math.floor(endSec * p.sampleRate));
  return { sampleRate: p.sampleRate, channels: p.channels.map((c) => c.slice(a, Math.max(a, b))) };
}

export function peak(p: Pcm): number {
  let m = 0;
  for (const c of p.channels) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > m) m = v; }
  return m;
}

export function rms(x: Float32Array, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

export const dbfs = (v: number) => (v <= 1e-9 ? -Infinity : 20 * Math.log10(v));
export const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Min/max peaks per pixel column, for waveform drawing that truthfully reflects the samples. */
export function waveformPeaks(x: Float32Array, columns: number, start = 0, end = x.length): Float32Array {
  const out = new Float32Array(columns * 2);
  const span = Math.max(1, end - start);
  for (let c = 0; c < columns; c++) {
    const a = start + Math.floor((c * span) / columns), b = Math.max(a + 1, start + Math.floor(((c + 1) * span) / columns));
    let mn = 0, mx = 0;
    for (let i = a; i < b && i < x.length; i++) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    out[c * 2] = mn; out[c * 2 + 1] = mx;
  }
  return out;
}

/** Spectral difference between two signals (used as evidence that a conversion changed the audio). */
export function nrmsDifference(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let d = 0, e = 0;
  for (let i = 0; i < n; i++) { d += (a[i] - b[i]) ** 2; e += a[i] * a[i]; }
  return Math.sqrt(d / Math.max(e, 1e-12));
}
