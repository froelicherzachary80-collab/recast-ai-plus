/** Local MP3 encoding with lamejs (LGPL, pure JS). Encodes in 1152-sample frames to bound memory. */
import { Mp3Encoder } from '@breezystack/lamejs';
import type { Pcm } from './pcm';

export async function encodeMp3(p: Pcm, kbps = 192, onProgress?: (f: number) => void): Promise<Blob> {
  const nch = Math.min(2, p.channels.length), enc = new Mp3Encoder(nch, p.sampleRate, kbps);
  const n = p.channels[0].length, block = 1152 * 20, parts: BlobPart[] = [];
  const toI16 = (c: Float32Array, a: number, b: number) => {
    const o = new Int16Array(b - a);
    for (let i = a; i < b; i++) { const s = Math.max(-1, Math.min(1, c[i])); o[i - a] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return o;
  };
  for (let a = 0; a < n; a += block) {
    const b = Math.min(n, a + block);
    const l = toI16(p.channels[0], a, b), r = nch > 1 ? toI16(p.channels[1], a, b) : undefined;
    const buf = r ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (buf.length) parts.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.length).slice());
    if (onProgress && (a / block) % 20 === 0) { onProgress(b / n); await new Promise((r2) => setTimeout(r2, 0)); }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length).slice());
  onProgress?.(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}
