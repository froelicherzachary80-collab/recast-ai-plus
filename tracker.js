// RECAST AI+ — multi-person identity tracker (pure, unit-tested).
// Detections carry a normalized bbox [x0,y0,x1,y1]; tracker assigns stable integer ids.

export function bboxFromLandmarks(lm, stride, minVis = 0.35, visOffset = 3) {
  // lm: flat Float32Array [x,y,(z),vis,...] with given stride; visOffset index of visibility within stride (-1 = none)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (let i = 0; i + stride - 1 < lm.length; i += stride) {
    if (visOffset >= 0 && lm[i + visOffset] < minVis) continue;
    const x = lm[i], y = lm[i + 1];
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; n++;
  }
  if (n < 3) return null;
  return [x0, y0, x1, y1];
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

const center = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const diag = b => Math.hypot(b[2] - b[0], b[3] - b[1]);

export class Tracker {
  constructor({ maxGap = 30, maxTracks = 12 } = {}) {
    this.maxGap = maxGap; this.maxTracks = maxTracks;
    this.tracks = []; this.nextId = 1;
  }
  /** dets: [{bbox}] — sets det.trackId (or null if no slots). Returns dets. */
  update(frame, dets) {
    const live = this.tracks.filter(t => frame - t.last <= this.maxGap);
    const pairs = [];
    for (let ti = 0; ti < live.length; ti++) {
      const t = live[ti], gap = frame - t.last;
      const pb = [t.bbox[0] + t.vx * gap, t.bbox[1] + t.vy * gap, t.bbox[2] + t.vx * gap, t.bbox[3] + t.vy * gap];
      const [tcx, tcy] = center(pb), td = Math.max(diag(pb), 1e-3);
      for (let di = 0; di < dets.length; di++) {
        const b = dets[di].bbox; if (!b) continue;
        const [cx, cy] = center(b);
        const cd = Math.hypot(cx - tcx, cy - tcy) / td;
        const ov = iou(pb, b);
        const sizeRatio = Math.min(diag(b), td) / Math.max(diag(b), td);
        if (ov < 0.05 && cd > 0.6) continue;
        const score = ov + Math.max(0, 1 - cd) * 0.6 + sizeRatio * 0.2 - gap * 0.002;
        pairs.push({ ti, di, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedT = new Set(), usedD = new Set();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti); usedD.add(p.di);
      const t = live[p.ti], b = dets[p.di].bbox, gap = Math.max(1, frame - t.last);
      const [ocx, ocy] = center(t.bbox), [ncx, ncy] = center(b);
      t.vx = 0.6 * t.vx + 0.4 * ((ncx - ocx) / gap);
      t.vy = 0.6 * t.vy + 0.4 * ((ncy - ocy) / gap);
      t.bbox = b.slice(); t.last = frame; t.hits++;
      dets[p.di].trackId = t.id;
    }
    for (let di = 0; di < dets.length; di++) {
      if (usedD.has(di) || !dets[di].bbox) { if (!usedD.has(di)) dets[di].trackId = null; continue; }
      if (this.tracks.length >= this.maxTracks) { dets[di].trackId = null; continue; }
      const t = { id: this.nextId++, bbox: dets[di].bbox.slice(), last: frame, first: frame, hits: 1, vx: 0, vy: 0 };
      this.tracks.push(t);
      dets[di].trackId = t.id;
    }
    return dets;
  }
}

/** Swap identities of two tracks from frame `from` onward. frames: [{people:[{id}]}] */
export function swapTracksFrom(frames, a, b, from) {
  for (let f = from; f < frames.length; f++) {
    const fr = frames[f]; if (!fr) continue;
    for (const p of fr.people) {
      if (p.id === a) p.id = b; else if (p.id === b) p.id = a;
    }
  }
}

/** Merge track `src` into `dst` (frames where dst already exists keep dst). */
export function mergeTracks(frames, src, dst) {
  for (const fr of frames) {
    if (!fr) continue;
    const hasDst = fr.people.some(p => p.id === dst);
    for (const p of fr.people) if (p.id === src) p.id = hasDst ? -1 : dst;
    fr.people = fr.people.filter(p => p.id !== -1);
  }
}

/** Assign a specific detection (by index in frame) to track `id` from frame f to the end of the
 *  detection's contiguous run (the identity that detection had). */
export function reassignDetection(frames, f, detIndex, id) {
  const det = frames[f]?.people[detIndex];
  if (!det || det.id === id) return;
  const old = det.id;
  // If id already exists at f on a different detection, swap them for the run.
  swapTracksFrom(frames, old, id, f);
}

export function trackSummary(frames) {
  const m = new Map();
  frames.forEach((fr, f) => fr && fr.people.forEach(p => {
    const s = m.get(p.id) || { id: p.id, count: 0, first: f, last: f, faces: 0 };
    s.count++; s.last = f; if (p.face) s.faces++;
    m.set(p.id, s);
  }));
  return [...m.values()].sort((a, b) => b.count - a.count);
}
