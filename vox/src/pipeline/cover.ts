/**
 * AI cover conversion orchestrator. Neural path: RVC ONNX in the worker. DSP path (built-in
 * characters only): PSOLA pitch + formant processing, always labelled as non-neural.
 */
import { yinF0, hzToMidi, type F0Track } from '../audio/f0';
import { buildTargetCurve, scalePitchClasses } from '../audio/notes';
import { microVariationCents, processVocal } from '../audio/humanvoice';
import { estimateLag, shift, transferEnvelope, preserveUnvoiced, blend } from '../audio/postconvert';
import { formantShift, psola } from '../audio/psola';
import { resample } from '../audio/resample';
import { applyBiquad, biquad } from '../audio/dsp';
import { toMono, type Pcm, nrmsDifference } from '../audio/pcm';
import { spectralCentroid } from '../audio/analysis';
import { engine } from '../ml/engine';
import { readModelBytes, type ModelRecord } from '../ml/modelStore';
import type { CoverSettings, Singer } from '../project/types';
import type { Note } from '../audio/notes';

export interface ConversionEvidence {
  engine: string; backend: string; neural: boolean; seconds: number; chunks: number; ms: number;
  diffFromSource: number; centroidSourceHz: number; centroidOutHz: number; melodyMedianCentsError: number | null; lagMs: number; modelSampleRate: number;
}
export interface ConversionResult { dry: Pcm; processed: Pcm; f0: F0Track; evidence: ConversionEvidence; report: string[]; }

export interface ConvertArgs {
  vocal: Pcm; settings: CoverSettings; singer: Singer; models: { voice?: ModelRecord; content?: ModelRecord };
  key?: { tonic: number; mode: 'major' | 'minor' } | null; notes?: Note[]; f0Override?: Float32Array | null;
  rangeSec?: { start: number; end: number } | null; maxLoaded: number;
  onProgress?: (f: number, stage: string) => void;
}

const SR = 44100;

function medianCentsError(target: Float32Array, out: F0Track): number | null {
  const e: number[] = [];
  for (let i = 0; i < Math.min(target.length, out.f0.length); i++) if (target[i] > 0 && out.voiced[i]) {
    let c = (hzToMidi(out.f0[i]) - hzToMidi(target[i])) * 100; c = ((c % 1200) + 1800) % 1200 - 600; e.push(Math.abs(c)); // octave-agnostic
  }
  if (e.length < 10) return null;
  e.sort((a, b) => a - b); return e[e.length >> 1];
}

