import test from 'node:test';
import assert from 'node:assert/strict';
import { cutScore, isCut, summarizeTracks, groupTracks, descDistance, shotLookup, faceGeometry } from '../people.js';

const sig = (v, noise = 0) => ({ g: new Float32Array(24 * 14).map((_, i) => Math.max(0, Math.min(255, v + ((i * 37) % 11 - 5) * noise))) });

test('cut detection: a hard cut is flagged, small motion is not', () => {
  const a = sig(60, 1), b = sig(62, 1), c = sig(200, 1);
  assert.ok(cutScore(a, b) < 0.2);
  assert.ok(isCut(cutScore(b, c), [0.02, 0.03]));
  assert.ok(!isCut(cutScore(a, b), [0.02, 0.03]));
  assert.ok(!isCut(0.4, [0.35, 0.38, 0.36]), 'fast pan with constant change is not a cut');
});

const desc = (rgb, geo = [0.45, 0.3, 0.38, 0.7]) => Float32Array.from([...Array(12).fill(0).flatMap(() => rgb), ...geo]);

test('descriptor distance: same look is close, different look is far', () => {
  const a = desc([0.8, 0.6, 0.5]), b = desc([0.79, 0.61, 0.5]), c = desc([0.2, 0.2, 0.6], [0.36, 0.38, 0.3, 0.8]);
  assert.ok(descDistance(a, b) < 0.05); assert.ok(descDistance(a, c) > 0.3);
});

test('grouping: same person across shots merges; people on screen together never merge', () => {
  // shot 1 (frames 0-9): A (track 1) and B (track 2) together. shot 2 (10-19): A again as track 3. shot 3: B as track 4.
  const A = desc([0.8, 0.6, 0.5]), B = desc([0.2, 0.25, 0.7], [0.38, 0.36, 0.32, 0.78]);
  const frames = Array.from({ length: 30 }, (_, f) => ({ people: f < 10 ? [{ id: 1, desc: A, bbox: [0, 0, 0.3, 0.9] }, { id: 2, desc: A.map((v, i) => i < 36 ? v * 0.99 : v), bbox: [0.5, 0, 0.8, 0.9] }] : f < 20 ? [{ id: 3, desc: A, bbox: [0.2, 0, 0.5, 0.9] }] : [{ id: 4, desc: B, bbox: [0.4, 0, 0.7, 0.9] }] }));
  const look = shotLookup([10, 20]); assert.equal(look(5), 0); assert.equal(look(15), 1); assert.equal(look(25), 2);
  const groups = groupTracks(summarizeTracks(frames, look));
  const g1 = groups.find(g => g.tracks.includes(1)), g2 = groups.find(g => g.tracks.includes(2));
  assert.notEqual(g1, g2, 'co-occurring look-alikes stay separate');
  assert.ok(g1.tracks.includes(3) || g2.tracks.includes(3), 'track 3 joins one of them');
  assert.ok(!g1.tracks.includes(4) && !g2.tracks.includes(4), 'different-looking person stays separate');
  assert.equal(new Set(groups.flatMap(g => g.tracks)).size, 4);
});

test('face geometry ratios are scale invariant', () => {
  const f = new Float32Array(478 * 3); for (let i = 0; i < 478; i++) { f[i * 3] = Math.sin(i) * 0.1 + 0.5; f[i * 3 + 1] = Math.cos(i * 1.3) * 0.1 + 0.5; }
  const g = f.map((v, i) => (i % 3 === 2 ? v : v * 2));
  const a = faceGeometry(f), b = faceGeometry(g); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5));
});
