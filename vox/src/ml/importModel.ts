import { engine } from './engine';
import { sha256, writeModelBytes, saveModelRecord, type ModelRecord, type ModelKind } from './modelStore';
import { uid } from '../project/defaults';

/** Imports model bytes: hashes, inspects the graph (real ORT session) to classify it, then stores in OPFS/IDB. */
export async function importModelBytes(buf: ArrayBuffer, name: string, source: string, license: string, permissionConfirmed: boolean, onProgress?: (f: number, s: string) => void): Promise<ModelRecord> {
  if (buf.byteLength < 16) throw new Error('File too small to be an ONNX model');
  onProgress?.(0.1, 'Computing SHA-256');
  const hash = await sha256(buf);
  onProgress?.(0.3, 'Inspecting graph with ONNX Runtime (WASM)');
  let info: any;
  try { info = await engine.inspect(buf.slice(0)); }
  catch (e) { throw new Error(`ONNX Runtime could not load this file: ${(e as Error).message}. Only .onnx models are supported (PyTorch .pth must be exported to ONNX first).`); }
  onProgress?.(0.7, 'Storing on device');
  const id = uid('mdl'), storage = await writeModelBytes(id, buf);
  const rec: ModelRecord = { id, name, kind: info.kind as ModelKind, size: buf.byteLength, sha256: hash, storage, addedAt: Date.now(), source, license,
    inputs: info.inputs, outputs: info.outputs, notes: '', verifiedAt: Date.now(), permissionConfirmed, details: info.details };
  await saveModelRecord(rec);
  onProgress?.(1, 'Done');
  return rec;
}

export async function fetchWithProgress(url: string, onProgress?: (f: number, s: string) => void): Promise<ArrayBuffer> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader(), parts: Uint8Array[] = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress?.(total ? got / total : 0, `Downloading ${(got / 1e6).toFixed(1)} MB${total ? ` / ${(total / 1e6).toFixed(1)} MB` : ''}`); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
