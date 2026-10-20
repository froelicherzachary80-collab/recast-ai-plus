/// <reference lib="webworker" />
/** Inference worker: runs ONNX Runtime Web off the UI thread. Audio never leaves the device. */
import * as ort from 'onnxruntime-web';
import { runRvc, rvcSignature, isContentModel } from './rvc';
import { separateMdx, isMdxModel, mdxConfigFromModel, type MdxConfig } from './mdx';
import { CancelledError, type SessionLike } from './ortTypes';

type Backend = 'webgpu' | 'wasm';
const sessions = new Map<string, { s: ort.InferenceSession; backend: Backend }>();
let cancelFlag = false;
const post = (m: any, t?: Transferable[]) => (self as DedicatedWorkerGlobalScope).postMessage(m, t ?? []);

function configure(_base: string) {
  // ORT's wasm binary is emitted by Vite as a same-origin hashed asset (no CDN).
  ort.env.wasm.numThreads = (self as any).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.proxy = false;
}

async function create(bytes: ArrayBuffer, backend: Backend): Promise<{ s: ort.InferenceSession; backend: Backend }> {
  const u8 = new Uint8Array(bytes);
  if (backend === 'webgpu') {
    try { return { s: await ort.InferenceSession.create(u8, { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' }), backend: 'webgpu' }; }
    catch (e) { post({ type: 'log', level: 'warn', msg: `WebGPU session failed (${(e as Error).message}); falling back to WASM` }); }
  }
  return { s: await ort.InferenceSession.create(u8, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), backend: 'wasm' };
}

const describe = (s: SessionLike) => {
  let kind = 'unknown', details: Record<string, unknown> = {};
  try { const sig = rvcSignature(s); kind = 'rvc'; details = { usesF0: sig.usesF0, featureDim: sig.featureDim }; } catch { /* */ }
  if (kind === 'unknown' && isContentModel(s)) kind = 'content';
  if (kind === 'unknown' && isMdxModel(s)) kind = 'mdx';
  return { kind, inputs: [...s.inputNames], outputs: [...s.outputNames], details, meta: (s as any).inputMetadata ?? null };
};

// ORT's bundled Emscripten glue may re-spawn this same script as a pthread worker ("em-pthread");
// in that context the Emscripten runtime owns the message channel, so we must not install our handler.
const isPthread = typeof self.name === 'string' && self.name.startsWith('em-pthread');
ort.env.wasm.numThreads = (self as any).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

if (!isPthread) self.addEventListener('message', async (e: MessageEvent) => {
  const m = e.data, id = m?.id;
  if (!m || typeof m.type !== 'string' || typeof id !== 'number') return;
  const progress = (f: number, stage: string) => post({ type: 'progress', id, f, stage });
  try {
    switch (m.type) {
      case 'init': configure(m.base); post({ type: 'done', id, result: { numThreads: ort.env.wasm.numThreads } }); break;
      case 'load': {
        if (sessions.has(m.key)) { post({ type: 'done', id, result: { backend: sessions.get(m.key)!.backend, ...describe(sessions.get(m.key)!.s as any) } }); break; }
        const t0 = performance.now(), r = await create(m.bytes, m.backend);
        sessions.set(m.key, r);
        post({ type: 'done', id, result: { backend: r.backend, ms: performance.now() - t0, ...describe(r.s as any) } });
        break;
      }
      case 'inspect': {
        const r = await create(m.bytes, 'wasm');
        const d = describe(r.s as any); await r.s.release();
        post({ type: 'done', id, result: d });
        break;
      }
      case 'unload': { const r = sessions.get(m.key); if (r) { await r.s.release(); sessions.delete(m.key); } post({ type: 'done', id, result: true }); break; }
      case 'unloadAll': { for (const r of sessions.values()) await r.s.release(); sessions.clear(); post({ type: 'done', id, result: true }); break; }
      case 'cancel': cancelFlag = true; break;
      case 'rvc': {
        cancelFlag = false;
        const c = sessions.get(m.contentKey), g = sessions.get(m.genKey);
        if (!c || !g) throw new Error('Content or voice model not loaded');
        const r = await runRvc(ort as any, c.s as any, g.s as any, m.x16, m.params, { cancelled: () => cancelFlag, onProgress: progress });
        post({ type: 'done', id, result: { audio: r.audio, sampleRate: r.sampleRate, chunks: r.chunks, featureDim: r.featureDim, backend: g.backend } }, [r.audio.buffer]);
        break;
      }
      case 'mdx': {
        cancelFlag = false;
        const s = sessions.get(m.key); if (!s) throw new Error('Separation model not loaded');
        const cfg: MdxConfig = mdxConfigFromModel(s.s as any, m.cfg);
        const r = await separateMdx(ort as any, s.s as any, { sampleRate: 44100, channels: m.channels }, cfg, { cancelled: () => cancelFlag, onProgress: progress });
        const bufs = [...r.vocals.channels, ...r.instrumental.channels];
        post({ type: 'done', id, result: { vocals: r.vocals.channels, instrumental: r.instrumental.channels, chunks: r.chunks, backend: s.backend, cfg } }, bufs.map((b) => b.buffer));
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', id, cancelled: err instanceof CancelledError, msg: (err as Error).message || String(err) });
  }
});
