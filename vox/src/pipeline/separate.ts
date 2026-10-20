import { centerExtract } from '../audio/centerExtract';
import { resample } from '../audio/resample';
import { toStereo, type Pcm } from '../audio/pcm';
import { engine } from '../ml/engine';
import { readModelBytes, type ModelRecord } from '../ml/modelStore';
import type { MdxConfig } from '../ml/mdx';

export interface SeparationResult { vocals: Pcm; instrumental: Pcm; method: string; neural: boolean; ms: number; backend: string; }

const to441 = (p: Pcm): Pcm => toStereo(p.sampleRate === 44100 ? p : { sampleRate: 44100, channels: p.channels.map((c) => resample(c, p.sampleRate, 44100)) });

export async function separateNeural(mix: Pcm, model: ModelRecord, cfg: MdxConfig, backend: 'webgpu' | 'wasm', maxLoaded: number, onProgress?: (f: number, s: string) => void): Promise<SeparationResult> {
  const t0 = performance.now(), m = to441(mix);
  onProgress?.(0.02, 'Loading separation model');
  await engine.load(model.id, await readModelBytes(model), backend, maxLoaded);
  const channels = m.channels.map((c) => c.slice());
  const r = await engine.call('mdx', { key: model.id, cfg, channels }, channels.map((c) => c.buffer), (f, s) => onProgress?.(0.05 + f * 0.95, s));
  return { vocals: { sampleRate: 44100, channels: r.vocals }, instrumental: { sampleRate: 44100, channels: r.instrumental }, method: `MDX-Net ONNX (${model.name})`, neural: true, ms: performance.now() - t0, backend: r.backend };
}

export function separateDsp(mix: Pcm): SeparationResult {
  const t0 = performance.now(), r = centerExtract(to441(mix));
  return { ...r, method: 'DSP centre-channel extraction (NOT AI)', neural: false, ms: performance.now() - t0, backend: 'cpu-dsp' };
}
