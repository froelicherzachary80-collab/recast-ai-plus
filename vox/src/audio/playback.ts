/** Browser decoding + playback via Web Audio (AudioBufferSourceNode -> AnalyserNodes for real meters). */
import type { Pcm } from './pcm';
import { decodeWav } from './wav';

let ctx: AudioContext | null = null;
export function audioCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ latencyHint: 'playback' });
  return ctx;
}

/** Decodes MP3/WAV/AAC locally. Falls back to the built-in WAV parser (e.g. for 32-bit float files Safari rejects). */
export async function decodeFile(file: Blob): Promise<Pcm> {
  const buf = await file.arrayBuffer();
  try {
    const ab = await audioCtx().decodeAudioData(buf.slice(0));
    return { sampleRate: ab.sampleRate, channels: Array.from({ length: ab.numberOfChannels }, (_, i) => ab.getChannelData(i).slice()) };
  } catch (e) {
    try { return decodeWav(buf); } catch { throw new Error(`Could not decode "${(file as File).name ?? 'file'}": ${(e as Error).message || 'unsupported format'}`); }
  }
}

export function toAudioBuffer(p: Pcm): AudioBuffer {
  const c = audioCtx(), b = c.createBuffer(p.channels.length, p.channels[0].length || 1, p.sampleRate);
  p.channels.forEach((ch, i) => b.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  return b;
}

export interface PlayHandle { stop(): void; position(): number; analysers: AnalyserNode[]; ended: Promise<void>; duration: number; }

let current: PlayHandle | null = null;
export function stopAll() { current?.stop(); current = null; }

export function play(p: Pcm, offset = 0, onEnd?: () => void): PlayHandle {
  stopAll();
  const c = audioCtx(); void c.resume();
  const src = c.createBufferSource(); src.buffer = toAudioBuffer(p);
  const split = c.createChannelSplitter(2), aL = c.createAnalyser(), aR = c.createAnalyser();
  aL.fftSize = aR.fftSize = 2048;
  src.connect(c.destination); src.connect(split); split.connect(aL, 0); split.connect(aR, p.channels.length > 1 ? 1 : 0);
  const t0 = c.currentTime; let stopped = false;
  let resolve!: () => void; const ended = new Promise<void>((r) => (resolve = r));
  src.onended = () => { stopped = true; resolve(); onEnd?.(); };
  src.start(0, offset);
  const h: PlayHandle = { stop: () => { if (!stopped) { stopped = true; try { src.stop(); } catch { /* */ } } }, position: () => offset + (c.currentTime - t0), analysers: [aL, aR], ended, duration: p.channels[0].length / p.sampleRate };
  current = h;
  return h;
}

export function analyserLevels(a: AnalyserNode): { peak: number; rms: number } {
  const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d);
  let pk = 0, s = 0; for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > pk) pk = v; s += v * v; }
  return { peak: pk, rms: Math.sqrt(s / d.length) };
}

export function downloadBlob(blob: Blob, name: string) {
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as any;
  if (nav.canShare?.({ files: [file] }) && /iPhone|iPad/.test(navigator.userAgent)) { nav.share({ files: [file], title: name }).catch(() => fallback()); return; }
  fallback();
  function fallback() { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000); }
}
