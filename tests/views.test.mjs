import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateFace3D } from '../views.js';
import { faceYaw, STABLE } from '../facemesh.js';

// synthetic head: points on an ellipsoid facing the camera (z negative toward camera)
const lm = new Float32Array(478 * 3);
for (let i = 0; i < 478; i++) { const u = (i * 2.399) % (2 * Math.PI), v = ((i * 0.618) % 1) * 1.2 - 0.6; lm[i * 3] = 0.5 + 0.12 * Math.sin(u) * Math.cos(v); lm[i * 3 + 1] = 0.5 + 0.16 * Math.sin(v); lm[i * 3 + 2] = -0.1 * Math.abs(Math.cos(u)) * Math.cos(v); }
// make cheeks and nose tip well defined: cheeks at the sides, nose forward in the middle
const set = (i, x, y, z) => { lm[i * 3] = x; lm[i * 3 + 1] = y; lm[i * 3 + 2] = z; };
set(234, 0.38, 0.5, 0); set(454, 0.62, 0.5, 0); set(1, 0.5, 0.52, -0.12);

test('rotation by 0 is the identity', () => {
  const r = rotateFace3D(lm, 800, 600, 0);
  for (let i = 0; i < 478; i++) { assert.ok(Math.abs(r.xy[i * 2] - lm[i * 3] * 800) < 1e-3); assert.ok(Math.abs(r.lm3[i * 3 + 2] - lm[i * 3 + 2]) < 1e-6); }
});

test('rotation keeps 3D distances and turns the head', () => {
  const r = rotateFace3D(lm, 800, 800, 0.5);
  const d3 = (A, i, j, w) => Math.hypot((A[i * 3] - A[j * 3]) * w, (A[i * 3 + 1] - A[j * 3 + 1]) * w, (A[i * 3 + 2] - A[j * 3 + 2]) * w);
  assert.ok(Math.abs(d3(lm, 1, 234, 800) - d3(r.lm3, 1, 234, 800)) < 1e-2);
  const y0 = faceYaw(lm), y1 = faceYaw(r.lm3), y2 = faceYaw(rotateFace3D(lm, 800, 800, -0.5).lm3);
  assert.ok(Math.abs(y0) < 0.05); assert.ok(y1 * y2 < 0 && Math.abs(y1) > 0.2, `${y1} ${y2}`);
});

import { rotateHeadPoints } from '../views.js';
test('head turn: face moves fully, rings partially, background stays fixed', () => {
  const pts = [{ x: 140, y: 100, z: 0, move: 1 }, { x: 140, y: 100, z: 0, move: 0.5 }, { x: 0, y: 0, z: 50, move: 0 }];
  const q = rotateHeadPoints(pts, 100, 60, 0.4);
  const full = q[0].x - 140, half = q[1].x - 140;
  assert.ok(Math.abs(half - full / 2) < 1e-9 && Math.abs(full) > 1);
  assert.deepEqual([q[2].x, q[2].y, q[2].z], [0, 0, 50]);
  assert.deepEqual(rotateHeadPoints(pts, 100, 60, 0).map(p => p.x), [140, 140, 0]);
});
