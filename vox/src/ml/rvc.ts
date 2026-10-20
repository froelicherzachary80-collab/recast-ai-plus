/**
 * RVC (Retrieval-based Voice Conversion) ONNX inference adapter.
 *
 * Pipeline per chunk: 16 kHz vocal -> ContentVec/HuBERT content features (50 fps) -> ×2 frame
 * repeat (100 fps) -> generator(phone, phone_lengths, pitch(coarse), pitchf, ds, rnd) -> waveform.
 * Matches the I/O signature of RVC's official ONNX export (infer/modules/onnx/export.py,
 * SynthesizerTrnMsNSFsidM). Chunks overlap and are cross-faded (overlap-add) to hide boundaries.
 * Faiss index retrieval is NOT implemented (no browser faiss); conversion runs index-free.
 */
import { type OrtLike, type SessionLike, type JobControl, checkCancel, inputShape, disposeAll } from './ortTypes';

export const RVC_SR_IN = 16000, RVC_HOP = 160, RVC_FPS = 100;

export interface RvcRunParams {
  targetF0: Float32Array; // Hz per 10 ms frame (0 = unvoiced), already transposed/edited
  noiseScale: number;     // "vocal stability": lower = steadier, higher = more variation (RVC default 0.66666)
  speakerId: number;
  chunkSec: number;
  overlapSec: number;
  contextSec: number;
  seed?: number;
}

export interface RvcChunkReport { index: number; startSec: number; endSec: number; ms: number; outRms: number; }
export interface RvcResult { audio: Float32Array; sampleRate: number; chunks: RvcChunkReport[]; featureDim: number; }

const F0_MIN = 50, F0_MAX = 1100;
const MEL_MIN = 1127 * Math.log(1 + F0_MIN / 700), MEL_MAX = 1127 * Math.log(1 + F0_MAX / 700);

/** RVC coarse pitch quantisation (1..255 mel bins; 1 = unvoiced). */
export function coarsePitch(f0: number): number {
  let m = 1127 * Math.log(1 + f0 / 700);
  if (m > 0) m = ((m - MEL_MIN) * 254) / (MEL_MAX - MEL_MIN) + 1;
  if (m <= 1) m = 1; if (m > 255) m = 255;
  return Math.round(m);
}

