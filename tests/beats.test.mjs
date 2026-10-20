import test from 'node:test';
import assert from 'node:assert/strict';
import { fft, analyzeBeats } from '../beats.js';

test('FFT finds a pure tone bin', () => {
  const n = 256, re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * 10 * i / n);
  fft(re, im); let b = 0, bv = 0; for (let k = 0; k < n / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > bv) { bv = m; b = k; } }
  assert.equal(b, 10);
});

const clickTrack = (bpm, sec, sr = 22050, offset = 0.3) => {
  const x = new Float32Array(sr * sec); let s = 3; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.01;
  for (let t = offset, k = 0; t < sec; t += 60 / bpm, k++) { const a = Math.round(t * sr), amp = k % 4 === 0 ? 0.9 : 0.5; for (let i = 0; i < 600 && a + i < x.length; i++) x[a + i] += amp * Math.exp(-i / 90) * rnd() * 2; }
  return x;
};

for (const bpm of [92, 120, 140]) test(`tempo and beats on a ${bpm} BPM click track`, () => {
  const r = analyzeBeats(clickTrack(bpm, 12), 22050);
  assert.ok(Math.abs(r.bpm - bpm) / bpm < 0.03, `bpm ${r.bpm}`);
  const P = 60 / bpm, aligned = r.beats.filter(b => { const ph = ((b - 0.3) / P) % 1; return Math.min(ph, 1 - ph) * P < 0.04; });
  assert.ok(aligned.length / r.beats.length > 0.85, `${aligned.length}/${r.beats.length} aligned`);
  assert.ok(r.strong.length > 0 && r.strong.length < r.beats.length);
});
