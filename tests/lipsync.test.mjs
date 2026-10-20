import test from 'node:test';
import assert from 'node:assert/strict';
import { mouthCurve, applyMouth, mouthActivity } from '../lipsync.js';

const sr = 16000, fps = 30;
const sine = (sec, f, amp) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
const noiseHi = (sec, amp) => { let s = 9; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5); const x = new Float32Array(Math.round(sec * sr)); let p = 0; for (let i = 0; i < x.length; i++) { const v = r(); x[i] = amp * (v - p); p = v; } return x; };
const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

test('mouth opens with loudness and closes in silence', () => {
  const x = cat(new Float32Array(sr * 0.5), sine(0.6, 220, 0.5), new Float32Array(sr * 0.6));
  const { open } = mouthCurve(x, sr, fps);
  assert.ok(open[5] < 0.05, 'closed before speech'); assert.ok(Math.max(...open.slice(18, 33)) > 0.6, 'open while speaking'); assert.ok(open[open.length - 1] < 0.1, 'closes after');
});

test('lip shape: bright hiss reads as spread, low vowel as rounded', () => {
  const lo = mouthCurve(sine(0.5, 300, 0.5), sr, fps).wide, hi = mouthCurve(noiseHi(0.5, 0.5), sr, fps).wide;
  assert.ok(hi[10] > 0.2 && lo[10] < 0, `${hi[10]} ${lo[10]}`);
});

// synthetic face: mouth corners, inner lips, chin, cheeks, a jaw point and an upper-face point
const face = () => { const L = new Float32Array(478 * 3).fill(0.5); const s = (i, x, y) => { L[i * 3] = x; L[i * 3 + 1] = y; };
  s(61, 0.44, 0.6); s(291, 0.56, 0.6); s(13, 0.5, 0.595); s(14, 0.5, 0.635); s(152, 0.5, 0.72); s(234, 0.36, 0.5); s(454, 0.64, 0.5); s(172, 0.38, 0.66); s(10, 0.5, 0.3); s(0, 0.5, 0.585); return L; };

test('applyMouth: closes the actor mouth, then opens it by the new amount', () => {
  const L = face(), closed = applyMouth(L, { open: 0 }), opened = applyMouth(L, { open: 1 });
  const gap = A => A[14 * 3 + 1] - A[13 * 3 + 1], mw = 0.12;
  assert.ok(Math.abs(gap(closed)) < 0.004, 'closed: ' + gap(closed));
  assert.ok(gap(opened) > 0.3 * mw, 'opened: ' + gap(opened));
  assert.equal(opened[10 * 3 + 1], L[10 * 3 + 1], 'forehead untouched');
  assert.ok(opened[152 * 3 + 1] > L[152 * 3 + 1], 'chin drops');
  assert.ok(opened[172 * 3 + 1] - L[172 * 3 + 1] < opened[152 * 3 + 1] - L[152 * 3 + 1], 'jaw corner moves less than chin');
  assert.ok(opened[0 * 3 + 1] <= L[0 * 3 + 1], 'upper lip does not drop');
  const sp = applyMouth(L, { open: 0.3, wide: 1 }), rd = applyMouth(L, { open: 0.3, wide: -1 });
  assert.ok(sp[291 * 3] - sp[61 * 3] > rd[291 * 3] - rd[61 * 3], 'spread is wider than rounded');
});

test('mouth activity picks the person whose mouth moves', () => {
  const mk = g => { const F = new Float32Array(478 * 3); F[61 * 3] = 0.4; F[291 * 3] = 0.6; F[13 * 3 + 1] = 0.5; F[14 * 3 + 1] = 0.5 + g; return F; };
  const frames = Array.from({ length: 20 }, (_, f) => ({ people: [{ id: 1, face: mk(f % 2 ? 0.05 : 0.0) }, { id: 2, face: mk(0.01) }] }));
  assert.ok(mouthActivity(frames, 1, 0, 19) > mouthActivity(frames, 2, 0, 19) * 5);
});
