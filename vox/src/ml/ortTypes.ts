/** Minimal structural types shared by onnxruntime-web (browser/worker) and onnxruntime-node (tests). */
export interface TensorLike { data: unknown; dims: readonly number[]; type: string; dispose?: () => void; }
export interface OrtLike { Tensor: new (type: any, data: any, dims: readonly number[]) => TensorLike; }
export interface ValueMeta { name: string; isTensor?: boolean; type?: string; shape?: readonly (number | string)[]; }
export interface SessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  inputMetadata?: readonly ValueMeta[] | Record<string, unknown>;
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
}

export class CancelledError extends Error { constructor() { super('Processing cancelled by user'); this.name = 'CancelledError'; } }
export interface JobControl { cancelled?: () => boolean; onProgress?: (fraction: number, stage: string) => void; }
export const checkCancel = (c?: JobControl) => { if (c?.cancelled?.()) throw new CancelledError(); };

export function inputShape(s: SessionLike, name: string): readonly (number | string)[] | null {
  const m = s.inputMetadata as any;
  if (!m) return null;
  if (Array.isArray(m)) { const e = m.find((v: ValueMeta) => v.name === name); return e?.shape ?? null; }
  return m[name]?.shape ?? m[name]?.dimensions ?? null;
}

export const disposeAll = (o: Record<string, TensorLike>) => { for (const t of Object.values(o)) t.dispose?.(); };
