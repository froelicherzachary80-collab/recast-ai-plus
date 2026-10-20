import { describe, it, expect } from 'vitest';
import { yinF0, hzToMidi } from '../src/audio/f0';
import { pitchShift, formantShift } from '../src/audio/psola';
import { compress, limit, biquad, applyBiquad, reverb, declick, deess, eq } from '../src/audio/dsp';
import { renderMix, makeTrack, defaultMaster } from '../src/audio/mixer';
import { processVocal, presetParams, HV_PRESETS } from '../src/audio/humanvoice';
import { segmentNotes, buildTargetCurve, diatonicInterval, scalePitchClasses } from '../src/audio/notes';
import { estimateLag, shift, transferEnvelope } from '../src/audio/postconvert';
import { encodeMp3 } from '../src/audio/mp3';
import { centerExtract } from '../src/audio/centerExtract';
import { peak, rms, nrmsDifference } from '../src/audio/pcm';
import { spectralCentroid } from '../src/audio/analysis';
import { sungTone, rand } from './helpers';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const medianF0 = (x: Float32Array, sr: number) => { const t = yinF0(x, sr); const v = Array.from(t.f0).filter((_, i) => t.voiced[i]).sort((a, b) => a - b); return v[v.length >> 1]; };

describe('PSOLA', () => {
  it('shifts pitch by +4 semitones within 15 cents and keeps duration', () => {
    const sr = 22050, x = sungTone(sr, 1.2, 200), tr = yinF0(x, sr);
    const y = pitchShift(x, sr, tr, 4);
    expect(y.length).toBe(x.length);
    const cents = (hzToMidi(medianF0(y, sr)) - hzToMidi(200)) * 100;
    expect(Math.abs(cents - 400)).toBeLessThan(15);
  });
  it('formant shift moves spectral centroid but keeps pitch', () => {
    const sr = 22050, x = sungTone(sr, 1.2, 180, 900), tr = yinF0(x, sr);
    const y = formantShift(x, sr, tr, 1.15);
    expect(Math.abs(hzToMidi(medianF0(y, sr)) - hzToMidi(180)) * 100).toBeLessThan(25);
    expect(spectralCentroid(y, sr)).toBeGreaterThan(spectralCentroid(x, sr) * 1.05);
  });
});

describe('effects', () => {
  const sr = 44100, loud = Float32Array.from({ length: sr }, (_, i) => Math.sin(i / 10) * 0.9);
  it('compressor reduces level above threshold', () => {
    const r = compress({ sampleRate: sr, channels: [loud] }, { on: true, threshold: -20, ratio: 4, attack: 0.001, release: 0.1, knee: 0, makeup: 0 });
    expect(r.maxGr).toBeGreaterThan(10); expect(rms(r.out.channels[0], sr / 2)).toBeLessThan(rms(loud) * 0.4);
  });
  it('limiter enforces ceiling', () => {
    const y = limit({ sampleRate: sr, channels: [loud.map((v) => v * 1.5)] }, -1);
    expect(peak(y)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
  });
  it('lowpass attenuates high frequency', () => {
    const hf = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 10000 * i) / sr));
    expect(rms(applyBiquad(hf, biquad('lowpass', 1000, sr)))).toBeLessThan(0.02);
  });
  it('reverb adds a tail after an impulse', () => {
    const x = new Float32Array(sr); x[100] = 1;
    const y = reverb({ sampleRate: sr, channels: [x, x] }, { mix: 0.5, size: 0.6, damp: 0.4, preDelayMs: 10 });
    expect(rms(y.channels[0], sr / 4, sr / 2)).toBeGreaterThan(1e-4);
  });
  it('declick repairs injected clicks', () => {
    const x = sungTone(sr, 0.5, 200); x[5000] += 0.9; x[12000] -= 0.9;
    const r = declick({ sampleRate: sr, channels: [x] });
    expect(r.repaired).toBeGreaterThanOrEqual(2);
    expect(Math.abs(r.out.channels[0][5000])).toBeLessThan(0.6);
  });
  it('de-esser reduces sibilant band energy', () => {
    const s = Float32Array.from({ length: sr }, () => (rand() - 0.5) * 0.8);
    const y = deess({ sampleRate: sr, channels: [s] }, 6000, -40, 12);
    const hp = (v: Float32Array) => rms(applyBiquad(v, biquad('highpass', 7000, sr)));
    expect(hp(y.channels[0])).toBeLessThan(hp(s) * 0.7);
  });
});

