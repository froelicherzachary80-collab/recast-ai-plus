import type { Pcm } from '../src/audio/pcm';
/** Deterministic synthetic "sung" tone: harmonic series with formant-like envelope and optional vibrato. */
export function sungTone(sr: number, dur: number, f0: number | ((t: number) => number), formant = 700, vibrato = 0): Float32Array {
  const n = Math.round(sr * dur), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f = (typeof f0 === 'number' ? f0 : f0(t)) * (1 + vibrato * Math.sin(2 * Math.PI * 5.5 * t));
    ph += (2 * Math.PI * f) / sr;
    let s = 0;
    for (let h = 1; h * f < sr / 2 && h < 30; h++) { const fh = h * f; const amp = Math.exp(-(((fh - formant) / 400) ** 2)) + 0.3 * Math.exp(-(((fh - formant * 2.5) / 600) ** 2)) + 0.05 / h; s += amp * Math.sin(h * ph); }
    x[i] = s * 0.2;
  }
  return x;
}
export function clickTrack(sr: number, dur: number, bpm: number): Float32Array {
  const x = new Float32Array(Math.round(sr * dur)), period = (60 / bpm) * sr;
  for (let b = 0; b * period < x.length; b++) { const s = Math.round(b * period); for (let i = 0; i < 400 && s + i < x.length; i++) x[s + i] += Math.exp(-i / 60) * Math.sin(i * 0.6) * 0.8; }
  return x;
}
export const mono = (sr: number, x: Float32Array): Pcm => ({ sampleRate: sr, channels: [x] });
let seed = 1;
export const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
