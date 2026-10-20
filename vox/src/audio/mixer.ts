/** Non-destructive offline multitrack renderer (source assets are never modified). */
import { compress, eq, deess, saturate, delay, reverb, stereoWidth, pan, limit, gainEnvelope, chorus, type EqBand, type CompressorParams } from './dsp';
import { dbToGain, type Pcm, toStereo } from './pcm';
import { resample } from './resample';

export type TrackKind = 'original' | 'converted' | 'instrumental' | 'harmony' | 'layer';

export interface Track {
  id: string; name: string; kind: TrackKind; assetId: string | null;
  offset: number; gainDb: number; pan: number; mute: boolean; solo: boolean;
  eq: EqBand[]; comp: CompressorParams;
  deess: { on: boolean; freq: number; threshold: number };
  saturation: number; chorus: number; width: number;
  reverbSend: number; delaySend: number;
  automation: { t: number; db: number }[];
}

export interface MasterSettings {
  eq: EqBand[]; comp: CompressorParams; width: number;
  limiter: { on: boolean; ceiling: number; release: number };
  outputGainDb: number;
  reverb: { size: number; damp: number; preDelayMs: number };
  delay: { timeMs: number; feedback: number; pingPong: boolean };
}

export const defaultEq = (): EqBand[] => [
  { type: 'highpass', freq: 40, gain: 0, q: 0.707, on: false },
  { type: 'lowshelf', freq: 120, gain: 0, q: 0.7, on: true },
  { type: 'peaking', freq: 400, gain: 0, q: 1, on: true },
  { type: 'peaking', freq: 2500, gain: 0, q: 1, on: true },
  { type: 'highshelf', freq: 9000, gain: 0, q: 0.7, on: true },
];
export const defaultComp = (on = false): CompressorParams => ({ on, threshold: -18, ratio: 3, attack: 0.01, release: 0.15, knee: 6, makeup: 0 });

let tid = 0;
export function makeTrack(kind: TrackKind, name: string, assetId: string | null): Track {
  return { id: `t${Date.now().toString(36)}${tid++}`, name, kind, assetId, offset: 0, gainDb: 0, pan: 0, mute: false, solo: false,
    eq: defaultEq(), comp: defaultComp(kind !== 'instrumental'), deess: { on: false, freq: 6500, threshold: -28 },
    saturation: 0, chorus: 0, width: 1, reverbSend: kind === 'instrumental' ? 0 : 0.15, delaySend: 0, automation: [] };
}

export const defaultMaster = (): MasterSettings => ({
  eq: defaultEq(), comp: { ...defaultComp(false), threshold: -12, ratio: 2, attack: 0.02, release: 0.2 }, width: 1,
  limiter: { on: true, ceiling: -1, release: 80 }, outputGainDb: 0,
  reverb: { size: 0.5, damp: 0.5, preDelayMs: 20 }, delay: { timeMs: 375, feedback: 0.3, pingPong: true },
});

export interface RenderRange { start: number; end: number; }

function place(src: Pcm, sr: number, offset: number, range: RenderRange): Pcm {
  const s = src.sampleRate === sr ? src : { sampleRate: sr, channels: src.channels.map((c) => resample(c, src.sampleRate, sr)) };
  const len = Math.max(0, Math.round((range.end - range.start) * sr));
  const ch = s.channels.map(() => new Float32Array(len));
  const shift = Math.round((offset - range.start) * sr);
  s.channels.forEach((c, k) => {
    const a = Math.max(0, -shift), b = Math.min(c.length, len - shift);
    if (b > a) ch[k].set(c.subarray(a, b), a + shift);
  });
  return { sampleRate: sr, channels: ch };
}

