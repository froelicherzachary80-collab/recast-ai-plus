import { describe, it, expect } from 'vitest';
import * as ort from 'onnxruntime-node';
import { buildModel, FLOAT, INT64 } from './onnxBuilder';
import { runRvc, rvcSignature, coarsePitch, contentFeatures } from '../src/ml/rvc';
import { separateMdx, isMdxModel } from '../src/ml/mdx';
import { rand } from './helpers';

const sess = (b: Uint8Array) => ort.InferenceSession.create(b);

// Synthetic content encoder: source[1,N] -> reshape [1,N/320,320] -> matmul [320,768]
async function fakeContent() {
  const Wm = new Float32Array(320 * 768); for (let i = 0; i < Wm.length; i++) Wm[i] = (rand() - 0.5) * 0.01;
  return sess(buildModel([['source', FLOAT, [1, 'N']]], [['embed', FLOAT, [1, 'T', 768]]], [
    { op: 'Reshape', inputs: ['source', 'shp'], outputs: ['r'] }, { op: 'MatMul', inputs: ['r', 'W'], outputs: ['embed'] },
  ], [{ name: 'shp', dims: [3], int64: [1, -1, 320] }, { name: 'W', dims: [320, 768], float: Wm }]));
}
// Synthetic RVC generator with the official export signature. audio = tile(pitchf, 320) * 1e-3 (32 kHz)
async function fakeGenerator() {
  return sess(buildModel([
    ['phone', FLOAT, [1, 'T', 768]], ['phone_lengths', INT64, [1]], ['pitch', INT64, [1, 'T']], ['pitchf', FLOAT, [1, 'T']], ['ds', INT64, [1]], ['rnd', FLOAT, [1, 192, 'T']],
  ], [['audio', FLOAT, [1, 1, 'L']]], [
    { op: 'Unsqueeze', inputs: ['pitchf', 'ax'], outputs: ['u'] },
    { op: 'Tile', inputs: ['u', 'rep'], outputs: ['t'] },
    { op: 'Reshape', inputs: ['t', 'oshape'], outputs: ['r'] },
    { op: 'Mul', inputs: ['r', 'scale'], outputs: ['audio'] },
  ], [{ name: 'ax', dims: [1], int64: [2] }, { name: 'rep', dims: [3], int64: [1, 1, 320] }, { name: 'oshape', dims: [3], int64: [1, 1, -1] }, { name: 'scale', dims: [1], float: new Float32Array([1e-3]) }]));
}

describe('RVC adapter (synthetic graph, real onnxruntime)', () => {
  it('detects the RVC signature', async () => {
    const g = await fakeGenerator();
    const s = rvcSignature(g as any);
    expect(s.usesF0).toBe(true); expect(s.phone).toBe('phone'); expect(s.rnd).toBe('rnd');
  });
  it('coarse pitch matches RVC quantisation', () => {
    expect(coarsePitch(0)).toBe(1); expect(coarsePitch(50)).toBe(1); expect(coarsePitch(1100)).toBe(255);
    expect(coarsePitch(220)).toBeGreaterThan(40); expect(coarsePitch(220)).toBeLessThan(80);
  });
  it('content features come out at 50 fps', async () => {
    const c = await fakeContent();
    const r = await contentFeatures(ort as any, c as any, new Float32Array(16000));
    expect(r.frames).toBe(50); expect(r.dim).toBe(768);
  });
  it('chunked overlap-add conversion is seamless and follows target F0', async () => {
    const c = await fakeContent(), g = await fakeGenerator();
    const secs = 7.3, x = Float32Array.from({ length: Math.round(16000 * secs) }, () => rand() - 0.5);
    const frames = Math.floor(x.length / 160), f0 = new Float32Array(frames).fill(300);
    let progress = 0;
    const r = await runRvc(ort as any, c as any, g as any, x, { targetF0: f0, noiseScale: 0.66, speakerId: 0, chunkSec: 2, overlapSec: 0.2, contextSec: 0.3 }, { onProgress: (f) => (progress = f) });
    expect(r.sampleRate).toBe(32000);
    expect(r.chunks.length).toBe(4); expect(progress).toBe(1);
    expect(Math.abs(r.audio.length - frames * 320)).toBeLessThan(2);
    // constant target -> crossfaded output must be constant 0.3 everywhere (proves OLA weights sum to 1)
    let maxDev = 0; for (let i = 0; i < r.audio.length - 320; i++) maxDev = Math.max(maxDev, Math.abs(r.audio[i] - 0.3));
    expect(maxDev).toBeLessThan(1e-4);
  });
  it('honours cancellation', async () => {
    const c = await fakeContent(), g = await fakeGenerator();
    await expect(runRvc(ort as any, c as any, g as any, new Float32Array(16000 * 4), { targetF0: new Float32Array(400), noiseScale: 0.5, speakerId: 0, chunkSec: 1, overlapSec: 0.1, contextSec: 0.1 }, { cancelled: () => true })).rejects.toThrow(/cancel/i);
  });
});

describe('MDX adapter (synthetic graph, real onnxruntime)', () => {
  it('spectrogram packing + iSTFT reconstructs; stems sum to the mix', async () => {
    // model = 0.5 * spectrogram (all bins kept since dim_f = n_fft/2+1 is truncated by 1 bin: use full bins via dimF)
    const nFft = 1024, dimF = 513, dimT = 64;
    const s = await sess(buildModel([['input', FLOAT, [1, 4, dimF, dimT]]], [['output', FLOAT, [1, 4, dimF, dimT]]], [{ op: 'Mul', inputs: ['input', 'h'], outputs: ['output'] }], [{ name: 'h', dims: [1], float: new Float32Array([0.5]) }]));
    expect(isMdxModel(s as any)).toBe(true);
    const n = 44100 * 2, L = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 20) * 0.5), R = Float32Array.from({ length: n }, () => rand() - 0.5);
    const out = await separateMdx(ort as any, s as any, { sampleRate: 44100, channels: [L, R] }, { nFft, hop: 256, dimF, dimT, compensate: 1, primary: 'vocals' });
    let e = 0; for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(out.vocals.channels[0][i] - 0.5 * L[i]), Math.abs(out.vocals.channels[1][i] + out.instrumental.channels[1][i] - R[i]));
    expect(e).toBeLessThan(1e-3);
  });
});
