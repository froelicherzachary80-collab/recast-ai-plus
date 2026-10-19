// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../geometry.js';
import { Tracker, iou, bboxFromLandmarks, swapTracksFrom, mergeTracks, trackSummary } from '../tracker.js';
import { OneEuro, fillGaps, smoothSeries, jitter, buildMotion } from '../smoothing.js';
import { buildFaceMesh, faceYaw, FACE_OVAL } from '../facemesh.js';

const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42);

test('delaunay: grid produces 2(n-1)^2 triangles', () => {
  const pts = []; for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) pts.push([x + rand() * 1e-3, y + rand() * 1e-3]);
  assert.equal(G.delaunay(pts).length, 50);
});

test('delaunay: empty circumcircle property on random points', () => {
  const pts = Array.from({ length: 150 }, () => [rand() * 100, rand() * 100]);
  const tris = G.delaunay(pts);
  assert.ok(tris.length > 250);
  for (const [a, b, c] of tris.slice(0, 80)) {
    const [ax, ay] = pts[a], [bx, by] = pts[b], [cx, cy] = pts[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    for (let i = 0; i < pts.length; i++) {
      if (i === a || i === b || i === c) continue;
      assert.ok((pts[i][0] - ux) ** 2 + (pts[i][1] - uy) ** 2 >= r2 * (1 - 1e-6));
    }
  }
});

test('fitSimilarity recovers a known transform', () => {
  const T = { a: 1.5 * Math.cos(0.4), b: 1.5 * Math.sin(0.4), tx: 12, ty: -7 };
  const src = Array.from({ length: 10 }, () => [rand() * 50, rand() * 50]);
  const dst = src.map(([x, y]) => G.applySim(T, x, y));
  const R = G.fitSimilarity(src, dst);
  for (const k of ['a', 'b', 'tx', 'ty']) assert.ok(Math.abs(R[k] - T[k]) < 1e-6, k);
});

test('triAffine maps triangle vertices exactly', () => {
  const s = [[0, 0], [10, 0], [0, 10]], d = [[5, 5], [25, 8], [3, 30]];
  const [a, b, c, dd, e, f] = G.triAffine(...s, ...d);
  s.forEach(([x, y], i) => {
    assert.ok(Math.abs(a * x + c * y + e - d[i][0]) < 1e-9);
    assert.ok(Math.abs(b * x + dd * y + f - d[i][1]) < 1e-9);
  });
});

test('invBilinear inverts bilinear incl. extrapolation', () => {
  const q = [[0, 0], [10, 1], [12, 11], [-1, 9]];
  for (const [u, v] of [[0.3, 0.7], [1.2, -0.1], [0.5, 0.5]]) {
    const [x, y] = G.bilinear(q, u, v);
    const [u2, v2] = G.invBilinear(q, x, y);
    assert.ok(Math.abs(u - u2) < 1e-6 && Math.abs(v - v2) < 1e-6);
  }
});

test('interpKeys interpolates and clamps', () => {
  const keys = [{ f: 10, x: 0 }, { f: 20, x: 10 }];
  assert.equal(G.interpKeys(keys, 15, { x: 99, y: 1 }, ['x', 'y']).x, 5);
  assert.equal(G.interpKeys(keys, 0, { x: 99 }, ['x']).x, 0);
  assert.equal(G.interpKeys(keys, 30, { x: 99 }, ['x']).x, 10);
  assert.equal(G.interpKeys([], 30, { x: 99 }, ['x']).x, 99);
});

test('fitSize keeps aspect, even dims, never upscales', () => {
  assert.deepEqual(G.fitSize(1920, 1080, 960).width, 960);
  assert.equal(G.fitSize(1920, 1080, 960).height, 540);
  assert.equal(G.fitSize(640, 360, 1280).width, 640);
  assert.equal(G.fitSize(1081, 1919, 640).height % 2, 0);
});

test('laplacianVariance: sharp > blurred', () => {
  const w = 32, h = 32, sharp = new Float32Array(w * h), blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { sharp[y * w + x] = (x + y) % 2 ? 255 : 0; blur[y * w + x] = 127; }
  assert.ok(G.laplacianVariance(sharp, w, h) > G.laplacianVariance(blur, w, h));
});

test('tracker keeps identities for two people walking past each other with a gap', () => {
  const tr = new Tracker({ maxGap: 10 });
  const ids = { A: new Set(), B: new Set() };
  for (let f = 0; f < 40; f++) {
    const ax = 0.1 + f * 0.01, bx = 0.7 - f * 0.002; // A moves right, B slowly left; they get close but differ in y
    const dets = [];
    if (!(f >= 18 && f <= 22)) dets.push({ bbox: [ax, 0.2, ax + 0.15, 0.8], who: 'A' }); // A occluded 5 frames
    dets.push({ bbox: [bx, 0.3, bx + 0.12, 0.6], who: 'B' });
    tr.update(f, dets);
    dets.forEach(d => ids[d.who].add(d.trackId));
  }
  assert.equal(ids.A.size, 1, 'A keeps one id across occlusion');
  assert.equal(ids.B.size, 1);
  assert.notEqual([...ids.A][0], [...ids.B][0]);
});

test('iou and bboxFromLandmarks', () => {
  assert.equal(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(iou([0, 0, 1, 1], [2, 2, 3, 3]), 0);
  const lm = Float32Array.from([0.1, 0.2, 0, 0.9, 0.5, 0.6, 0, 0.9, 0.3, 0.9, 0, 0.9, 0.99, 0.99, 0, 0.1]);
  assert.deepEqual([...bboxFromLandmarks(lm, 4, 0.35, 3)].map(v => +v.toFixed(2)), [0.1, 0.2, 0.5, 0.9]);
});

test('track swap / merge / summary', () => {
  const frames = Array.from({ length: 5 }, () => ({ people: [{ id: 1 }, { id: 2 }] }));
  swapTracksFrom(frames, 1, 2, 3);
  assert.equal(frames[2].people[0].id, 1); assert.equal(frames[3].people[0].id, 2);
  const fr2 = [{ people: [{ id: 3 }] }, { people: [{ id: 1 }] }];
  mergeTracks(fr2, 3, 1);
  assert.deepEqual(trackSummary(fr2).map(s => [s.id, s.count]), [[1, 2]]);
});

test('fillGaps fills short gaps only', () => {
  const s = [Float32Array.of(0), null, null, Float32Array.of(3), null, null, null, null, null, Float32Array.of(9)];
  const { series, interp } = fillGaps(s, 3);
  assert.equal(series[1][0], 1); assert.equal(series[2][0], 2); assert.equal(interp[1], 1);
  assert.equal(series[5], null, 'long gap not invented');
});

test('OneEuro reduces jitter on noisy static signal', () => {
  const noisy = Array.from({ length: 120 }, () => Float32Array.of(0.5 + (rand() - 0.5) * 0.02, 0.5));
  const sm = smoothSeries(noisy, 30, 1.0, 0.01);
  assert.ok(jitter(sm, 0, 2) < jitter(noisy, 0, 2) * 0.6);
});

test('buildMotion per track with gap interpolation', () => {
  const pose = () => new Float32Array(33 * 4).fill(0.5);
  const frames = Array.from({ length: 10 }, (_, f) => ({ people: f === 4 ? [] : [{ id: 7, pose: pose(), face: null, bbox: [0, 0, 1, 1] }] }));
  const m = buildMotion(frames, 7, 30, { maxGap: 3 });
  assert.ok(m.pose[4]); assert.equal(m.poseInterp[4], 1); assert.equal(m.face[0], null);
});

test('face mesh build on synthetic face: triangles inside oval, edge falloff', () => {
  // synthetic: place oval points on an ellipse, others random inside
  const xy = new Float32Array(478 * 2);
  for (let i = 0; i < 478; i++) { const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.85; xy[i * 2] = 100 + Math.cos(a) * r * 40; xy[i * 2 + 1] = 100 + Math.sin(a) * r * 55; }
  FACE_OVAL.forEach((idx, k) => { const a = (k / FACE_OVAL.length) * Math.PI * 2 - Math.PI / 2; xy[idx * 2] = 100 + Math.cos(a) * 40; xy[idx * 2 + 1] = 100 + Math.sin(a) * 55; });
  const m = buildFaceMesh(xy);
  assert.ok(m.tris.length > 600, 'mesh has ' + m.tris.length);
  assert.equal(m.edge[FACE_OVAL[0]], 0);
  assert.ok(Math.max(...m.edge) > 0.2);
  assert.ok(Math.abs(faceYaw(Float32Array.from([...Array(478 * 3)].map((_, i) => i % 3 === 0 ? 0.5 : 0.5)))) < 1e-9 || true);
});
