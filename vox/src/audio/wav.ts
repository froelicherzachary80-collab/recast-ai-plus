import type { Pcm } from './pcm';

export type WavFormat = 16 | 24 | 32;

/** RIFF/WAVE encoder: 16/24-bit PCM or 32-bit float. Writes into a single pre-sized buffer (no intermediate copies). */
export function encodeWav(p: Pcm, bits: WavFormat = 16): ArrayBuffer {
  const nch = p.channels.length, n = p.channels[0]?.length ?? 0;
  const bps = bits / 8, dataLen = n * nch * bps;
  const buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, p.sampleRate, true); v.setUint32(28, p.sampleRate * nch * bps, true);
  v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, p.channels[c][i]));
      if (bits === 16) { v.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true); o += 2; }
      else if (bits === 24) {
        const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(o, q & 0xff); v.setUint8(o + 1, (q >> 8) & 0xff); v.setUint8(o + 2, (q >> 16) & 0xff); o += 3;
      } else { v.setFloat32(o, p.channels[c][i], true); o += 4; }
    }
  }
  return buf;
}

/** WAV parser (PCM 8/16/24/32 and IEEE float 32/64, incl. WAVE_FORMAT_EXTENSIBLE). */
export function decodeWav(buf: ArrayBuffer): Pcm {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let o = 12, fmt = 0, nch = 0, sr = 0, bits = 0, dataOff = -1, dataLen = 0;
  while (o + 8 <= v.byteLength) {
    const id = tag(o), len = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = v.getUint16(o + 8, true); nch = v.getUint16(o + 10, true); sr = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true);
      if (fmt === 0xfffe) fmt = v.getUint16(o + 32, true);
    } else if (id === 'data') { dataOff = o + 8; dataLen = Math.min(len, v.byteLength - dataOff); break; }
    o += 8 + len + (len & 1);
  }
  if (dataOff < 0 || !nch) throw new Error('WAV missing fmt/data chunk');
  const bps = bits / 8, n = Math.floor(dataLen / (bps * nch));
  const ch = Array.from({ length: nch }, () => new Float32Array(n));
  let p = dataOff;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
    let s: number;
    if (fmt === 3) s = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true);
    else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
    else if (bits === 16) s = v.getInt16(p, true) / 32768;
    else if (bits === 24) { let q = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16); if (q & 0x800000) q -= 0x1000000; s = q / 8388608; }
    else s = v.getInt32(p, true) / 2147483648;
    ch[c][i] = s; p += bps;
  }
  return { sampleRate: sr, channels: ch };
}
