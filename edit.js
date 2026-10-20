// RECAST AI+ v0.5 — beat-synced edit timeline (pure, unit-tested).
export const TRANSITIONS = {
  cut: { name: 'Cut', dur: 0 },
  flash: { name: 'White flash', dur: 0.12 },
  dip: { name: 'Black flash', dur: 0.2 },
  zoom: { name: 'Zoom punch', dur: 0.18 },
  slide: { name: 'Whip slide', dur: 0.2 },
  shake: { name: 'Shake', dur: 0.25 },
  glitch: { name: 'Glitch', dur: 0.15 },
  fade: { name: 'Crossfade', dur: 0.25 },
};
const segId = (() => { let n = 0; return () => 's' + (++n).toString(36) + Math.random().toString(36).slice(2, 5); })();

/** Cut points (output seconds) from music beats. every: 0.5 | 1 | 2 | 4 beats. */
export function cutGrid(beats, musicStart, length, every = 1, minGap = 0.15) {
  let pts = [];
  const bs = beats.map(b => b - musicStart);
  if (every < 1) { for (let i = 0; i < bs.length; i++) { pts.push(bs[i]); if (i + 1 < bs.length) pts.push((bs[i] + bs[i + 1]) / 2); } }
  else { const step = Math.round(every); pts = bs.filter((_, i) => i % step === 0); }
  pts = pts.filter(t => t > minGap && t < length - minGap);
  const out = [0];
  for (const t of pts) if (t - out[out.length - 1] >= minGap) out.push(t);
  out.push(length);
  return out;
}

function pickTransition(style, i, isStrong) {
  if (i === 0) return style === 'cut' ? 'cut' : 'dip';
  if (style !== 'auto') return style;
  if (i % 8 === 0) return 'slide';
  if (isStrong) return i % 2 ? 'flash' : 'zoom';
  return 'cut';
}

/** Build segments. clips: [{id, dur, inPoint=0, kind}] (stills have dur Infinity). */
export function buildAutoEdit({ clips, beats, strong = [], musicStart = 0, length, every = 1, style = 'auto', speed = 1 }) {
  if (!clips.length) return [];
  const grid = cutGrid(beats, musicStart, length, every), cursor = new Map(clips.map(c => [c.id, c.inPoint || 0]));
  const strongSet = strong.map(b => b - musicStart);
  const segs = [];
  for (let i = 0; i < grid.length - 1; i++) {
    const c = clips[i % clips.length], t0 = grid[i], t1 = grid[i + 1], need = (t1 - t0) * speed;
    let src = cursor.get(c.id);
    const end = isFinite(c.dur) ? c.dur : Infinity;
    if (src + need > end) src = Math.min(c.inPoint || 0, Math.max(0, end - need));
    cursor.set(c.id, src + need);
    const type = pickTransition(style, i, strongSet.some(s => Math.abs(s - t0) < 0.06));
    segs.push({ id: segId(), clipId: c.id, t0, t1, src, speed, trans: { type, dur: TRANSITIONS[type]?.dur ?? 0 } });
  }
  return segs;
}

/** What plays at output time t. */
export function frameAt(segs, t) {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m - 1; }
  const seg = segs[lo]; if (!seg) return null;
  const local = Math.max(0, t - seg.t0);
  const tp = seg.trans.dur > 0 && local < seg.trans.dur ? local / seg.trans.dur : null;
  return { i: lo, seg, local, src: seg.src + local * seg.speed, trans: tp };
}

/** Beat pulse 0..1 (decays after each beat) for zoom-on-beat. */
export function beatPulse(beats, musicStart, t, decay = 0.12) {
  const mt = t + musicStart; let last = -Infinity;
  for (const b of beats) { if (b <= mt) last = b; else break; }
  return isFinite(last) ? Math.exp(-(mt - last) / decay) : 0;
}

/** Keep segments contiguous after editing one segment's length (later segments shift). */
export function resizeSegment(segs, i, newDur, minDur = 0.1) {
  const d = Math.max(minDur, newDur) - (segs[i].t1 - segs[i].t0);
  segs[i].t1 += d; for (let k = i + 1; k < segs.length; k++) { segs[k].t0 += d; segs[k].t1 += d; }
  return segs;
}
export const editLength = segs => (segs.length ? segs[segs.length - 1].t1 : 0);
