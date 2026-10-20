/**
 * HUMANVOICE ENGINE — post-production vocal processing (DSP). These modules do NOT change the
 * singer identity; identity comes only from the neural voice model. Pitch microvariation and
 * vibrato preservation act on the F0 curve that drives the neural model / PSOLA renderer.
 */
import { compress, deess, eq, expander, saturate, declick, type EqBand } from './dsp';
import type { Pcm } from './pcm';

export interface HumanVoiceParams {
  naturalDynamics: number;   // 0..1 compressor amount (gentle levelling)
  breathPreservation: number; // 0..1 (1 = keep breaths; lower = expander attenuates quiet breaths)
  formant: number;           // formant factor 0.85..1.15 (applied in conversion stage)
  microVariation: number;    // cents (0..15) slow natural drift added to F0 curve
  vibrato: number;           // vibrato depth scale (0..2)
  transientProtection: number; // 0..1 slows compressor attack to keep consonant onsets
  consonantClarity: number;  // dB presence boost at 3.5 kHz
  sibilance: number;         // 0..1 de-esser strength
  warmth: number;            // dB low-mid shelf at 250 Hz
  saturation: number;        // 0..1 harmonic drive
  declick: boolean;
  noiseManagement: number;   // 0..1 downward expander depth
  brightness: number;        // dB high shelf 8 kHz
  air: number;               // dB high shelf 12 kHz ("breathiness" perception)
}

export const HV_DEFAULT: HumanVoiceParams = {
  naturalDynamics: 0.4, breathPreservation: 0.8, formant: 1, microVariation: 0, vibrato: 1, transientProtection: 0.5,
  consonantClarity: 1, sibilance: 0.4, warmth: 0.5, saturation: 0.1, declick: true, noiseManagement: 0.2, brightness: 0, air: 0.5,
};

export const HV_PRESETS: Record<string, Partial<HumanVoiceParams>> = {
  'Natural Studio': {},
  'Soft Pop': { naturalDynamics: 0.5, air: 2, brightness: 1, sibilance: 0.5, saturation: 0.08 },
  'Emotional Ballad': { naturalDynamics: 0.3, breathPreservation: 1, vibrato: 1.15, warmth: 1.5, microVariation: 4, air: 1.5 },
  'Powerful Pop': { naturalDynamics: 0.8, consonantClarity: 2.5, saturation: 0.3, brightness: 1.5, sibilance: 0.6 },
  'Intimate Acoustic': { naturalDynamics: 0.25, breathPreservation: 1, warmth: 2, air: 1, noiseManagement: 0.05 },
  'Indie': { naturalDynamics: 0.45, saturation: 0.25, warmth: 1, brightness: -0.5, microVariation: 5 },
  'R&B': { naturalDynamics: 0.6, vibrato: 1.1, warmth: 1.5, air: 2.5, sibilance: 0.6, consonantClarity: 1.5 },
  'Cinematic': { naturalDynamics: 0.5, warmth: 1, air: 2, brightness: 0.5, breathPreservation: 0.9 },
  'Clean Vocal': { naturalDynamics: 0.5, saturation: 0, noiseManagement: 0.4, sibilance: 0.5, microVariation: 0 },
};

export const presetParams = (name: string): HumanVoiceParams => ({ ...HV_DEFAULT, ...(HV_PRESETS[name] ?? {}) });

/** Real DSP chain for the converted vocal. Returns processed audio and a report of what ran. */
export function processVocal(p: Pcm, h: HumanVoiceParams): { out: Pcm; report: string[] } {
  const report: string[] = [];
  let x = p;
  if (h.declick) { const r = declick(x, 0.5); x = r.out; report.push(`De-click: ${r.repaired} clicks repaired`); }
  if (h.noiseManagement > 0 || h.breathPreservation < 1) {
    const range = 3 + h.noiseManagement * 12 + (1 - h.breathPreservation) * 10;
    x = expander(x, -48 - (1 - h.noiseManagement) * 6, 1.8, range); report.push(`Expander range ${range.toFixed(1)} dB`);
  }
  const bands: EqBand[] = [
    { type: 'highpass', freq: 80, gain: 0, q: 0.707, on: true },
    { type: 'lowshelf', freq: 250, gain: h.warmth, q: 0.7, on: true },
    { type: 'peaking', freq: 3500, gain: h.consonantClarity, q: 0.9, on: true },
    { type: 'highshelf', freq: 8000, gain: h.brightness, q: 0.7, on: true },
    { type: 'highshelf', freq: 12000, gain: h.air, q: 0.7, on: true },
  ];
  x = eq(x, bands); report.push('Vocal EQ (HPF 80 Hz, warmth, clarity, brightness, air)');
  if (h.naturalDynamics > 0) {
    const r = compress(x, { on: true, threshold: -14 - h.naturalDynamics * 12, ratio: 1.5 + h.naturalDynamics * 3, attack: 0.003 + h.transientProtection * 0.025, release: 0.12, knee: 6, makeup: h.naturalDynamics * 4 });
    x = r.out; report.push(`Compressor max GR ${r.maxGr.toFixed(1)} dB`);
  }
  if (h.sibilance > 0) { x = deess(x, 6500, -20 - h.sibilance * 16, 4 + h.sibilance * 8); report.push('De-esser'); }
  if (h.saturation > 0) { x = saturate(x, h.saturation, 0.6); report.push('Harmonic saturation'); }
  return { out: x, report };
}

/** Deterministic slow pitch drift (cents) for natural micro-variation. Smooth, zero-mean, never random jumps. */
export function microVariationCents(frames: number, fps: number, depthCents: number, seed = 7): Float32Array {
  const out = new Float32Array(frames);
  if (depthCents <= 0) return out;
  const f1 = 0.37 + (seed % 5) * 0.03, f2 = 1.13, f3 = 2.71;
  for (let i = 0; i < frames; i++) { const t = i / fps; out[i] = depthCents * (0.55 * Math.sin(2 * Math.PI * f1 * t + seed) + 0.3 * Math.sin(2 * Math.PI * f2 * t + 1.7 * seed) + 0.15 * Math.sin(2 * Math.PI * f3 * t)); }
  return out;
}
