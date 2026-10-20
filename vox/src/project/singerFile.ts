/** Singer profile / backup file (.zsinger): "ZSNG" + JSON + optional sample WAVs and model files. */
import { encodeWav, decodeWav } from '../audio/wav';
import { loadPcm, savePcm } from '../store/db';
import { readModelBytes, writeModelBytes, saveModelRecord, sha256, type ModelRecord } from '../ml/modelStore';
import { uid } from './defaults';
import type { Singer } from './types';

interface Entry { kind: 'sample' | 'model'; id: string; offset: number; length: number; }

export async function exportSinger(s: Singer, models: ModelRecord[], opts: { samples: boolean; models: boolean }): Promise<Blob> {
  const parts: BlobPart[] = [], entries: Entry[] = []; let off = 0;
  if (opts.samples) for (const id of s.sampleAssetIds) { const p = await loadPcm(id); if (!p) continue; const w = encodeWav(p, 16); parts.push(w); entries.push({ kind: 'sample', id, offset: off, length: w.byteLength }); off += w.byteLength; }
  const recs = models.filter((m) => m.id === s.voiceModelId || m.id === s.contentModelId);
  if (opts.models) {
    if (!s.permission?.confirmed) throw new Error('Model files can only be exported for singers with a confirmed permission statement');
    for (const m of recs) { const b = await readModelBytes(m); parts.push(b); entries.push({ kind: 'model', id: m.id, offset: off, length: b.byteLength }); off += b.byteLength; }
  }
  const json = new TextEncoder().encode(JSON.stringify({ format: 'zsinger', version: 1, singer: s, models: recs, entries, syntheticVoice: true }));
  const pre = new Uint8Array(12); pre.set([0x5a, 0x53, 0x4e, 0x47]); const dv = new DataView(pre.buffer); dv.setUint32(4, 1, true); dv.setUint32(8, json.length, true);
  return new Blob([pre, json, ...parts], { type: 'application/octet-stream' });
}

export async function importSingerFile(blob: Blob, existing: ModelRecord[]): Promise<{ singer: Singer; importedModels: ModelRecord[] }> {
  const dv = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (dv.getUint32(0, false) !== 0x5a534e47) throw new Error('Not a ZSNG singer file');
  const len = dv.getUint32(8, true), h = JSON.parse(new TextDecoder().decode(await blob.slice(12, 12 + len).arrayBuffer()));
  const base = 12 + len, singer: Singer = { ...h.singer, id: uid('sgr'), sampleAssetIds: [], updatedAt: Date.now() };
  const importedModels: ModelRecord[] = [];
  for (const e of h.entries as Entry[]) {
    const bytes = await blob.slice(base + e.offset, base + e.offset + e.length).arrayBuffer();
    if (e.kind === 'sample') { const id = uid('ast'); await savePcm(id, decodeWav(bytes), 'singer sample'); singer.sampleAssetIds.push(id); }
    else {
      const rec: ModelRecord = (h.models as ModelRecord[]).find((m) => m.id === e.id)!;
      const hash = await sha256(bytes);
      if (hash !== rec.sha256) throw new Error(`Model ${rec.name} failed integrity check`);
      const dup = existing.find((m) => m.sha256 === hash);
      if (dup) { if (singer.voiceModelId === rec.id) singer.voiceModelId = dup.id; if (singer.contentModelId === rec.id) singer.contentModelId = dup.id; continue; }
      const nid = uid('mdl'), storage = await writeModelBytes(nid, bytes), nr = { ...rec, id: nid, storage, addedAt: Date.now() };
      await saveModelRecord(nr); importedModels.push(nr);
      if (singer.voiceModelId === rec.id) singer.voiceModelId = nid; if (singer.contentModelId === rec.id) singer.contentModelId = nid;
    }
  }
  return { singer, importedModels };
}
