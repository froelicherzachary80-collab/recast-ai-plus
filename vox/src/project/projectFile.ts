/**
 * Portable project file (.zvox): "ZVOX" magic, version, JSON header length, JSON header, then
 * optional bundled audio assets as WAV blobs. Built from Blob parts to avoid one huge copy.
 */
import { encodeWav, decodeWav } from '../audio/wav';
import type { Pcm } from '../audio/pcm';
import type { Project, Singer } from './types';

export interface BundleEntry { id: string; offset: number; length: number; }
interface Header { format: 'zvox'; version: 1; project: Project; singer?: Singer | null; bundled: BundleEntry[]; createdBy: string; syntheticContent: true; }

export function writeProjectFile(project: Project, assets: Map<string, Pcm>, opts: { bundle: boolean; bits?: 16 | 24 | 32; singer?: Singer | null }): Blob {
  const parts: BlobPart[] = [], bundled: BundleEntry[] = [];
  let off = 0;
  if (opts.bundle) for (const id of Object.keys(project.assets)) {
    const p = assets.get(id); if (!p) continue;
    const w = encodeWav(p, opts.bits ?? 16);
    parts.push(w); bundled.push({ id, offset: off, length: w.byteLength }); off += w.byteLength;
  }
  const header: Header = { format: 'zvox', version: 1, project, singer: opts.singer ?? null, bundled, createdBy: 'ZMF VOX STUDIO+ 0.1', syntheticContent: true };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const pre = new Uint8Array(12); pre.set([0x5a, 0x56, 0x4f, 0x58]); const dv = new DataView(pre.buffer); dv.setUint32(4, 1, true); dv.setUint32(8, json.length, true);
  return new Blob([pre, json, ...parts], { type: 'application/octet-stream' });
}

export async function readProjectFile(blob: Blob): Promise<{ project: Project; singer: Singer | null; assets: Map<string, Pcm> }> {
  const head = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (head.getUint32(0, false) !== 0x5a564f58) throw new Error('Not a ZVOX project file');
  const jlen = head.getUint32(8, true);
  const h: Header = JSON.parse(new TextDecoder().decode(await blob.slice(12, 12 + jlen).arrayBuffer()));
  if (h.format !== 'zvox') throw new Error('Unsupported project format');
  const base = 12 + jlen, assets = new Map<string, Pcm>();
  for (const e of h.bundled) assets.set(e.id, decodeWav(await blob.slice(base + e.offset, base + e.offset + e.length).arrayBuffer()));
  return { project: h.project, singer: h.singer ?? null, assets };
}
