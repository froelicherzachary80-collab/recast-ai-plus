import { describe, it, expect } from 'vitest';
import { encodeWav, decodeWav } from '../src/audio/wav';
import { resample } from '../src/audio/resample';
import { fft, stft, istft } from '../src/audio/fft';
import { yinF0, hzToMidi, pitchRange } from '../src/audio/f0';
import { estimateBpm, estimateKey, loudness, truePeak } from '../src/audio/analysis';
import { waveformPeaks, peak, rms } from '../src/audio/pcm';
import { sungTone, clickTrack, mono, rand } from './helpers';

describe('WAV', () => {
  it('round-trips 16/24/32-bit within quantisation error', () => {
    const x = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.8);
    for (const bits of [16, 24, 32] as const) {
      const p = decodeWav(encodeWav({ sampleRate: 44100, channels: [x, x.map((v) => -v)] }, bits));
      expect(p.sampleRate).toBe(44100); expect(p.channels.length).toBe(2);
      let e = 0; for (let i = 0; i < 1000; i++) e = Math.max(e, Math.abs(p.channels[0][i] - x[i]), Math.abs(p.channels[1][i] + x[i]));
      expect(e).toBeLessThan(bits === 16 ? 1e-4 : 1e-6);
    }
  });
});

describe('resample', () => {
  it('preserves a tone frequency and amplitude 44.1k -> 16k', () => {
    const sr = 44100, x = Float32Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5);
    const y = resample(x, sr, 16000);
    expect(y.length).toBe(16000);
    expect(rms(y, 1000, 15000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    const tr = yinF0(y, 16000);
    const v = Array.from(tr.f0).filter((f, i) => tr.voiced[i]);
    expect(Math.abs(v[v.length >> 1] - 440)).toBeLessThan(2);
  });
});

describe('FFT/STFT', () => {
  it('Bluestein FFT matches DFT for n=6144-like sizes', () => {
    const n = 96, re = Float64Array.from({ length: n }, () => rand() - 0.5), im = new Float64Array(n);
    const r0 = re.slice();
    fft(re, im);
    for (const k of [0, 5, 47]) { let a = 0, b = 0; for (let t = 0; t < n; t++) { a += r0[t] * Math.cos((2 * Math.PI * k * t) / n); b -= r0[t] * Math.sin((2 * Math.PI * k * t) / n); } expect(re[k]).toBeCloseTo(a, 8); expect(im[k]).toBeCloseTo(b, 8); }
    fft(re, im, true);
    for (let t = 0; t < n; t++) expect(re[t]).toBeCloseTo(r0[t], 9);
  });
  it('STFT -> ISTFT is perfect reconstruction (non power of two)', () => {
    const x = Float32Array.from({ length: 4000 }, () => rand() - 0.5);
    const s = stft(x, 384, 96), y = istft(s.re, s.im, s.frames, 384, 96, x.length);
    let e = 0; for (let i = 0; i < x.length; i++) e = Math.max(e, Math.abs(x[i] - y[i]));
    expect(e).toBeLessThan(1e-4);
  });
});

describe('F0', () => {
  it('tracks a sung tone within 10 cents and reports range', () => {
    const sr = 16000, x = sungTone(sr, 1.5, 220);
    const tr = yinF0(x, sr);
    expect(tr.hop).toBe(160);
    const v = Array.from(tr.f0).filter((_, i) => tr.voiced[i]);
    expect(v.length).toBeGreaterThan(tr.f0.length * 0.8);
    const err = v.map((f) => Math.abs(hzToMidi(f) - hzToMidi(220)) * 100).sort((a, b) => a - b);
    expect(err[err.length >> 1]).toBeLessThan(10);
    expect(pitchRange(tr)!.median).toBeCloseTo(hzToMidi(220), 0);
  });
  it('marks silence unvoiced', () => {
    const x = new Float32Array(16000); x.set(sungTone(16000, 0.5, 300), 0);
    const tr = yinF0(x, 16000);
    expect(tr.voiced.slice(70).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('analysis', () => {
  it('estimates BPM of a click track', () => {
    const { bpm } = estimateBpm(mono(44100, clickTrack(44100, 12, 100)));
    const ok = [100, 50, 200].some((b) => Math.abs(bpm - b) < 2);
    expect(ok).toBe(true);
  });
  it('estimates key of a C major triad progression', () => {
    const sr = 22050, seg = (fs: number[]) => fs.map((f) => sungTone(sr, 1, f)).reduce((a, b) => a.map((v, i) => v + b[i]));
    const parts = [[261.6, 329.6, 392], [349.2, 440, 523.3], [392, 493.9, 587.3], [261.6, 329.6, 392]].map(seg);
    const x = new Float32Array(parts.length * sr); parts.forEach((p, i) => x.set(p, i * sr));
    const k = estimateKey(mono(sr, x));
    expect(['C major', 'A minor']).toContain(k.name);
  });
  it('measures LUFS of a -20 dBFS 1 kHz sine near -20 LUFS (mono weighting)', () => {
    const sr = 48000, a = Math.pow(10, -20 / 20) * Math.SQRT2;
    const x = Float32Array.from({ length: sr * 5 }, (_, i) => a * Math.sin((2 * Math.PI * 1000 * i) / sr));
    const l = loudness({ sampleRate: sr, channels: [x] });
    expect(l.integrated).toBeGreaterThan(-20.5); expect(l.integrated).toBeLessThan(-19.5);
  });
  it('true peak >= sample peak and catches inter-sample overs', () => {
    const sr = 44100, x = Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * (sr / 4) * i) / sr + Math.PI / 4));
    const p = { sampleRate: sr, channels: [x] };
    expect(peak(p)).toBeLessThan(0.75);
    expect(truePeak(p)).toBeGreaterThan(0.95);
  });
  it('waveform peaks reflect actual min/max', () => {
    const x = new Float32Array(1000); x[250] = 0.9; x[750] = -0.6;
    const w = waveformPeaks(x, 4);
    expect(w[3]).toBeCloseTo(0.9); expect(w[6]).toBeCloseTo(-0.6); expect(w[1]).toBe(0);
  });
});
