import type { Pcm } from '../audio/pcm';
let w: Worker | null = null, seq = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
function worker() {
  if (w) return w;
  w = new Worker(new URL('./dspWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.msg)); };
  w.onerror = (e) => { for (const p of pending.values()) p.rej(new Error(`DSP worker failed: ${e.message || 'out of memory?'}`)); pending.clear(); w = null; };
  return w;
}
/** Runs a DSP op in the worker. Input PCM buffers are COPIED (structured clone) so the caller's assets stay intact. */
export function dsp<T = Pcm>(op: string, args: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); worker().postMessage({ id, op, args }); });
}
export function cancelDsp() { w?.terminate(); w = null; for (const p of pending.values()) p.rej(Object.assign(new Error('Processing cancelled by user'), { cancelled: true })); pending.clear(); }
