// RECAST AI+ — actor detection & tracking pass (real MediaPipe inference per frame).
import { getTask, nextTs, hasModel } from './models.js';
import { iterateFrames } from './media.js';
import { Tracker, bboxFromLandmarks } from './tracker.js';
import { N_FACE } from './facemesh.js';
import { frameSignature, CutDetector, appearance } from './people.js';

/** Runs pose (+face, +hands) on every planned frame. onProgress(done,total,frame). */
export async function analyzeVideo(file, meta, plan, { signal, onProgress, hands = false, poseModel = 'pose_lite' } = {}) {
  const poseKey = (await hasModel(poseModel)) ? poseModel : 'pose_lite';
  const pose = await getTask(poseKey, 'VIDEO', { num: 4 });
  const face = await getTask('face', 'VIDEO', { num: 4 });
  const hand = hands && (await hasModel('hand')) ? await getTask('hand', 'VIDEO') : null;
  let tracker = new Tracker({ maxGap: Math.round(plan.fps * 1.5), maxTracks: 64 });
  const cd = new CutDetector(plan.fps);
  const frames = new Array(plan.frames).fill(null);
  const t0 = performance.now(); let done = 0;
  for await (const { index, canvas } of iterateFrames(file, meta, plan, { signal })) {
    if (signal?.aborted) break;
    // shot cuts: restart identity tracking so a new shot never continues someone else's track
    if (cd.push(frameSignature(canvas), index).cut) { const next = tracker.nextId; tracker = new Tracker({ maxGap: Math.round(plan.fps * 1.5), maxTracks: 64 }); tracker.nextId = next; }
    const people = detectPeople(pose, face, canvas);
    tracker.update(index, people);
    const kept = people.filter(p => p.trackId != null).map(p => ({ id: p.trackId, pose: p.pose, face: p.face, bbox: p.bbox, faceOnly: !!p.faceOnly, desc: appearance(canvas, plan.width, plan.height, p) }));
    const entry = { people: kept };
    if (hand) {
      const hr = hand.detectForVideo(canvas, nextTs());
      entry.hands = (hr.landmarks || []).map(h => { const a = new Float32Array(63); h.forEach((l, i) => { a[i * 3] = l.x; a[i * 3 + 1] = l.y; a[i * 3 + 2] = l.z; }); return a; });
    }
    frames[index] = entry; done++;
    onProgress?.(done, plan.frames, { index, people: kept.length, fps: done / ((performance.now() - t0) / 1000) });
    if (done % 2 === 0) await new Promise(r => setTimeout(r, 0)); // let the UI breathe
  }
  for (let i = 0; i < frames.length; i++) if (!frames[i]) frames[i] = { people: [], missing: true };
  return { frames, cuts: cd.cuts, fps: plan.fps, poseModel: poseKey, hands: !!hand, completed: done, total: plan.frames, cancelled: !!signal?.aborted, at: Date.now() };
}

/** Detect people (pose + associated face) on one frame. Returns [{pose, face, bbox, faceOnly}] without ids. */
export function detectPeople(pose, face, canvas) {
    const pr = pose.detectForVideo(canvas, nextTs());
    const fr = face.detectForVideo(canvas, nextTs());
    const people = [];
    for (const lms of pr.landmarks || []) {
      const p = new Float32Array(33 * 4);
      lms.forEach((l, i) => { p[i * 4] = l.x; p[i * 4 + 1] = l.y; p[i * 4 + 2] = l.z; p[i * 4 + 3] = l.visibility ?? 1; });
      const bb = bboxFromLandmarks(p, 4, 0.35, 3);
      if (bb) people.push({ pose: p, bbox: bb, face: null });
    }
    // associate faces with people (nearest pose nose inside bbox); unmatched faces become face-only detections
    for (const fl of fr.faceLandmarks || []) {
      const f = new Float32Array(N_FACE * 3);
      for (let i = 0; i < N_FACE; i++) { const l = fl[i] || fl[fl.length - 1]; f[i * 3] = l.x; f[i * 3 + 1] = l.y; f[i * 3 + 2] = l.z; }
      const nx = f[3], ny = f[4];
      let best = null, bd = Infinity;
      for (const p of people) {
        if (p.face) continue;
        const [x0, y0, x1, y1] = p.bbox, h = y1 - y0, padX = (x1 - x0) * 0.25, padY = h * 0.15;
        if (nx < x0 - padX || nx > x1 + padX || ny < y0 - padY || ny > y1 + padY) continue;
        const d = p.pose[3] >= 0.3 ? Math.hypot(p.pose[0] - nx, p.pose[1] - ny) / Math.max(h, 1e-3) : 0.5;
        if (d < bd) { bd = d; best = p; }
      }
      if (best && bd < 0.6) best.face = f;
      else { const bb = bboxFromLandmarks(f, 3, 0, -1); if (bb) { const w = bb[2] - bb[0], hh = bb[3] - bb[1]; people.push({ pose: null, face: f, bbox: [bb[0] - w * 0.3, bb[1] - hh * 0.4, bb[2] + w * 0.3, bb[3] + hh * 0.3], faceOnly: true }); } }
    }
  return people;
}