export function renderTrack(t: Track, src: Pcm, sr: number, range: RenderRange): Pcm {
  let x = place(src, sr, t.offset, range);
  x = eq(x, t.eq);
  if (t.comp.on) x = compress(x, t.comp).out;
  if (t.deess.on) x = deess(x, t.deess.freq, t.deess.threshold);
  if (t.saturation > 0) x = saturate(x, t.saturation, 0.7);
  if (t.chorus > 0) x = chorus(x, 4, 0.7, t.chorus);
  if (t.automation.length) x = { sampleRate: sr, channels: x.channels.map((c) => gainEnvelope(c, sr, t.automation.map((p) => ({ t: p.t - range.start, db: p.db })))) };
  x = pan(toStereo(x), t.pan, dbToGain(t.gainDb));
  return stereoWidth(x, t.width);
}

export function renderMix(tracks: Track[], assets: Map<string, Pcm>, master: MasterSettings, range: RenderRange, sr = 44100, opts: { skipMaster?: boolean } = {}): Pcm {
  const len = Math.max(1, Math.round((range.end - range.start) * sr));
  const L = new Float32Array(len), R = new Float32Array(len), rvL = new Float32Array(len), rvR = new Float32Array(len), dlL = new Float32Array(len), dlR = new Float32Array(len);
  const anySolo = tracks.some((t) => t.solo);
  for (const t of tracks) {
    if (t.mute || (anySolo && !t.solo) || !t.assetId) continue;
    const src = assets.get(t.assetId); if (!src) continue;
    const y = renderTrack(t, src, sr, range);
    for (let i = 0; i < len; i++) {
      const l = y.channels[0][i], r = y.channels[1][i];
      L[i] += l; R[i] += r;
      if (t.reverbSend > 0) { rvL[i] += l * t.reverbSend; rvR[i] += r * t.reverbSend; }
      if (t.delaySend > 0) { dlL[i] += l * t.delaySend; dlR[i] += r * t.delaySend; }
    }
  }
  if (rvL.some((v) => v !== 0)) {
    const w = reverb({ sampleRate: sr, channels: [rvL, rvR] }, { mix: 1, ...master.reverb });
    for (let i = 0; i < len; i++) { L[i] += w.channels[0][i] - rvL[i]; R[i] += w.channels[1][i] - rvR[i]; }
  }
  if (dlL.some((v) => v !== 0)) {
    const w = delay({ sampleRate: sr, channels: [dlL, dlR] }, { mix: 1, ...master.delay });
    for (let i = 0; i < len; i++) { L[i] += w.channels[0][i] - dlL[i]; R[i] += w.channels[1][i] - dlR[i]; }
  }
  let out: Pcm = { sampleRate: sr, channels: [L, R] };
  if (!opts.skipMaster) out = applyMaster(out, master);
  return out;
}

export function applyMaster(p: Pcm, m: MasterSettings): Pcm {
  let x = eq(p, m.eq);
  if (m.comp.on) x = compress(x, m.comp).out;
  x = stereoWidth(x, m.width);
  const g = dbToGain(m.outputGainDb);
  if (g !== 1) x = { sampleRate: x.sampleRate, channels: x.channels.map((c) => c.map((v) => v * g)) };
  if (m.limiter.on) x = limit(x, m.limiter.ceiling, m.limiter.release);
  return x;
}

export const MASTER_PRESETS: Record<string, (m: MasterSettings) => MasterSettings> = {
  'Streaming (-14 LUFS target, -1 dBTP)': (m) => ({ ...m, comp: { ...m.comp, on: true, threshold: -14, ratio: 2 }, limiter: { on: true, ceiling: -1, release: 80 } }),
  'Demo (loud, -0.5 dB ceiling)': (m) => ({ ...m, comp: { ...m.comp, on: true, threshold: -18, ratio: 3 }, outputGainDb: 3, limiter: { on: true, ceiling: -0.5, release: 60 } }),
  'High-quality WAV (gentle)': (m) => ({ ...m, comp: { ...m.comp, on: false }, outputGainDb: 0, limiter: { on: true, ceiling: -1, release: 120 } }),
};
