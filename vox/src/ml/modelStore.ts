/** Model files: stored in OPFS when available (large binary assets), IndexedDB fallback. SHA-256 verified. */
import { all, del, get, put } from '../store/db';

export type ModelKind = 'rvc' | 'content' | 'mdx' | 'unknown';
export interface ModelRecord {
  id: string; name: string; kind: ModelKind; size: number; sha256: string;
  storage: 'opfs' | 'idb'; addedAt: number; source: string; license: string;
  inputs: string[]; outputs: string[]; notes: string; verifiedAt?: number; permissionConfirmed: boolean;
  /** RVC: whether generator uses F0 (pitch) inputs; MDX: preset key */
  details?: Record<string, unknown>;
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try { const root = await navigator.storage.getDirectory(); return await root.getDirectoryHandle('models', { create: true }); } catch { return null; }
}

export async function writeModelBytes(id: string, buf: ArrayBuffer): Promise<'opfs' | 'idb'> {
  const dir = await opfsDir();
  if (dir) {
    try {
      const fh = await dir.getFileHandle(`${id}.onnx`, { create: true });
      const w = await (fh as any).createWritable?.();
      if (w) { await w.write(buf); await w.close(); return 'opfs'; }
    } catch { /* fall through */ }
  }
  await put('modelBlobs', id, buf);
  return 'idb';
}

export async function readModelBytes(rec: ModelRecord): Promise<ArrayBuffer> {
  if (rec.storage === 'opfs') {
    const dir = await opfsDir(); if (!dir) throw new Error('OPFS unavailable');
    const f = await (await dir.getFileHandle(`${rec.id}.onnx`)).getFile();
    return f.arrayBuffer();
  }
  const b = await get<ArrayBuffer>('modelBlobs', rec.id);
  if (!b) throw new Error(`Model bytes missing for ${rec.name}`);
  return b;
}

export async function removeModel(rec: ModelRecord) {
  if (rec.storage === 'opfs') { const dir = await opfsDir(); await dir?.removeEntry(`${rec.id}.onnx`).catch(() => {}); }
  else await del('modelBlobs', rec.id);
  await del('models', rec.id);
}

export async function verifyModel(rec: ModelRecord): Promise<boolean> {
  const b = await readModelBytes(rec);
  const ok = (await sha256(b)) === rec.sha256 && b.byteLength === rec.size;
  if (ok) await put('models', rec.id, { ...rec, verifiedAt: Date.now() });
  return ok;
}

export const listModels = () => all<ModelRecord>('models');
export const saveModelRecord = (r: ModelRecord) => put('models', r.id, r);
