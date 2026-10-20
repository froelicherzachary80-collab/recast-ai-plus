/**
 * YIN fundamental-frequency tracker (de Cheveigné & Kawahara 2002) with parabolic
 * interpolation, octave-jump smoothing and a voicing decision.
 * Default framing (16 kHz, hop 160) matches RVC's 100 frames/s pitch grid.
 */
export interface F0Track { f0: Float32Array; voiced: Uint8Array; periodicity: Float32Array; hop: number; sampleRate: number; }

export interface F0Options { hop?: number; window?: number; fmin?: number; fmax?: number; threshold?: number; }

export function yinF0(x: Float32Array, sampleRate: number, o: F0Options = {}): F0Track {
  const hop = o.hop ?? Math.round(sampleRate / 100);
  const fmin = o.fmin ?? 50, fmax = o.fmax ?? 1100, thr = o.threshold ?? 0.15;
  const W = o.window ?? Math.max(512, Math.ceil((sampleRate / fmin) * 2));
  const tauMin = Math.max(2, Math.floor(sampleRate / fmax)), tauMax = Math.min(W - 1, Math.ceil(sampleRate / fmin));
  const frames = Math.floor(x.length / hop) + 1;
  const f0 = new Float32Array(frames), voiced = new Uint8Array(frames), per = new Float32Array(frames);
  const d = new Float64Array(tauMax + 2);
  // energy gate relative to global RMS
  let g = 0; for (let i = 0; i < x.length; i++) g += x[i] * x[i];
  const gRms = Math.sqrt(g / Math.max(1, x.length));
  for (let t = 0; t < frames; t++) {
    const start = t * hop - (W >> 1);
    let e = 0;
    for (let i = 0; i < W; i++) { const k = start + i; const v = k >= 0 && k < x.length ? x[k] : 0; e += v * v; }
    const fr = Math.sqrt(e / W);
    if (fr < gRms * 0.05 || fr < 1e-4) { per[t] = 0; continue; }
    d.fill(0);
    const Wd = W - tauMax;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < Wd; i++) {
        const a = start + i, b = a + tau;
        const va = a >= 0 && a < x.length ? x[a] : 0, vb = b >= 0 && b < x.length ? x[b] : 0;
        const df = va - vb; s += df * df;
      }
      d[tau] = s;
    }
    // cumulative mean normalised difference
    let run = 0; d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; d[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
    let tauBest = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < thr) { while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++; tauBest = tau; break; }
    }
    if (tauBest < 0) {
      let mi = tauMin; for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[mi]) mi = tau;
      per[t] = 1 - d[mi];
      if (d[mi] < 0.3) tauBest = mi; else continue;
    }
    const a = d[tauBest - 1] ?? d[tauBest], b = d[tauBest], c = d[tauBest + 1] ?? d[tauBest];
    const den = a - 2 * b + c, shift = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
    const tauF = tauBest + Math.max(-1, Math.min(1, shift));
    f0[t] = sampleRate / tauF; voiced[t] = 1; per[t] = 1 - b;
  }
  removeOctaveGlitches(f0, voiced);
  return { f0, voiced, periodicity: per, hop, sampleRate };
}

/** Median-based correction of isolated octave errors and 1-frame voicing blips. */
export function removeOctaveGlitches(f0: Float32Array, voiced: Uint8Array) {
  const n = f0.length, out = f0.slice();
  for (let i = 0; i < n; i++) {
    if (!voiced[i]) continue;
    const win: number[] = [];
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) if (voiced[k]) win.push(f0[k]);
    if (win.length < 3) continue;
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1], r = f0[i] / med;
    if (r > 1.8 && r < 2.2) out[i] = f0[i] / 2; else if (r > 0.45 && r < 0.55) out[i] = f0[i] * 2;
  }
  for (let i = 1; i < n - 1; i++) if (voiced[i] && !voiced[i - 1] && !voiced[i + 1]) { voiced[i] = 0; out[i] = 0; }
  f0.set(out);
}

export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m: number) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/** Robust range (5th..95th percentile) of voiced pitch, in MIDI. */
export function pitchRange(tr: F0Track): { low: number; high: number; median: number } | null {
  const v: number[] = [];
  for (let i = 0; i < tr.f0.length; i++) if (tr.voiced[i]) v.push(hzToMidi(tr.f0[i]));
  if (v.length < 5) return null;
  v.sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { low: q(0.05), high: q(0.95), median: q(0.5) };
}
