import test from 'node:test';
import assert from 'node:assert/strict';
import { stft, istft, separateBasic, classifySegment, pitchTrack, splitVocals } from '../stems.js';

const sr = 16000;
const tone = (f, sec, amp = 0.4, f2 = null) => { const n = Math.round(sec * sr), x = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const fr = f2 ? f + (f2 - f) * i / n : f; ph += 2 * Math.PI * fr / sr; x[i] = amp * Math.sin(ph); } return x; };
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

test('STFT → ISTFT reconstructs the signal', () => {
  const x = tone(440, 0.5), y = istft(stft(x, 1024, 256));
  let e = 0; for (let i = 1000; i < x.length - 1000; i++) e = Math.max(e, Math.abs(x[i] - y[i]));
  assert.ok(e < 1e-3, String(e));
});

test('basic separation pulls a centred voice away from side-panned music', () => {
  const voice = tone(300, 1, 0.3), music = tone(1800, 1, 0.3);
  const L = voice.map((v, i) => v + music[i]), R = voice.map((v, i) => v - music[i]); // music out of phase = wide stereo
  const s = separateBasic(L, R, sr, { n: 1024, hop: 256 });
  const mid = a => a.subarray(2000, a.length - 2000);
  const vocInVoc = rms(mid(s.vocals.left)), musInMus = rms(mid(s.music.left));
  assert.ok(vocInVoc > 0.15, `vocals ${vocInVoc}`); assert.ok(musInMus > 0.15);
  // the vocal stem should be mostly the 300 Hz voice: compare with the voice itself
  let err = 0; const v = mid(s.vocals.left), ref = mid(voice); for (let i = 0; i < v.length; i++) err += (v[i] - ref[i]) ** 2;
  assert.ok(Math.sqrt(err / v.length) < 0.12, 'vocals ≈ voice');
});

test('pitch tracker finds a steady note', () => {
  const f0 = pitchTrack(tone(220, 0.5), sr).filter(v => v > 0);
  assert.ok(f0.length > 30); const med = f0.sort((a, b) => a - b)[f0.length >> 1]; assert.ok(Math.abs(med - 220) < 6, String(med));
});

test('singing (held notes) vs speech (gliding syllables)', () => {
  const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const gap = s => new Float32Array(Math.round(s * sr));
  const sung = cat(tone(262, 0.6), tone(294, 0.6), tone(330, 0.7));
  const spoken = cat(tone(180, 0.14, 0.4, 240), gap(0.06), tone(230, 0.12, 0.4, 150), gap(0.08), tone(160, 0.18, 0.4, 260), gap(0.05), tone(250, 0.1, 0.4, 170), gap(0.07), tone(200, 0.15, 0.4, 130));
  assert.equal(classifySegment(sung, sr).kind, 'singing');
  assert.equal(classifySegment(spoken, sr).kind, 'voice');
});

test('splitting vocals by segment labels', () => {
  const v = new Float32Array(sr).fill(0.5), r = splitVocals(v, sr, [{ start: 0, end: 0.4, kind: 'voice' }, { start: 0.5, end: 1, kind: 'singing' }]);
  assert.ok(r.voice[Math.round(0.2 * sr)] > 0.49 && r.sing[Math.round(0.2 * sr)] === 0);
  assert.ok(r.sing[Math.round(0.7 * sr)] > 0.49 && r.voice[Math.round(0.7 * sr)] === 0);
  assert.equal(r.voice[Math.round(0.45 * sr)], 0);
});

test('a song with a spoken line in the middle is split into singing / voice / singing', async () => {
  const { classifyVocals } = await import('../stems.js');
  const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const gap = s => new Float32Array(Math.round(s * sr));
  const sung = () => cat(tone(262, 0.7), tone(294, 0.7), tone(330, 0.8));
  const spoken = cat(...Array.from({ length: 8 }, (_, i) => cat(tone(150 + (i % 3) * 40, 0.13, 0.4, 230 - (i % 2) * 70), gap(0.05))));
  const segs = classifyVocals(cat(sung(), spoken, sung()), sr);
  const kindAt = t => segs.find(s => t >= s.start && t < s.end)?.kind;
  assert.equal(kindAt(1.0), 'singing'); assert.equal(kindAt(2.9), 'voice'); assert.equal(kindAt(4.6), 'singing');
});
