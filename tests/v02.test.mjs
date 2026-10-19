import test from 'node:test';
import assert from 'node:assert/strict';
import { detectVoice, wsola, fitTake, trimSilence, encodeWav, rms, toMono, roomImpulse } from '../dub.js';
import { buildRig, deformRig, boneAffine, BONES } from '../puppet.js';
import { pushPullFill } from '../plate.js';

const sr = 16000;
const tone = (sec, f = 220, amp = 0.5) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
const silence = sec => new Float32Array(Math.round(sec * sr)).map(() => (Math.random() - 0.5) * 0.002);
const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const zc = a => { let n = 0; for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++; return n / 2 / (a.length / sr); };

test('voice activity finds two lines and ignores silence', () => {
  const sig = cat(silence(0.5), tone(1.0), silence(1.0), tone(0.6, 300), silence(0.5));
  const v = detectVoice(sig, sr);
  assert.equal(v.length, 2);
  assert.ok(Math.abs(v[0].start - 0.4) < 0.08 && Math.abs(v[0].end - 1.6) < 0.08, JSON.stringify(v));
  assert.ok(Math.abs(v[1].start - 2.4) < 0.08);
});

test('WSOLA changes duration but keeps pitch', () => {
  const x = tone(1.0, 220);
  for (const s of [0.75, 1.3]) {
    const y = wsola(x, sr, s);
    assert.ok(Math.abs(y.length - x.length * s) < 2);
    const f = zc(y.subarray(800, y.length - 800));
    assert.ok(Math.abs(f - 220) < 8, `freq ${f} at stretch ${s}`);
  }
});

test('fitTake trims silence, fits the line length and matches level', () => {
  const take = cat(silence(0.4), tone(1.1, 200, 0.2), silence(0.6));
  const r = fitTake(take, sr, 1.0, 0.35);
  assert.ok(Math.abs(r.samples.length / sr - 1.0) < 0.03, String(r.samples.length / sr));
  assert.ok(Math.abs(rms(r.samples) - 0.35) < 0.05);
  assert.equal(r.warn, null);
  const tooShort = fitTake(cat(silence(0.2), tone(0.4), silence(0.2)), sr, 1.5, 0.3);
  assert.ok(tooShort.warn && tooShort.stretch === 1.4);
});

test('trimSilence returns speech bounds', () => {
  const [a, b] = trimSilence(cat(silence(0.5), tone(0.5), silence(0.5)), sr);
  assert.ok(Math.abs(a / sr - 0.44) < 0.08 && Math.abs(b / sr - 1.06) < 0.08);
});

test('WAV encoder writes a valid header and size', async () => {
  const w = encodeWav([new Float32Array(100), new Float32Array(100)], 48000);
  assert.equal(w.size, 44 + 400);
  const b = new Uint8Array(await w.arrayBuffer()); assert.equal(String.fromCharCode(...b.slice(0, 4)), 'RIFF');
  assert.equal(toMono([Float32Array.of(1, 0), Float32Array.of(0, 1)])[0], 0.5);
  assert.equal(roomImpulse(1000, 0.5)[0].length, 500);
});

test('push-pull fill: holes take neighbour colors, known pixels unchanged', () => {
  const w = 16, h = 16, rgb = new Float32Array(w * h * 3), known = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; const hole = x > 5 && x < 10 && y > 5 && y < 10; if (!hole) { known[i] = 1; rgb[i * 3] = x < 8 ? 200 : 40; rgb[i * 3 + 1] = 100; } }
  const f = pushPullFill(rgb, known, w, h);
  assert.equal(f[(0 * w + 0) * 3], 200);
  const mid = f[(7 * w + 7) * 3]; assert.ok(mid > 40 && mid < 200 && f[(7 * w + 7) * 3 + 1] > 90, `${mid}`);
  assert.ok(f[(7 * w + 6) * 3] > f[(7 * w + 9) * 3], 'left side of hole closer to left color');
});

// rig: a simple standing figure in a 200x400 cutout
const joints = { nose: [100, 30], neck: [100, 70], pelvis: [100, 200], lSh: [130, 70], rSh: [70, 70], lEl: [150, 130], rEl: [50, 130], lWr: [160, 190], rWr: [40, 190], lHip: [120, 200], rHip: [80, 200], lKn: [125, 300], rKn: [75, 300], lAn: [125, 390], rAn: [75, 390] };
const alpha = new Uint8Array(200 * 400);
for (let y = 0; y < 400; y++) for (let x = 0; x < 200; x++) { const torso = x > 60 && x < 140 && y > 20 && y < 210, legs = y >= 210 && ((x > 65 && x < 95) || (x > 105 && x < 135)), arms = y > 70 && y < 200 && ((x > 30 && x < 62) || (x > 138 && x < 170)); if (torso || legs || arms) alpha[y * 200 + x] = 255; }

test('rig: identity pose reproduces rest mesh', () => {
  const rig = buildRig(alpha, 200, 400, joints);
  assert.ok(rig.n > 200 && rig.idx.length % 3 === 0 && rig.n < 65535);
  const out = deformRig(rig, joints);
  let maxd = 0; for (let i = 0; i < out.length; i++) maxd = Math.max(maxd, Math.abs(out[i] - rig.rest[i]));
  assert.ok(maxd < 1e-3, String(maxd));
});

test('rig: raising the left forearm moves hand vertices, not the right leg', () => {
  const rig = buildRig(alpha, 200, 400, joints);
  const t = { ...joints, lWr: [210, 130] }; // forearm rotated to horizontal
  const out = deformRig(rig, t);
  const near = (x, y) => { let bi = 0, bd = Infinity; for (let v = 0; v < rig.n; v++) { const d = Math.hypot(rig.rest[v * 2] - x, rig.rest[v * 2 + 1] - y); if (d < bd) { bd = d; bi = v; } } return bi; };
  const hand = near(160, 185), knee = near(80, 300);
  assert.ok(out[hand * 2] > 190, `hand x ${out[hand * 2]}`);
  assert.ok(Math.abs(out[knee * 2] - rig.rest[knee * 2]) < 1 && Math.abs(out[knee * 2 + 1] - rig.rest[knee * 2 + 1]) < 1);
});

test('rig: whole-body translate + scale follows the actor', () => {
  const rig = buildRig(alpha, 200, 400, joints);
  const t = Object.fromEntries(Object.entries(joints).map(([k, [x, y]]) => [k, [x * 0.5 + 300, y * 0.5 + 50]]));
  const out = deformRig(rig, t);
  for (let v = 0; v < rig.n; v += 37) { assert.ok(Math.abs(out[v * 2] - (rig.rest[v * 2] * 0.5 + 300)) < 1.5); assert.ok(Math.abs(out[v * 2 + 1] - (rig.rest[v * 2 + 1] * 0.5 + 50)) < 1.5); }
});

test('boneAffine maps bone endpoints', () => {
  const m = boneAffine([0, 0], [10, 0], [5, 5], [5, 25], 1);
  const ap = p => [m[0] * p[0] + m[1] * p[1] + m[4], m[2] * p[0] + m[3] * p[1] + m[5]];
  assert.deepEqual(ap([0, 0]).map(v => +v.toFixed(6)), [5, 5]); assert.deepEqual(ap([10, 0]).map(v => +v.toFixed(6)), [5, 25]);
  assert.equal(BONES.length, 10);
});
