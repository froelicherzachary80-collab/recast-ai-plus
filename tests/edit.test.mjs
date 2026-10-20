import test from 'node:test';
import assert from 'node:assert/strict';
import { cutGrid, buildAutoEdit, frameAt, beatPulse, resizeSegment, editLength } from '../edit.js';
import { CutDetector } from '../people.js';

const beats = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.65);

test('cut grid lands on beats, half-beats when asked, and spans the full length', () => {
  const g = cutGrid(beats, 0, 10, 1);
  assert.equal(g[0], 0); assert.equal(g[g.length - 1], 10);
  for (const t of g.slice(1, -1)) assert.ok(beats.some(b => Math.abs(b - t) < 1e-9));
  const half = cutGrid(beats, 0, 10, 0.5); assert.ok(half.length > g.length * 1.8);
  const shifted = cutGrid(beats, 2.0, 10, 2); for (const t of shifted.slice(1, -1)) assert.ok(beats.some(b => Math.abs(b - 2 - t) < 1e-9));
});

test('auto edit: contiguous, round-robin clips, source advances, transitions on accents', () => {
  const clips = [{ id: 'a', dur: 6 }, { id: 'b', dur: 4 }, { id: 'c', dur: Infinity, kind: 'image' }];
  const segs = buildAutoEdit({ clips, beats, strong: [beats[4], beats[8]], length: 12, every: 1 });
  assert.equal(segs[0].t0, 0); assert.ok(Math.abs(editLength(segs) - 12) < 1e-9);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].t0, segs[i - 1].t1);
  assert.deepEqual(segs.slice(0, 4).map(s => s.clipId), ['a', 'b', 'c', 'a']);
  const aSegs = segs.filter(s => s.clipId === 'a'); assert.ok(aSegs[1].src > aSegs[0].src, 'clip a continues where it left off');
  for (const s of segs) if (s.clipId === 'b') assert.ok(s.src + (s.t1 - s.t0) <= 4 + 1e-9, 'never runs past the clip end');
  assert.equal(segs[0].trans.type, 'dip');
  assert.ok(segs.some(s => s.trans.type === 'flash' || s.trans.type === 'zoom'));
});

test('frameAt finds the segment, local time, source time and transition progress', () => {
  const segs = buildAutoEdit({ clips: [{ id: 'a', dur: 30 }], beats, length: 6, every: 2, style: 'flash', speed: 1.5 });
  const s = segs[1], f = frameAt(segs, s.t0 + 0.06);
  assert.equal(f.seg, s); assert.ok(Math.abs(f.src - (s.src + 0.09)) < 1e-9); assert.ok(f.trans > 0.4 && f.trans < 0.6);
  assert.equal(frameAt(segs, s.t0 + 0.5).trans, null);
});

test('beat pulse peaks on the beat and decays', () => {
  assert.ok(beatPulse(beats, 0, 0.5) > 0.99); assert.ok(beatPulse(beats, 0, 0.8) < 0.1); assert.equal(beatPulse(beats, 0, 0.1), 0);
});

test('resizing a segment shifts the rest', () => {
  const segs = buildAutoEdit({ clips: [{ id: 'a', dur: 30 }], beats, length: 6 }), L = editLength(segs);
  resizeSegment(segs, 1, segs[1].t1 - segs[1].t0 + 0.4);
  assert.ok(Math.abs(editLength(segs) - L - 0.4) < 1e-9); for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].t0 - segs[i - 1].t1) < 1e-9);
});

test('cut detector counts a multi-frame flash transition once', () => {
  const sig = v => ({ g: new Float32Array(336).fill(v) });
  const cd = new CutDetector(30); const seq = [...Array(20).fill(80), 255, 0, 180, ...Array(20).fill(180), ...Array(20).fill(20)];
  seq.forEach((v, f) => cd.push(sig(v), f));
  assert.equal(cd.cuts.length, 2, JSON.stringify(cd.cuts));
});
