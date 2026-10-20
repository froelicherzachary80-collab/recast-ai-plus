/** Renders pitch-editor note edits into audio with real DSP (PSOLA pitch/vibrato, note gain, timing, formant). */
import { yinF0, type F0Track } from '../audio/f0';
import { buildTargetCurve, type Note } from '../audio/notes';
import { psola, formantShift } from '../audio/psola';
import { resample } from '../audio/resample';
import { dbToGain, toMono, type Pcm } from '../audio/pcm';

export function analyzeForEditor(p: Pcm): { tr: F0Track; x16: Float32Array } {
  const x16 = resample(toMono(p), p.sampleRate, 16000);
  return { tr: yinF0(x16, 16000), x16 };
}

export function renderEdits(p: Pcm, tr: F0Track, notes: Note[], o: { correction: number; scale: number[] | null; vibrato: number }): Pcm {
  const sr = p.sampleRate, x = toMono(p);
  const target = buildTargetCurve(tr, { notes, correction: o.correction, scale: o.scale, vibratoScale: o.vibrato });
  const ratio = new Float32Array(tr.f0.length);
  for (let i = 0; i < ratio.length; i++) ratio[i] = tr.voiced[i] && target[i] > 0 ? target[i] / tr.f0[i] : 1;
  let y = psola(x, sr, tr, { ratio });
  // per-note formant
  for (const n of notes) if (Math.abs(n.formant - 1) > 1e-3) {
    const a = Math.floor(n.start * sr), b = Math.min(y.length, Math.ceil(n.end * sr));
    const seg = formantShift(y.slice(a, b), sr, { ...tr, f0: tr.f0.slice(Math.floor(n.start * 100)), voiced: tr.voiced.slice(Math.floor(n.start * 100)), periodicity: tr.periodicity }, n.formant);
    crossfadeInto(y, seg, a, Math.round(0.01 * sr));
  }
  // timing moves & gain (with 15 ms crossfades)
  const out = y.slice(), xf = Math.round(0.015 * sr);
  for (const n of notes) {
    const a = Math.floor(n.start * sr), b = Math.min(y.length, Math.ceil(n.end * sr)), g = dbToGain(n.gainDb);
    if (Math.abs(n.timeShift) < 1e-4 && Math.abs(n.gainDb) < 0.01) continue;
    const seg = y.slice(a, b).map((v) => v * g), dst = a + Math.round(n.timeShift * sr);
    if (Math.abs(n.timeShift) > 1e-4) for (let i = a; i < b; i++) out[i] *= 0; // vacate original slot
    crossfadeInto(out, seg, dst, xf);
  }
  return { sampleRate: sr, channels: [out] };
}

function crossfadeInto(dst: Float32Array, seg: Float32Array, at: number, xf: number) {
  for (let i = 0; i < seg.length; i++) {
    const j = at + i; if (j < 0 || j >= dst.length) continue;
    const w = Math.min(1, i / xf, (seg.length - 1 - i) / xf);
    dst[j] = dst[j] * (1 - w) + seg[i] * w;
  }
}
