import test from 'node:test';
import assert from 'node:assert/strict';
import { framesCovered, makePlan } from '../media.js';

const meta = (o = {}) => ({ width: 1920, height: 1080, fps: 30, duration: 10, ...o });

test('makePlan applies preset caps and reports every reduction', () => {
  const p = makePlan(meta({ fps: 59.94 }), { start: 1, end: 30 }, 'preview');
  assert.equal(p.width, 640); assert.equal(p.height, 360); assert.equal(p.fps, 15);
  assert.equal(p.end, 10); assert.equal(p.frames, 135);
  assert.ok(p.notes.some(n => n.includes('640×360')));
  assert.ok(p.notes.some(n => n.includes('15 fps')));
  const q = makePlan(meta({ width: 1280, height: 720 }), null, 'quality');
  assert.equal(q.width, 1080); assert.equal(q.frames, 300);
});

test('frame selection: 30 fps source → 15 fps plan emits every other source frame, timing preserved', () => {
  const plan = { start: 0, fps: 15, frames: 30 };
  let k = 0; const used = [];
  for (let i = 0; i < 60; i++) { const ts = i / 30, nk = framesCovered(ts, 1 / 30, 1 / 30, plan, k); for (; k < nk; k++) used.push(i); }
  assert.equal(used.length, 30);
  used.forEach((src, j) => assert.equal(src, j * 2));
});

test('frame selection: same fps maps 1:1 and handles trimmed start mid-frame', () => {
  const plan = { start: 0.51, fps: 30, frames: 10 };
  let k = 0; const used = [];
  for (let i = 15; i < 40; i++) { const nk = framesCovered(i / 30, 1 / 30, 1 / 30, plan, k); for (; k < nk; k++) used.push(i); }
  assert.equal(used.length, 10);
  assert.equal(used[0], 15); // 0.51 s lies inside frame 15 [0.5, 0.533)
  for (let j = 1; j < 10; j++) assert.equal(used[j] - used[j - 1], 1);
});

test('frame selection: variable frame rate with missing duration uses nominal', () => {
  const plan = { start: 0, fps: 10, frames: 5 };
  const ts = [0, 0.04, 0.13, 0.21, 0.33, 0.41, 0.5];
  let k = 0; const used = [];
  ts.forEach((t, i) => { const nk = framesCovered(t, 0, 0.1, plan, k); for (; k < nk; k++) used.push(i); });
  assert.equal(used.length, 5);
});

test('photo plan: single frame, full resolution up to 3072px, reduction reported', () => {
  const p = makePlan({ kind: 'photo', width: 4032, height: 3024, fps: 1, duration: 1 }, null, 'preview');
  assert.equal(p.frames, 1); assert.ok(p.photo);
  assert.equal(p.width, 3072); assert.equal(p.height, 2304);
  assert.ok(p.notes[0].includes('3072'));
  const q = makePlan({ kind: 'photo', width: 1200, height: 1800, fps: 1, duration: 1 }, null, 'photo');
  assert.equal(q.width, 1200); assert.equal(q.notes.length, 0);
});

test('video plan never uses the photo preset', () => {
  const p = makePlan({ width: 1920, height: 1080, fps: 30, duration: 5 }, null, 'photo');
  assert.equal(p.width, 640); assert.ok(!p.photo);
});
