/**
 * NON-NEURAL fallback: stereo centre-channel extraction (STFT inter-channel similarity mask).
 * Works only when the lead vocal is panned centre and the backing is wide; quality is far below
 * neural separation. The UI always labels this as "DSP centre extraction (not AI)".
 */
import { hann, istft, stft } from './fft';
import type { Pcm } from './pcm';

export function centerExtract(mix: Pcm, strength = 1.5, lowHz = 120, highHz = 9000): { vocals: Pcm; instrumental: Pcm } {
  const L = mix.channels[0], R = mix.channels[1] ?? mix.channels[0], n = L.length, N = 4096, H = 1024, w = hann(N);
  const sl = stft(L, N, H, w), sr = stft(R, N, H, w), bins = sl.bins, fpb = mix.sampleRate / N;
  const vr = [new Float32Array(sl.re.length), new Float32Array(sl.re.length)], vi = [new Float32Array(sl.re.length), new Float32Array(sl.re.length)];
  for (let t = 0; t < sl.frames; t++) for (let b = 0; b < bins; b++) {
    const k = t * bins + b, f = b * fpb;
    if (f < lowHz || f > highHz) continue;
    const lr = sl.re[k], li = sl.im[k], rr = sr.re[k], ri = sr.im[k];
    const ml = Math.hypot(lr, li), mr = Math.hypot(rr, ri);
    const sim = ml + mr > 1e-9 ? (2 * (lr * rr + li * ri)) / (ml * ml + mr * mr + 1e-12) : 0; // 1 when identical
    const m = Math.pow(Math.max(0, sim), strength * 4);
    const cr = (lr + rr) / 2, ci = (li + ri) / 2;
    vr[0][k] = cr * m; vi[0][k] = ci * m; vr[1][k] = cr * m; vi[1][k] = ci * m;
  }
  const v = [istft(vr[0], vi[0], sl.frames, N, H, n, w), istft(vr[1], vi[1], sl.frames, N, H, n, w)];
  const inst = [L.map((x, i) => x - v[0][i]), R.map((x, i) => x - v[1][i])];
  return { vocals: { sampleRate: mix.sampleRate, channels: v }, instrumental: { sampleRate: mix.sampleRate, channels: inst } };
}
