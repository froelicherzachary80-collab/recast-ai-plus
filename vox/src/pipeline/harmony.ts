/** Algorithmic harmony (PSOLA pitch shifting) — explicitly NOT neural generative singing. */
import { yinF0 } from '../audio/f0';
import { pitchShift, formantShift } from '../audio/psola';
import { diatonicInterval, scalePitchClasses, smoothMidi } from '../audio/notes';
import { resample } from '../audio/resample';
import { toMono, type Pcm } from '../audio/pcm';
import type { HarmonyLayer } from '../project/types';

export function renderHarmony(vocal: Pcm, h: HarmonyLayer, key: { tonic: number; mode: 'major' | 'minor' } | null): Pcm {
  const sr = vocal.sampleRate, x = toMono(vocal), x16 = resample(x, sr, 16000), tr = yinF0(x16, 16000);
  let semis: Float32Array | number = h.interval;
  if (h.mode === 'diatonic') {
    const sc = scalePitchClasses(key?.tonic ?? 0, key?.mode ?? 'major'), sm = smoothMidi(tr);
    semis = new Float32Array(tr.f0.length);
    for (let i = 0; i < tr.f0.length; i++) semis[i] = tr.voiced[i] ? diatonicInterval(sm[i], h.interval, sc) : 0;
  }
  let y = pitchShift(x, sr, tr, semis);
  if (Math.abs(h.formant - 1) > 1e-3) y = formantShift(y, sr, tr, h.formant);
  // humanize: slow, smooth timing drift (max ±humanize ms) via fractional delay
  const base = (h.delayMs / 1000) * sr, dev = (h.humanize / 1000) * sr, out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) {
    const d = base + dev * Math.sin((2 * Math.PI * 0.23 * i) / sr) * Math.sin((2 * Math.PI * 0.07 * i) / sr + 1);
    const p = i - d, j = Math.floor(p), f = p - j;
    out[i] = j >= 0 && j + 1 < y.length ? y[j] * (1 - f) + y[j + 1] * f : 0;
  }
  return { sampleRate: sr, channels: [out] };
}
