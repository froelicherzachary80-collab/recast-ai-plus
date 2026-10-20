/** Main-thread facade over the inference worker with progress, cancellation and session bookkeeping. */
type Pending = { res: (v: any) => void; rej: (e: any) => void; onProgress?: (f: number, stage: string) => void };

class Engine {
  private w: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  loaded = new Map<string, { backend: string; kind: string; lastUsed: number }>();
  logs: string[] = [];
  listeners = new Set<() => void>();

  private worker(): Worker {
    if (this.w) return this.w;
    this.w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'log') { this.logs.push(m.msg); this.emit(); return; }
      const p = this.pending.get(m.id); if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m.f, m.stage);
      else if (m.type === 'done') { this.pending.delete(m.id); p.res(m.result); }
      else if (m.type === 'error') { this.pending.delete(m.id); const err: any = new Error(m.msg); err.cancelled = m.cancelled; p.rej(err); }
    };
    this.w.onerror = (e) => { console.error('Inference worker error', e.message, e.filename, e.lineno); for (const p of this.pending.values()) p.rej(new Error(`Worker crashed: ${e.message || 'possibly out of memory'}`)); this.pending.clear(); this.w = null; this.loaded.clear(); this.emit(); };
    this.call('init', { base: document.baseURI });
    return this.w;
  }
  emit() { for (const l of this.listeners) l(); }
  call<T = any>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<T> {
    const w = this.worker(), id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej, onProgress }); w.postMessage({ type, id, ...payload }, transfer); });
  }
  async load(key: string, bytes: ArrayBuffer, backend: 'webgpu' | 'wasm', maxLoaded: number) {
    while (this.loaded.size >= maxLoaded && !this.loaded.has(key)) {
      const lru = [...this.loaded.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
      await this.unload(lru);
    }
    const r = await this.call('load', { key, bytes, backend }, [bytes]);
    this.loaded.set(key, { backend: r.backend, kind: r.kind, lastUsed: Date.now() }); this.emit();
    return r;
  }
  touch(key: string) { const l = this.loaded.get(key); if (l) l.lastUsed = Date.now(); }
  async unload(key: string) { await this.call('unload', { key }); this.loaded.delete(key); this.emit(); }
  async unloadAll() { if (!this.w) return; await this.call('unloadAll'); this.loaded.clear(); this.emit(); }
  inspect(bytes: ArrayBuffer) { return this.call('inspect', { bytes }, [bytes]); }
  cancel() { this.w?.postMessage({ type: 'cancel' }); }
  /** Hard stop: terminates the worker (frees all GPU/WASM memory). */
  terminate() { this.w?.terminate(); this.w = null; for (const p of this.pending.values()) p.rej(Object.assign(new Error('Processing cancelled by user'), { cancelled: true })); this.pending.clear(); this.loaded.clear(); this.emit(); }
}
export const engine = new Engine();
