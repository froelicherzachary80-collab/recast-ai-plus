/** Generates royalty-free synthetic fixtures (no third-party audio) and synthetic ONNX test graphs. */
import { encodeWav } from '../src/audio/wav';
import { buildModel, FLOAT, INT64 } from './onnxBuilder';
import { sungTone, rand } from './helpers';

/** 12 s synthetic "song": centred sung melody + wide stereo chord pad and hats. */
export function syntheticSong(sr = 44100, dur = 12) {
  const melody = [220, 246.9, 261.6, 293.7, 329.6, 293.7, 261.6, 246.9];
  const v = sungTone(sr, dur, (t) => melody[Math.floor(t / 1.5) % melody.length], 750, 0.006);
  for (let i = 0; i < v.length; i++) { const ph = (i / sr) % 1.5; v[i] *= ph < 1.3 ? Math.min(1, ph * 20) : 0; } // phrases with gaps
  const n = v.length, L = new Float32Array(n), R = new Float32Array(n);
  const chord = [130.8, 164.8, 196];
  for (let i = 0; i < n; i++) {
    const t = i / sr; let l = 0, r = 0;
    chord.forEach((f, k) => { l += Math.sin(2 * Math.PI * f * t + k) * 0.07; r += Math.sin(2 * Math.PI * f * 1.003 * t + k * 2.1) * 0.07; });
    const hat = (t * 4) % 1 < 0.02 ? (rand() - 0.5) * 0.3 : 0;
    L[i] = v[i] * 0.8 + l + hat; R[i] = v[i] * 0.8 + r - hat * 0.7;
  }
  return { mix: { sampleRate: sr, channels: [L, R] }, vocal: v };
}
export const wavBytes = (p: { sampleRate: number; channels: Float32Array[] }) => new Uint8Array(encodeWav(p, 16));

/** TEST-ONLY content encoder with the ContentVec I/O signature (random projection, not a real model). */
export function fakeContentOnnx() {
  const Wm = new Float32Array(320 * 768); for (let i = 0; i < Wm.length; i++) Wm[i] = (rand() - 0.5) * 0.01;
  return buildModel([['source', FLOAT, [1, 'N']]], [['embed', FLOAT, [1, 'T', 768]]], [
    { op: 'Reshape', inputs: ['source', 'shp'], outputs: ['r'] }, { op: 'MatMul', inputs: ['r', 'W'], outputs: ['embed'] },
  ], [{ name: 'shp', dims: [3], int64: [1, -1, 320] }, { name: 'W', dims: [320, 768], float: Wm }]);
}
/**
 * TEST-ONLY "voice" with the official RVC export signature: synthesises sin(2π∫f0) at 32 kHz from
 * pitchf. It is a sine oscillator — it proves the pipeline wiring/F0 path end-to-end, NOT voice quality.
 */
export function fakeRvcOnnx() {
  return buildModel([
    ['phone', FLOAT, [1, 'T', 768]], ['phone_lengths', INT64, [1]], ['pitch', INT64, [1, 'T']], ['pitchf', FLOAT, [1, 'T']], ['ds', INT64, [1]], ['rnd', FLOAT, [1, 192, 'T']],
  ], [['audio', FLOAT, [1, 1, 'L']]], [
    { op: 'Unsqueeze', inputs: ['pitchf', 'ax'], outputs: ['u'] },
    { op: 'Tile', inputs: ['u', 'rep'], outputs: ['t'] },
    { op: 'Reshape', inputs: ['t', 'oshape'], outputs: ['r'] },
    { op: 'Mul', inputs: ['r', 'w'], outputs: ['inc'] },
    { op: 'CumSum', inputs: ['inc', 'axis'], outputs: ['ph'] },
    { op: 'Sin', inputs: ['ph'], outputs: ['s'] },
    { op: 'Mul', inputs: ['s', 'amp'], outputs: ['audio'] },
  ], [{ name: 'ax', dims: [1], int64: [2] }, { name: 'rep', dims: [3], int64: [1, 1, 320] }, { name: 'oshape', dims: [3], int64: [1, 1, -1] },
    { name: 'w', dims: [1], float: new Float32Array([(2 * Math.PI) / 32000]) }, { name: 'axis', dims: [], int64: [2] }, { name: 'amp', dims: [1], float: new Float32Array([0.3]) }]);
}

/** TEST-ONLY graph with the UVR MDX-Net I/O signature ([1,4,3072,256] -> same): output = 0.5 × input spectrogram. */
export function fakeMdxOnnx() {
  return buildModel([['input', FLOAT, [1, 4, 3072, 256]]], [['output', FLOAT, [1, 4, 3072, 256]]], [{ op: 'Mul', inputs: ['input', 'h'], outputs: ['output'] }], [{ name: 'h', dims: [1], float: new Float32Array([0.5]) }]);
}
