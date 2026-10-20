// RECAST AI+ v0.5 — multi-actor casting across cuts.
// 1) Shot-cut detection, so tracking restarts at every cut instead of jumping between people.
// 2) A small appearance signature per detection (face, hair and clothing colours + face proportions).
// 3) Grouping of tracks into People: the same person in different shots becomes one cast slot.
// Pure functions (unit-tested) except the two marked "browser".

/** browser: 24×14 grey thumbnail + 16-bin histogram of a frame. */
let sigC = null;
export function frameSignature(canvas) {
  sigC ||= Object.assign(document.createElement('canvas'), { width: 24, height: 14 });
  const c = sigC.getContext('2d', { willReadFrequently: true }); c.imageSmoothingQuality = 'low';
  c.drawImage(canvas, 0, 0, 24, 14);
  const d = c.getImageData(0, 0, 24, 14).data, g = new Float32Array(24 * 14);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return { g, hist: softHist(g) };
}

/** Soft (linearly interpolated) 16-bin histogram, so a small brightness change does not jump bins. */
export function softHist(g) {
  const hist = new Float32Array(16);
  for (let i = 0; i < g.length; i++) { const x = Math.max(0, Math.min(15, g[i] / 16 - 0.5)), b = Math.floor(x), f = x - b; hist[b] += 1 - f; if (b < 15) hist[b + 1] += f; }
  for (let i = 0; i < 16; i++) hist[i] /= g.length;
  return hist;
}
/** Cut score between two signatures: 0 = identical, ~1 = totally different. */
export function cutScore(a, b) {
  if (!a || !b) return 0;
  let mad = 0; for (let i = 0; i < a.g.length; i++) mad += Math.abs(a.g[i] - b.g[i]); mad /= a.g.length * 255;
  const ha = a.hist || (a.hist = softHist(a.g)), hb = b.hist || (b.hist = softHist(b.g));
  let hd = 0; for (let i = 0; i < 16; i++) hd += Math.abs(ha[i] - hb[i]); hd /= 2;
  return Math.max(mad * 2.2, hd);
}
/** Cut if the jump is large and clearly bigger than the motion just before it (avoids flagging fast pans). */
export function isCut(score, recent, { thr = 0.32 } = {}) {
  const base = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
  return score > thr && score > base * 2.5 + 0.08;
}

/** browser: appearance descriptor for a detection (Float32, 0..1 colours + face ratios). */
let dC = null;
export function appearance(canvas, W, H, det) {
  dC ||= Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
  const c = dC.getContext('2d', { willReadFrequently: true });
  const sample = (x0, y0, x1, y1, n) => {
    const w = Math.max(2, (x1 - x0) * W), hh = Math.max(2, (y1 - y0) * H);
    c.clearRect(0, 0, n, n); c.drawImage(canvas, x0 * W, y0 * H, w, hh, 0, 0, n, n);
    const d = c.getImageData(0, 0, n, n).data, out = []; for (let i = 0; i < n * n; i++) out.push(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255);
    return out;
  };
  const [bx0, by0, bx1, by1] = det.bbox, bw = bx1 - bx0, bh = by1 - by0;
  let face, hair, torso, geo = [0, 0, 0, 0];
  if (det.face) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (let i = 0; i < det.face.length; i += 3) { x0 = Math.min(x0, det.face[i]); y0 = Math.min(y0, det.face[i + 1]); x1 = Math.max(x1, det.face[i]); y1 = Math.max(y1, det.face[i + 1]); }
    const fw = x1 - x0, fh = y1 - y0;
    face = sample(x0 + fw * 0.2, y0 + fh * 0.25, x1 - fw * 0.2, y1 - fh * 0.15, 2);
    hair = sample(x0, Math.max(0, y0 - fh * 0.35), x1, y0 + fh * 0.05, 2);
    geo = faceGeometry(det.face);
  } else { face = sample(bx0 + bw * 0.3, by0, bx1 - bw * 0.3, by0 + bh * 0.15, 2); hair = sample(bx0 + bw * 0.25, Math.max(0, by0 - bh * 0.03), bx1 - bw * 0.25, by0 + bh * 0.05, 2); }
  if (det.pose && det.pose[11 * 4 + 3] > 0.4 && det.pose[23 * 4 + 3] > 0.3) {
    const P = det.pose, sx = (P[11 * 4] + P[12 * 4]) / 2, sy = (P[11 * 4 + 1] + P[12 * 4 + 1]) / 2, hy = (P[23 * 4 + 1] + P[24 * 4 + 1]) / 2, sw = Math.abs(P[11 * 4] - P[12 * 4]);
    torso = sample(sx - sw * 0.4, sy + (hy - sy) * 0.1, sx + sw * 0.4, sy + (hy - sy) * 0.7, 2);
  } else torso = sample(bx0 + bw * 0.25, by0 + bh * 0.45, bx1 - bw * 0.25, by0 + bh * 0.7, 2);
  return Float32Array.from([...face, ...hair, ...torso, ...geo]);
}

