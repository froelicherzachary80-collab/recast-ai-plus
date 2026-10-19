import test from 'node:test';
import assert from 'node:assert/strict';
import { restInfo, fk, fromJoints, restPose, ik2, dragJoint, samplePose, mirrorPose, PRESETS, retargetFrames, LIMBS } from '../poserig.js';

const R = { nose: [100, 30], neck: [100, 70], pelvis: [100, 200], lSh: [130, 70], rSh: [70, 70], lEl: [150, 130], rEl: [50, 130], lWr: [160, 190], rWr: [40, 190], lHip: [120, 200], rHip: [80, 200], lKn: [125, 300], rKn: [75, 300], lAn: [125, 390], rAn: [75, 390] };
const I = restInfo(R);
const close = (a, b, e = 1e-6) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e;
const boneLens = J => Object.fromEntries(Object.entries(LIMBS).map(([k, [a, b]]) => [k, Math.hypot(J[b][0] - J[a][0], J[b][1] - J[a][1])]));

test('fromJoints → fk reproduces the photo joints', () => {
  const J = fk(fromJoints(R, I), I);
  for (const k of Object.keys(R)) assert.ok(close(J[k], R[k], 1e-6), k);
});

test('rest pose places the pelvis and scales uniformly', () => {
  const J = fk(restPose(I, 500, 600, 2), I);
  assert.ok(close(J.pelvis, [500, 600]));
  assert.ok(Math.abs(Math.hypot(J.neck[0] - J.pelvis[0], J.neck[1] - J.pelvis[1]) - 260) < 1e-6);
});

test('two-bone IK reaches reachable targets and keeps bend side', () => {
  const { mid, end } = ik2([0, 0], [100, 0], 60, 60, [50, 40]);
  assert.ok(close(end, [100, 0], 1e-6)); assert.ok(mid[1] > 0, 'bends toward previous side');
  assert.ok(Math.abs(Math.hypot(mid[0], mid[1]) - 60) < 1e-6);
  const far = ik2([0, 0], [500, 0], 60, 60, null); assert.ok(far.end[0] < 120.01);
});

test('dragging a wrist bends the arm but keeps bone lengths', () => {
  const P = restPose(I, 100, 200, 1), before = boneLens(fk(P, I));
  const Q = dragJoint(P, I, 'lWr', [190, 90]), J = fk(Q, I), after = boneLens(J);
  for (const k of Object.keys(before)) assert.ok(Math.abs(before[k] - after[k]) < 1e-6, k);
  assert.ok(Math.hypot(J.lWr[0] - 190, J.lWr[1] - 90) < 1e-3, 'wrist reached target');
  assert.ok(close(J.rWr, fk(P, I).rWr), 'other arm untouched');
});

test('dragging the pelvis moves the whole body; neck rotates torso with arms', () => {
  const P = restPose(I, 100, 200, 1), Q = dragJoint(P, I, 'pelvis', [300, 260]), A = fk(P, I), B = fk(Q, I);
  assert.ok(close([B.lAn[0] - A.lAn[0], B.lAn[1] - A.lAn[1]], [200, 60], 1e-6));
  const T = dragJoint(P, I, 'neck', [200, 100]), C = fk(T, I);
  assert.ok(C.neck[0] > 150, 'torso leaned right'); assert.ok(close(C.lAn, A.lAn, 1e-6), 'legs stay planted');
});

test('keyframe sampling eases between poses and loops', () => {
  const a = restPose(I, 0, 0, 1), b = { ...a, x: 100, a: { ...a.a } };
  const d = { keys: [{ t: 0, pose: a }, { t: 1, pose: b }], duration: 2, loop: true, ease: 'linear' };
  assert.equal(samplePose(d, 0.5).x, 50); assert.equal(samplePose(d, 1).x, 100);
  assert.ok(Math.abs(samplePose(d, 1.5).x - 50) < 1e-9, 'loops back toward first key');
  assert.equal(samplePose(d, 2.5).x, 50);
});

test('mirror is its own inverse and swaps sides', () => {
  const P = dragJoint(restPose(I, 100, 200, 1), I, 'lWr', [190, 90]), M = mirrorPose(P, 100), MM = mirrorPose(M, 100);
  for (const k of Object.keys(P.a)) assert.ok(Math.abs(Math.sin(P.a[k] - MM.a[k])) < 1e-9 && Math.cos(P.a[k] - MM.a[k]) > 0, k);
  const J = fk(M, I); assert.ok(J.rWr[0] < 50, 'raised arm now on the other side');
});

test('every dance preset produces finite poses inside a sane area', () => {
  const base = restPose(I, 500, 700, 2);
  for (const [k, pr] of Object.entries(PRESETS)) {
    const keys = pr.make(I, base); assert.ok(keys.length >= 3, k);
    for (let t = 0; t <= pr.duration; t += 0.1) {
      const J = fk(samplePose({ keys, duration: pr.duration, loop: true }, t), I);
      for (const [n, v] of Object.entries(J)) { assert.ok(Number.isFinite(v[0]) && Number.isFinite(v[1]), `${k} ${n}`); assert.ok(Math.abs(v[0] - 500) < 900 && Math.abs(v[1] - 700) < 900, `${k} ${n} out of frame`); }
    }
  }
});

test('retargeting a dancer keeps my proportions and scales root motion', () => {
  // dancer is half my size and moves right by 50px
  const mk = dx => { const f = new Float32Array(66); const set = (i, p) => { f[i * 2] = p[0] * 0.5 + dx; f[i * 2 + 1] = p[1] * 0.5; }; const m = { 0: 'nose', 11: 'lSh', 12: 'rSh', 13: 'lEl', 14: 'rEl', 15: 'lWr', 16: 'rWr', 23: 'lHip', 24: 'rHip', 25: 'lKn', 26: 'rKn', 27: 'lAn', 28: 'rAn' }; for (const [i, n] of Object.entries(m)) set(+i, R[n]); return f; };
  const out = retargetFrames([mk(0), null, mk(50)], I, [400, 400], 1);
  assert.equal(out.length, 3); assert.ok(out[1], 'gap holds last pose');
  assert.ok(Math.abs(out[2].x - 500) < 1e-6, 'root motion scaled ×2 to my torso');
  const J = fk(out[2], I); assert.ok(Math.abs(Math.hypot(J.neck[0] - J.pelvis[0], J.neck[1] - J.pelvis[1]) - 130) < 1e-6);
});
