// RECAST AI+ — MotionLock temporal processing (pure, unit-tested).

/** One Euro filter (Casiez et al. 2012) over a vector of values. */
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = null; this.t = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset() { this.x = this.dx = this.t = null; }
  filter(v, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      this.x = Float32Array.from(v); this.dx = new Float32Array(v.length); this.t = t; return Float32Array.from(this.x);
    }
    const dt = t - this.t; this.t = t;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx[i] = this.dx[i] + ad * (d - this.dx[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx[i]);
      const a = OneEuro.alpha(cutoff, dt);
      this.x[i] = this.x[i] + a * (v[i] - this.x[i]);
      out[i] = this.x[i];
    }
    return out;
  }
}

/** Linear fill of gaps ≤ maxGap between present samples. series: Array<Float32Array|null>.
 *  Returns {series, interp:Uint8Array} — interp[i]=1 where filled. Long gaps stay null. */
export function fillGaps(series, maxGap) {
  const out = series.slice(), interp = new Uint8Array(series.length);
  let last = -1;
  for (let i = 0; i < series.length; i++) {
    if (!series[i]) continue;
    if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
      const a = series[last], b = series[i];
      if (a.length === b.length) {
        for (let k = last + 1; k < i; k++) {
          const t = (k - last) / (i - last), v = new Float32Array(a.length);
          for (let j = 0; j < a.length; j++) v[j] = a[j] + (b[j] - a[j]) * t;
          out[k] = v; interp[k] = 1;
        }
      }
    }
    last = i;
  }
  return { series: out, interp };
}

/** Smooth a series with One Euro, resetting across long gaps (null entries). */
export function smoothSeries(series, fps, minCutoff, beta) {
  const f = new OneEuro(minCutoff, beta);
  return series.map((v, i) => {
    if (!v) { f.reset(); return null; }
    return f.filter(v, i / fps);
  });
}

/** Mean frame-to-frame displacement of point index k (stride s) — jitter metric. */
export function meanStep(series, k, s) {
  let sum = 0, n = 0;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (!a || !b) continue;
    sum += Math.hypot(b[k * s] - a[k * s], b[k * s + 1] - a[k * s + 1]); n++;
  }
  return n ? sum / n : 0;
}

/** Second-difference energy (acceleration jitter) at point k. */
export function jitter(series, k, s) {
  let sum = 0, n = 0;
  for (let i = 2; i < series.length; i++) {
    const a = series[i - 2], b = series[i - 1], c = series[i];
    if (!a || !b || !c) continue;
    sum += Math.hypot(c[k * s] - 2 * b[k * s] + a[k * s], c[k * s + 1] - 2 * b[k * s + 1] + a[k * s + 1]); n++;
  }
  return n ? sum / n : 0;
}

/** Build per-track motion series (pose stride 4: x,y,z,vis; face stride 3) with gap fill + smoothing. */
export function buildMotion(frames, trackId, fps, { minCutoff = 1.2, beta = 0.02, maxGap = 6 } = {}) {
  const pose = frames.map(fr => fr?.people.find(p => p.id === trackId)?.pose || null);
  const face = frames.map(fr => fr?.people.find(p => p.id === trackId)?.face || null);
  const bbox = frames.map(fr => { const b = fr?.people.find(p => p.id === trackId)?.bbox; return b ? Float32Array.from(b) : null; });
  const P = fillGaps(pose, maxGap), F = fillGaps(face, maxGap), B = fillGaps(bbox, maxGap);
  return {
    pose: smoothSeries(P.series, fps, minCutoff, beta),
    face: smoothSeries(F.series, fps, minCutoff, beta),
    bbox: smoothSeries(B.series, fps, minCutoff, beta),
    rawFace: face, rawPose: pose,
    poseInterp: P.interp, faceInterp: F.interp,
  };
}
