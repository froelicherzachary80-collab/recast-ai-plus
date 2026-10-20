/** Voice sample analysis: pitch range, loudness, timbre descriptors (MFCC means, centroid). Analysis only — not a trained model. */
import { hann, magSpectrum } from './fft';
import { yinF0, pitchRange } from './f0';
import { loudness, spectralCentroid } from './analysis';
import { toMono, type Pcm } from './pcm';
import { resample } from './resample';
import type { VoiceAnalysis } from '../project/types';

export function mfccMean(x: Float32Array, sr: number, nMel = 26, nCoef = 13): number[] {
  const N = 1024, H = 512, w = hann(N), fr = new Float64Array(N);
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700), imel = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const pts = Array.from({ length: nMel + 2 }, (_, i) => imel((i * mel(sr / 2)) / (nMel + 1))).map((f) => Math.floor(((N + 1) * f) / sr));
  const acc = new Float64Array(nCoef); let frames = 0;
  for (let s = 0; s + N <= x.length; s += H) {
    let e = 0; for (let i = 0; i < N; i++) { fr[i] = x[s + i] * w[i]; e += fr[i] * fr[i]; }
    if (e < 1e-6) continue;
    const m = magSpectrum(fr), le = new Float64Array(nMel);
    for (let j = 0; j < nMel; j++) { let v = 0; for (let b = pts[j]; b < pts[j + 2]; b++) { const wt = b < pts[j + 1] ? (b - pts[j]) / Math.max(1, pts[j + 1] - pts[j]) : (pts[j + 2] - b) / Math.max(1, pts[j + 2] - pts[j + 1]); v += (m[b] ?? 0) ** 2 * wt; } le[j] = Math.log(v + 1e-10); }
    for (let k = 0; k < nCoef; k++) { let c = 0; for (let j = 0; j < nMel; j++) c += le[j] * Math.cos((Math.PI * k * (j + 0.5)) / nMel); acc[k] += c; }
    frames++;
  }
  return Array.from(acc, (v) => (frames ? v / frames : 0));
}

export function analyzeVoice(samples: Pcm[]): VoiceAnalysis {
  const sr = 16000, parts = samples.map((p) => resample(toMono(p), p.sampleRate, sr));
  const total = parts.reduce((a, b) => a + b.length, 0), x = new Float32Array(total);
  let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
  const tr = yinF0(x, sr), r = pitchRange(tr);
  const voiced = tr.voiced.reduce((a, b) => a + b, 0) / Math.max(1, tr.voiced.length);
  return { durationSec: total / sr, rangeLowMidi: r?.low ?? null, rangeHighMidi: r?.high ?? null, medianMidi: r?.median ?? null,
    centroidHz: spectralCentroid(x, sr), lufs: loudness({ sampleRate: sr, channels: [x] }).integrated, voicedRatio: voiced,
    mfccMean: mfccMean(x, sr), sampleCount: samples.length, analyzedAt: Date.now() };
}

/** Cosine similarity of MFCC means (excluding c0) — a coarse timbre-similarity indicator, NOT identity verification. */
export function timbreSimilarity(a: number[], b: number[]): number {
  let n = 0, da = 0, db = 0;
  for (let i = 1; i < Math.min(a.length, b.length); i++) { n += a[i] * b[i]; da += a[i] ** 2; db += b[i] ** 2; }
  return n / Math.sqrt(da * db + 1e-12);
}