describe('HUMANVOICE + mixer', () => {
  it('every preset maps to real, distinct processing', () => {
    const sr = 44100, x = sungTone(sr, 1, 220), p = { sampleRate: sr, channels: [x] };
    const outs = Object.keys(HV_PRESETS).map((k) => processVocal(p, presetParams(k)).out.channels[0]);
    for (const o of outs) expect(nrmsDifference(x, o)).toBeGreaterThan(0.01);
    expect(nrmsDifference(outs[0], outs[3])).toBeGreaterThan(0.01);
  });
  it('mix sums tracks with offset, pan and master limiter', () => {
    const sr = 44100, a = new Float32Array(sr).fill(0.5), b = new Float32Array(sr).fill(0.5);
    const assets = new Map([['a', { sampleRate: sr, channels: [a] }], ['b', { sampleRate: sr, channels: [b] }]]);
    const ta = makeTrack('instrumental', 'A', 'a'), tb = makeTrack('converted', 'B', 'b');
    for (const t of [ta, tb]) { t.comp.on = false; t.reverbSend = 0; }
    tb.offset = 0.5; tb.pan = -1;
    const m = renderMix([ta, tb], assets, defaultMaster(), { start: 0, end: 1 }, sr, { skipMaster: true });
    expect(m.channels[0][1000]).toBeCloseTo(0.5, 3); expect(m.channels[1][sr * 0.75]).toBeCloseTo(0.5, 3);
    expect(m.channels[0][sr * 0.75]).toBeCloseTo(0.5 + 0.5 * Math.SQRT2, 3);
    tb.mute = true;
    const m2 = renderMix([ta, tb], assets, defaultMaster(), { start: 0, end: 1 }, sr);
    expect(peak(m2)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
  });
});

describe('notes & curves', () => {
  it('segments a two-note melody and applies note edits to the F0 curve', () => {
    const sr = 16000, x = sungTone(sr, 1.6, (t) => (t < 0.8 ? 220 : 277.2));
    const tr = yinF0(x, sr), notes = segmentNotes(tr);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(Math.round(notes[0].midi)).toBe(57); expect(Math.round(notes[notes.length - 1].midi)).toBe(61);
    notes[0].shift = 2;
    const c = buildTargetCurve(tr, { notes });
    const f = Math.round(0.4 * 100);
    expect(hzToMidi(c[f]) - hzToMidi(tr.f0[f])).toBeCloseTo(2, 1);
  });
  it('diatonic third above E in C major is a minor third (3 semitones)', () => {
    expect(diatonicInterval(64, 2, scalePitchClasses(0, 'major'))).toBe(3);
    expect(diatonicInterval(60, 2, scalePitchClasses(0, 'major'))).toBe(4);
  });
});

describe('post conversion', () => {
  it('estimates and corrects alignment lag', () => {
    const sr = 16000, x = sungTone(sr, 1, 200).map((v, i) => v * (Math.sin(i / 900) > 0 ? 1 : 0.1));
    const y = shift(x, -400);
    const lag = estimateLag(x, y, sr);
    expect(Math.abs(lag - 400)).toBeLessThanOrEqual(40);
    const fixed = shift(y, lag); let e = 0; for (let i = 1000; i < 15000; i++) e = Math.max(e, Math.abs(fixed[i] - x[i]));
    expect(e).toBeLessThan(0.05);
  });
  it('transfers envelope contour', () => {
    const sr = 16000, src = sungTone(sr, 1, 200).map((v, i) => v * (i < 8000 ? 1 : 0.1)), y = sungTone(sr, 1, 200);
    const o = transferEnvelope(src, y, sr, 1);
    expect(rms(o, 9000, 16000) / rms(o, 0, 7000)).toBeLessThan(0.2);
  });
});

describe('separation fallback (DSP)', () => {
  it('centre extraction isolates a centred source from a wide one', () => {
    const sr = 44100, v = sungTone(sr, 1, 300), n = v.length;
    const wl = Float32Array.from({ length: n }, () => (rand() - 0.5) * 0.3), wr = Float32Array.from({ length: n }, () => (rand() - 0.5) * 0.3);
    const L = v.map((s, i) => s + wl[i]), R = v.map((s, i) => s + wr[i]);
    const r = centerExtract({ sampleRate: sr, channels: [L, R] });
    expect(nrmsDifference(v, r.vocals.channels[0])).toBeLessThan(nrmsDifference(v, L));
  });
});

describe('MP3', () => {
  it('encodes a decodable MP3 (verified with ffmpeg)', async () => {
    const sr = 44100, x = sungTone(sr, 2, 330);
    const blob = await encodeMp3({ sampleRate: sr, channels: [x, x] }, 128);
    const buf = new Uint8Array(await blob.arrayBuffer());
    expect(buf.length).toBeGreaterThan(20000);
    mkdirSync('tests/.tmp', { recursive: true }); writeFileSync('tests/.tmp/t.mp3', buf);
    try {
      const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', 'tests/.tmp/t.mp3']).toString();
      const j = JSON.parse(info);
      expect(j.streams[0].codec_name).toBe('mp3'); expect(Math.abs(parseFloat(j.format.duration) - 2)).toBeLessThan(0.1);
    } catch (e: any) { if (e.code === 'ENOENT') console.warn('ffprobe not installed; skipped decode check'); else throw e; }
  });
});