/** Face proportions that change little with expression: eye spacing, nose length, mouth width, jaw width (÷ face width). */
export function faceGeometry(f, s = 3) {
  const p = i => [f[i * s], f[i * s + 1]], d = (a, b) => Math.hypot(p(a)[0] - p(b)[0], p(a)[1] - p(b)[1]);
  const fw = d(234, 454) || 1;
  return [d(33, 263) / fw, d(168, 1) / fw, d(61, 291) / fw, d(172, 397) / fw];
}

/** Per-track summary: mean descriptor, frames present, shots. */
export function summarizeTracks(frames, shotOf) {
  const m = new Map();
  frames.forEach((fr, f) => fr?.people.forEach(p => {
    let s = m.get(p.id); if (!s) { s = { id: p.id, frames: new Set(), shots: new Set(), sum: null, n: 0, faces: 0, size: 0 }; m.set(p.id, s); }
    s.frames.add(f); s.shots.add(shotOf ? shotOf(f) : 0); s.size += (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]);
    if (p.face) s.faces++;
    if (p.desc) { if (!s.sum) s.sum = new Float32Array(p.desc.length); for (let i = 0; i < p.desc.length; i++) s.sum[i] += p.desc[i]; s.n++; }
  }));
  return [...m.values()].map(s => ({ id: s.id, frames: s.frames, shots: [...s.shots], desc: s.sum ? s.sum.map(v => v / s.n) : null, count: s.frames.size, faces: s.faces, size: s.size / s.frames.size }));
}

/** Distance between two descriptors (colour parts weighted, geometry only when both have faces). */
export function descDistance(a, b) {
  if (!a || !b) return Infinity;
  const nc = a.length - 4; let c = 0;
  for (let i = 0; i < nc; i++) c += (a[i] - b[i]) ** 2;
  c = Math.sqrt(c / nc);
  const ga = a.subarray ? a.subarray(nc) : a.slice(nc), gb = b.subarray ? b.subarray(nc) : b.slice(nc);
  let g = 0, has = ga[0] > 0 && gb[0] > 0;
  if (has) { for (let i = 0; i < 4; i++) g += Math.abs(ga[i] - gb[i]) / Math.max(0.05, (ga[i] + gb[i]) / 2); g /= 4; }
  return has ? c * 0.7 + g * 0.6 : c;
}

/** Group tracks into people. Tracks that are on screen at the same time can never be the same person. */
export function groupTracks(tracks, { thr = 0.16, minFrames = 3 } = {}) {
  const T = tracks.filter(t => t.count >= minFrames);
  let groups = T.map(t => ({ tracks: [t], frames: new Set(t.frames), desc: t.desc, weight: t.count }));
  const overlap = (a, b) => { const [s, l] = a.frames.size < b.frames.size ? [a.frames, b.frames] : [b.frames, a.frames]; for (const f of s) if (l.has(f)) return true; return false; };
  for (;;) {
    let best = null, bd = thr;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const d = descDistance(groups[i].desc, groups[j].desc);
      if (d < bd && !overlap(groups[i], groups[j])) { bd = d; best = [i, j]; }
    }
    if (!best) break;
    const [i, j] = best, A = groups[i], B = groups[j], w = A.weight + B.weight;
    const desc = A.desc && B.desc ? A.desc.map((v, k) => (v * A.weight + B.desc[k] * B.weight) / w) : A.desc || B.desc;
    groups[i] = { tracks: [...A.tracks, ...B.tracks], frames: new Set([...A.frames, ...B.frames]), desc, weight: w };
    groups.splice(j, 1);
  }
  const rest = tracks.filter(t => t.count < minFrames).map(t => ({ tracks: [t], frames: t.frames, desc: t.desc, weight: t.count }));
  return [...groups, ...rest].sort((a, b) => b.weight - a.weight).map((g, i) => ({ id: 'g' + (i + 1), name: 'Person ' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''), tracks: g.tracks.map(t => t.id), frames: g.weight }));
}

/** Shot index lookup from sorted cut frames. */
export const shotLookup = cuts => f => { let s = 0; for (const c of cuts) if (f >= c) s++; else break; return s; };

/** Streaming cut detector. push(sig, frame) → { cut, newShot }: `cut` = restart tracking now; `newShot` = start of
 *  a new shot (transitions that flash through several frames count once). */
export class CutDetector {
  constructor(fps = 30, { minShot = 0.15 } = {}) { this.prev = null; this.recent = []; this.cuts = []; this.minFrames = Math.max(2, Math.round(fps * minShot)); }
  push(sig, f) {
    const sc = cutScore(this.prev, sig), cut = !!this.prev && isCut(sc, this.recent);
    this.prev = sig;
    if (!cut) { this.recent.push(sc); if (this.recent.length > 8) this.recent.shift(); return { cut: false, newShot: false }; }
    this.recent.length = 0;
    const last = this.cuts[this.cuts.length - 1];
    if (last !== undefined && f - last < this.minFrames) { this.cuts[this.cuts.length - 1] = f; return { cut: true, newShot: false }; }
    this.cuts.push(f); return { cut: true, newShot: true };
  }
}