export async function convertVocal(a: ConvertArgs): Promise<ConversionResult> {
  const t0 = performance.now(), s = a.settings, prog = a.onProgress ?? (() => {});
  let src = a.vocal;
  if (a.rangeSec) { const st = Math.floor(a.rangeSec.start * src.sampleRate), en = Math.floor(a.rangeSec.end * src.sampleRate); src = { sampleRate: src.sampleRate, channels: src.channels.map((c) => c.slice(st, en)) }; }
  const mono = resample(toMono(src), src.sampleRate, SR);
  prog(0.02, 'Resampling to 16 kHz');
  const x16 = resample(mono, SR, 16000);
  prog(0.05, 'Extracting F0 (YIN, 100 fps)');
  const tr = yinF0(x16, 16000, { fmin: 50, fmax: 1100 });
  const scale = a.key ? scalePitchClasses(a.key.tonic, a.key.mode) : null;
  let target = a.f0Override && !a.rangeSec ? a.f0Override : buildTargetCurve(tr, {
    transpose: s.transpose + (a.singer.mode === 'dsp-character' ? a.singer.dspCharacter.transpose : 0), correction: s.pitchCorrection, scale, vibratoScale: s.vibrato,
    notes: a.rangeSec ? (a.notes ?? []).map((n) => ({ ...n, start: n.start - a.rangeSec!.start, end: n.end - a.rangeSec!.start })) : a.notes,
    octaveFix: s.autoOctave ? { low: s.rangeLow, high: s.rangeHigh } : null,
  });
  if (s.microVariation > 0) { const mv = microVariationCents(target.length, 100, s.microVariation); target = target.map((f, i) => (f > 0 ? f * Math.pow(2, mv[i] / 1200) : 0)); }
  const report: string[] = [];
  let dry: Float32Array, engineName: string, backend = 'cpu-dsp', neural = false, chunks = 0, modelSr = SR;
  if (a.singer.mode === 'neural-rvc') {
    const { voice, content } = a.models;
    if (!voice || !content) throw new Error('This singer needs both a voice model (RVC .onnx) and a content encoder (ContentVec/HuBERT .onnx). Add them in Model Manager.');
    prog(0.08, 'Loading content encoder');
    await engine.load(content.id, await readModelBytes(content), s.backend, a.maxLoaded);
    prog(0.12, 'Loading voice model');
    await engine.load(voice.id, await readModelBytes(voice), s.backend, a.maxLoaded);
    engine.touch(content.id);
    const r = await engine.call('rvc', { contentKey: content.id, genKey: voice.id, x16, params: { targetF0: target, noiseScale: s.stability, speakerId: a.singer.speakerId, chunkSec: s.chunkSec, overlapSec: s.overlapSec, contextSec: s.contextSec } }, [], (f, st) => prog(0.15 + f * 0.65, st));
    dry = resample(r.audio, r.sampleRate, SR); modelSr = r.sampleRate; backend = r.backend; neural = true; chunks = r.chunks.length;
    engineName = `RVC ONNX (${voice.name})`;
    report.push(`Neural conversion: ${chunks} chunks @ ${r.sampleRate} Hz, features ${r.featureDim}-d, backend ${r.backend}`);
  } else if (a.singer.mode === 'dsp-character') {
    prog(0.3, 'PSOLA pitch rendering (DSP)');
    const tr44: F0Track = tr; // time-based mapping inside PSOLA uses hop/sampleRate
    const ratio = new Float32Array(tr.f0.length);
    for (let i = 0; i < ratio.length; i++) ratio[i] = tr.voiced[i] && target[i] > 0 ? target[i] / tr.f0[i] : 1;
    dry = psola(mono, SR, tr44, { ratio });
    prog(0.6, 'Formant character (DSP)');
    dry = formantShift(dry, SR, { ...tr, f0: target.map((f, i) => (f > 0 ? f : tr.f0[i])) }, a.singer.dspCharacter.formant);
    engineName = 'DSP character (PSOLA + formant) — NOT neural';
    report.push('DSP character render (no neural model involved)');
  } else throw new Error('This singer only has an analysis profile — no voice model is attached, so conversion is not possible. Attach an RVC model in My AI Singers.');
  dry = dry.length > mono.length ? dry.subarray(0, mono.length).slice() : (() => { const o = new Float32Array(mono.length); o.set(dry); return o; })();

  prog(0.82, 'Alignment');
  const lag = estimateLag(mono, dry, SR, 0.08); dry = shift(dry, lag);
  report.push(`Alignment: ${(lag / SR * 1000).toFixed(1)} ms`);
  let y = dry;
  prog(0.85, 'Expression & unvoiced preservation');
  y = transferEnvelope(mono, y, SR, s.expression);
  y = preserveUnvoiced(mono, y, SR, tr, s.unvoicedPreservation);
  if (s.consonantProtection > 0) {
    // consonant protection: restore the source's >3 kHz band on unvoiced frames (s, t, k, breaths)
    const hi = applyBiquad(mono, biquad('highpass', 3000, SR)), unv = preserveUnvoiced(hi, new Float32Array(hi.length), SR, tr, 1);
    for (let i = 0; i < y.length; i++) y[i] += unv[i] * s.consonantProtection;
  }
  if (Math.abs(s.formant - 1) > 1e-3) { prog(0.88, 'Formant adjustment (DSP)'); y = formantShift(y, SR, { ...tr, f0: target.map((f, i) => (f > 0 ? f : tr.f0[i])) }, s.formant); }
  y = blend(mono, y, s.voiceBlend);
  prog(0.9, 'HUMANVOICE engine');
  const hv = processVocal({ sampleRate: SR, channels: [y] }, s.hv);
  report.push(...hv.report);
  prog(0.96, 'Measuring output');
  const outTrack = yinF0(resample(dry, SR, 16000), 16000);
  const evidence: ConversionEvidence = {
    engine: engineName, backend, neural, seconds: mono.length / SR, chunks, ms: performance.now() - t0,
    diffFromSource: nrmsDifference(mono, dry), centroidSourceHz: spectralCentroid(mono, SR), centroidOutHz: spectralCentroid(dry, SR),
    melodyMedianCentsError: medianCentsError(target, outTrack), lagMs: (lag / SR) * 1000, modelSampleRate: modelSr,
  };
  prog(1, 'Done');
  return { dry: { sampleRate: SR, channels: [dry] }, processed: hv.out, f0: tr, evidence, report };
}
