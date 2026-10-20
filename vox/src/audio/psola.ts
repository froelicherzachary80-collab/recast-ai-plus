/**
 * TD-PSOLA pitch/time modification for monophonic vocals. Pitch-synchronous grains keep the
 * spectral envelope (formants) in place while the pitch changes — used by the pitch editor,
 * algorithmic harmonies and DSP voice-character presets. This is signal processing, not a neural model.
 */
import type { F0Track } from './f0';
import { resample } from './resample';

export interface PsolaOptions {
  /** pitch ratio per F0 frame (same indexing as track.f0); scalar allowed */
  ratio: Float32Array | number;
  /** time-scale factor (>1 = longer) */
  timeScale?: number;
}

export function analysisMarks(x: Float32Array, tr: F0Track, sr: number) {
  const hopS = (tr.hop / tr.sampleRate) * sr, n = x.length;
  const marks: number[] = [], periods: number[] = [], vflag: number[] = [];
  const uv = Math.round(0.005 * sr);
  let t = 0;
  while (t < n) {
    const fi = Math.min(tr.f0.length - 1, Math.round(t / hopS));
    if (tr.voiced[fi] && tr.f0[fi] > 0) {
      const P = sr / tr.f0[fi];
      // first mark of a voiced run snaps to the strongest peak; later marks step by the local
      // period (peak-snapping every grain introduces jitter that destroys periodicity)
      let best = t;
      if (marks.length && vflag[vflag.length - 1]) best = marks[marks.length - 1] + Math.round(P);
      else { let bv = -1; for (let k = t; k < Math.min(n, t + Math.round(P)); k++) if (Math.abs(x[k]) > bv) { bv = Math.abs(x[k]); best = k; } }
      marks.push(best); periods.push(P); vflag.push(1);
      t = best + Math.max(1, Math.round(P * 0.8));
    } else {
      marks.push(t); periods.push(uv); vflag.push(0); t += uv;
    }
  }
  return { marks, periods, vflag };
}

export function psola(x: Float32Array, sr: number, tr: F0Track, opts: PsolaOptions): Float32Array {
  const ts = opts.timeScale ?? 1, n = x.length, nOut = Math.round(n * ts);
  const { marks, periods, vflag } = analysisMarks(x, tr, sr);
  const out = new Float64Array(nOut), wsum = new Float64Array(nOut);
  const hopS = (tr.hop / tr.sampleRate) * sr;
  const ratioAt = (t: number) => typeof opts.ratio === 'number' ? opts.ratio : opts.ratio[Math.min(opts.ratio.length - 1, Math.max(0, Math.round(t / hopS)))] || 1;
  let s = 0, k = 0;
  while (s < nOut && marks.length) {
    const ta = s / ts;
    while (k < marks.length - 1 && Math.abs(marks[k + 1] - ta) <= Math.abs(marks[k] - ta)) k++;
    const m = marks[k], P = periods[k], v = vflag[k];
    const half = Math.max(2, Math.round(P));
    for (let i = -half; i <= half; i++) {
      const src = m + i, dst = Math.round(s) + i;
      if (src < 0 || src >= n || dst < 0 || dst >= nOut) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / half);
      out[dst] += x[src] * w; wsum[dst] += w;
    }
    const r = v ? Math.max(0.25, Math.min(4, ratioAt(m))) : 1;
    s += v ? P / r : P;
  }
  const y = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) y[i] = wsum[i] > 1e-3 ? out[i] / Math.max(wsum[i], 0.5) : 0;
  return y;
}

/** Pitch shift by semitones (scalar or per-frame), formant-preserving. */
export function pitchShift(x: Float32Array, sr: number, tr: F0Track, semitones: Float32Array | number): Float32Array {
  const ratio = typeof semitones === 'number' ? Math.pow(2, semitones / 12) : semitones.map((s) => Math.pow(2, s / 12));
  return psola(x, sr, tr, { ratio });
}

/**
 * Formant shift by `factor` with pitch preserved: resampling moves formants AND pitch by factor,
 * then PSOLA restores pitch and duration.
 */
export function formantShift(x: Float32Array, sr: number, tr: F0Track, factor: number): Float32Array {
  if (Math.abs(factor - 1) < 1e-3) return x;
  const y = resample(x, sr * factor, sr); // plays back factor× faster -> formants & pitch × factor
  const tr2: F0Track = { ...tr, f0: tr.f0.map((f) => f * factor), sampleRate: tr.sampleRate, hop: tr.hop / factor };
  const z = psola(y, sr, tr2, { ratio: 1 / factor, timeScale: factor });
  const out = new Float32Array(x.length); out.set(z.subarray(0, x.length));
  return out;
}