function gaussian(rng: () => number) { const u = Math.max(1e-12, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mulberry(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const pick = (names: readonly string[], ...cands: string[]) => cands.find((c) => names.includes(c));

export interface RvcSignature { phone: string; phoneLengths?: string; pitch?: string; pitchf?: string; sid?: string; rnd?: string; usesF0: boolean; featureDim: number | null; }

export function rvcSignature(gen: SessionLike): RvcSignature {
  const n = gen.inputNames;
  const phone = pick(n, 'phone', 'feats', 'hubert', 'c');
  if (!phone) throw new Error(`Not an RVC generator: inputs are [${n.join(', ')}] (expected phone/feats)`);
  const shp = inputShape(gen, phone);
  const fd = shp && typeof shp[2] === 'number' ? (shp[2] as number) : null;
  const sig: RvcSignature = { phone, phoneLengths: pick(n, 'phone_lengths', 'p_len', 'lengths'), pitch: pick(n, 'pitch'), pitchf: pick(n, 'pitchf', 'nsff0'),
    sid: pick(n, 'ds', 'sid', 'g'), rnd: pick(n, 'rnd', 'noise'), usesF0: false, featureDim: fd };
  sig.usesF0 = !!(sig.pitch && sig.pitchf);
  return sig;
}

export function isContentModel(s: SessionLike) { return s.inputNames.some((n) => ['source', 'audio', 'input_values', 'wav', 'waveform', 'x'].includes(n)) && s.inputNames.length <= 2; }

/** Runs the content encoder; returns [T, D] row-major features at 50 fps. */
export async function contentFeatures(ort: OrtLike, content: SessionLike, x16: Float32Array): Promise<{ feats: Float32Array; frames: number; dim: number }> {
  const name = content.inputNames[0];
  const pad = (320 - (x16.length % 320)) % 320, x = new Float32Array(x16.length + pad); x.set(x16);
  const shp = inputShape(content, name);
  const tryRun = async (dims: number[]) => {
    const t = new ort.Tensor('float32', x, dims), out = await content.run({ [name]: t });
    const o = out[content.outputNames[0]], res = { data: (o.data as Float32Array).slice(), dims: o.dims.slice() };
    disposeAll(out); t.dispose?.();
    return res;
  };
  let r;
  if (shp && shp.length === 3) r = await tryRun([1, 1, x.length]);
  else { try { r = await tryRun([1, x.length]); } catch { r = await tryRun([1, 1, x.length]); } }
  let [, a, b] = r.dims.length === 3 ? r.dims : [1, r.dims[0], r.dims[1]];
  // normalise to [T, D]
  if (a === 768 || a === 256) { const T = b, D = a, f = new Float32Array(T * D); for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) f[t * D + d] = r.data[d * T + t]; return { feats: f, frames: T, dim: D }; }
  return { feats: r.data, frames: a, dim: b };
}

export async function runRvc(ort: OrtLike, content: SessionLike, gen: SessionLike, x16: Float32Array, p: RvcRunParams, ctl?: JobControl): Promise<RvcResult> {
  const sig = rvcSignature(gen);
  const totalFrames = Math.floor(x16.length / RVC_HOP);
  const step = Math.max(50, Math.round(p.chunkSec * RVC_FPS)), ov = Math.min(Math.round(p.overlapSec * RVC_FPS), step >> 1), ctx = Math.round(p.contextSec * RVC_FPS);
  const rng = mulberry(p.seed ?? 1234);
  const chunks: RvcChunkReport[] = [];
  let outSr = 0, out: Float32Array | null = null, featureDim = 0;
  const nChunks = Math.max(1, Math.ceil(totalFrames / step));
  for (let k = 0; k < nChunks; k++) {
    checkCancel(ctl);
    const t0 = performance.now();
    const a = k * step, coreEnd = Math.min(totalFrames, a + step + ov); // core frames [a, coreEnd)
    if (a >= totalFrames) break;
    const fa = Math.max(0, a - ctx), fb = Math.min(totalFrames, coreEnd + ctx);
    const seg = x16.subarray(fa * RVC_HOP, fb * RVC_HOP);
    const cf = await contentFeatures(ort, content, seg);
    featureDim = cf.dim;
    if (sig.featureDim && sig.featureDim !== cf.dim) throw new Error(`Content model outputs ${cf.dim}-dim features but voice model expects ${sig.featureDim} (v1 models need 256-dim, v2 need 768-dim ContentVec)`);
    const T = Math.min(fb - fa, cf.frames * 2);
    const phone = new Float32Array(T * cf.dim);
    for (let t = 0; t < T; t++) phone.set(cf.feats.subarray((t >> 1) * cf.dim, ((t >> 1) + 1) * cf.dim), t * cf.dim);
    const feeds: Record<string, any> = { [sig.phone]: new ort.Tensor('float32', phone, [1, T, cf.dim]) };
    if (sig.phoneLengths) feeds[sig.phoneLengths] = new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]);
    if (sig.usesF0) {
      const pc = new BigInt64Array(T), pf = new Float32Array(T);
      for (let t = 0; t < T; t++) { const f = p.targetF0[fa + t] ?? 0; pf[t] = f; pc[t] = BigInt(coarsePitch(f)); }
      feeds[sig.pitch!] = new ort.Tensor('int64', pc, [1, T]);
      feeds[sig.pitchf!] = new ort.Tensor('float32', pf, [1, T]);
    }
    if (sig.sid) feeds[sig.sid] = new ort.Tensor('int64', BigInt64Array.from([BigInt(p.speakerId)]), [1]);
    if (sig.rnd) { const r = new Float32Array(192 * T); for (let i = 0; i < r.length; i++) r[i] = gaussian(rng) * p.noiseScale; feeds[sig.rnd] = new ort.Tensor('float32', r, [1, 192, T]); }
    const res = await gen.run(feeds);
    for (const t of Object.values(feeds)) t.dispose?.();
    const audio = (res[gen.outputNames[0]].data as Float32Array).slice();
    disposeAll(res);
    const spf = audio.length / T; // samples per frame
    if (!outSr) {
      const raw = spf * RVC_FPS, std = [32000, 40000, 48000, 44100, 16000, 22050, 24000];
      outSr = std.reduce((b, s) => (Math.abs(s - raw) < Math.abs(b - raw) ? s : b), std[0]);
      if (Math.abs(outSr - raw) / raw > 0.02) outSr = Math.round(raw);
      out = new Float32Array(Math.ceil((totalFrames * outSr) / RVC_FPS));
    }
    const so = outSr / RVC_FPS;
    const coreStart = Math.round((a - fa) * spf), coreLen = Math.round((coreEnd - a) * spf);
    const ovS = Math.round(ov * so), dst = Math.round(a * so);
    let sq = 0;
    for (let i = 0; i < coreLen; i++) {
      const v = audio[coreStart + i] ?? 0, j = dst + i;
      if (j >= out!.length) break;
      let w = 1;
      if (k > 0 && i < ovS) w = Math.sin((Math.PI / 2) * (i / ovS)) ** 2;
      if (k < nChunks - 1 && i >= coreLen - ovS && coreEnd < totalFrames) w *= Math.cos((Math.PI / 2) * ((i - (coreLen - ovS)) / ovS)) ** 2;
      out![j] += v * w; sq += v * v;
    }
    chunks.push({ index: k, startSec: a / RVC_FPS, endSec: coreEnd / RVC_FPS, ms: performance.now() - t0, outRms: Math.sqrt(sq / Math.max(1, coreLen)) });
    ctl?.onProgress?.((k + 1) / nChunks, `Neural conversion chunk ${k + 1}/${nChunks}`);
  }
  return { audio: out ?? new Float32Array(0), sampleRate: outSr || 40000, chunks, featureDim };
}
