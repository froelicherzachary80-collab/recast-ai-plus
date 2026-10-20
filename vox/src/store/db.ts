/** IndexedDB persistence (projects, audio assets, singers, model registry, presets). Everything stays on device. */
import type { Pcm } from '../audio/pcm';

const DB = 'zvox-studio', VER = 1;
export const STORES = ['projects', 'assets', 'singers', 'models', 'modelBlobs', 'presets', 'kv'] as const;
export type StoreName = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;
export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async <T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openDb();
  return new Promise((res, rej) => { const t = db.transaction(store, mode), q = fn(t.objectStore(store)); t.oncomplete = () => res(q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
};
export const put = <T>(s: StoreName, key: string, v: T) => tx(s, 'readwrite', (o) => o.put(v as any, key));
export const get = <T>(s: StoreName, key: string) => tx<T | undefined>(s, 'readonly', (o) => o.get(key) as IDBRequest<T | undefined>);
export const del = (s: StoreName, key: string) => tx(s, 'readwrite', (o) => o.delete(key));
export const keys = (s: StoreName) => tx<IDBValidKey[]>(s, 'readonly', (o) => o.getAllKeys()).then((k) => k.map(String));
export const all = <T>(s: StoreName) => tx<T[]>(s, 'readonly', (o) => o.getAll() as IDBRequest<T[]>);

export interface StoredPcm { sampleRate: number; channels: ArrayBuffer[]; name: string; createdAt: number; }
export const savePcm = (id: string, p: Pcm, name: string) =>
  put<StoredPcm>('assets', id, { sampleRate: p.sampleRate, channels: p.channels.map((c) => c.slice().buffer as ArrayBuffer), name, createdAt: Date.now() });
export async function loadPcm(id: string): Promise<Pcm | null> {
  const s = await get<StoredPcm>('assets', id);
  return s ? { sampleRate: s.sampleRate, channels: s.channels.map((b) => new Float32Array(b)) } : null;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
}
