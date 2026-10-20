/** Converts an F0 track into editable note suggestions and renders note edits back into a target F0 curve. */
import { type F0Track, hzToMidi, midiToHz } from './f0';

export interface Note {
  id: string;
  start: number; // seconds
  end: number;
  midi: number; // detected (median) pitch
  shift: number; // user pitch shift (semitones)
  gainDb: number;
  vibrato: number; // vibrato depth scale (1 = original)
  timeShift: number; // seconds (timing correction)
  formant: number; // formant factor (1 = none)
}

let uid = 0;
export const newNoteId = () => `n${Date.now().toString(36)}${(uid++).toString(36)}`;

export function segmentNotes(tr: F0Track, minDur = 0.08, splitCents = 70): Note[] {
  const fps = tr.sampleRate / tr.hop, notes: Note[] = [];
  let i = 0;
  const n = tr.f0.length;
  while (i < n) {
    if (!tr.voiced[i]) { i++; continue; }
    let j = i;
    const vals: number[] = [];
    let ref = hzToMidi(tr.f0[i]);
    while (j < n && tr.voiced[j]) {
      const m = hzToMidi(tr.f0[j]);
      // split when pitch moves steadily away from running reference
      if (vals.length > 6 && Math.abs(m - ref) * 100 > splitCents * 1.5) {
        const recent = vals.slice(-4).reduce((a, b) => a + b, 0) / 4;
        if (Math.abs(recent - ref) * 100 > splitCents) break;
      }
      vals.push(m);
      if (vals.length <= 10) ref = vals.reduce((a, b) => a + b, 0) / vals.length;
      j++;
    }
    if (j === i) j = i + 1;
    const dur = (j - i) / fps;
    if (dur >= minDur) {
      const s = vals.slice().sort((a, b) => a - b);
      notes.push({ id: newNoteId(), start: i / fps, end: j / fps, midi: s[s.length >> 1], shift: 0, gainDb: 0, vibrato: 1, timeShift: 0, formant: 1 });
    }
    i = j;
  }
  return notes;
}

/** Moving-average smoothing of the voiced midi curve (used to separate vibrato from the melody line). */
export function smoothMidi(tr: F0Track, win = 25): Float32Array {
  const n = tr.f0.length, m = new Float32Array(n), out = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = tr.voiced[i] ? hzToMidi(tr.f0[i]) : NaN;
  for (let i = 0; i < n; i++) {
    if (!tr.voiced[i]) continue;
    let s = 0, c = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(n - 1, i + win); k++) if (!Number.isNaN(m[k])) { s += m[k]; c++; }
    out[i] = s / c;
  }
  return out;
}

export interface CurveOptions {
  transpose?: number; // semitones
  correction?: number; // 0..1 pull to scale
  scale?: number[] | null; // pitch classes allowed
  vibratoScale?: number;
  notes?: Note[];
  octaveFix?: { low: number; high: number } | null; // target range (midi) for automatic octave correction
}

/** Builds the edited target F0 curve. Returns new Hz array (0 = unvoiced). */
export function buildTargetCurve(tr: F0Track, o: CurveOptions): Float32Array {
  const n = tr.f0.length, fps = tr.sampleRate / tr.hop, out = new Float32Array(n);
  const smooth = smoothMidi(tr), vib = o.vibratoScale ?? 1;
  const noteAt = new Int32Array(n).fill(-1);
  (o.notes ?? []).forEach((nt, idx) => { for (let f = Math.floor(nt.start * fps); f < Math.ceil(nt.end * fps) && f < n; f++) if (f >= 0) noteAt[f] = idx; });
  for (let i = 0; i < n; i++) {
    if (!tr.voiced[i] || tr.f0[i] <= 0) continue;
    let m = hzToMidi(tr.f0[i]);
    const nt = noteAt[i] >= 0 ? o.notes![noteAt[i]] : null;
    const vs = vib * (nt?.vibrato ?? 1);
    m = smooth[i] + (m - smooth[i]) * vs;
    if (o.correction && o.correction > 0) {
      const base = nt ? nt.midi : smooth[i];
      const target = snapToScale(base, o.scale ?? null);
      m += (target - base) * o.correction;
    }
    m += (o.transpose ?? 0) + (nt?.shift ?? 0);
    out[i] = midiToHz(m);
  }
  if (o.octaveFix) {
    const { low, high } = o.octaveFix;
    for (let i = 0; i < n; i++) if (out[i] > 0) {
      let m = hzToMidi(out[i]);
      while (m < low - 1) m += 12;
      while (m > high + 1) m -= 12;
      out[i] = midiToHz(m);
    }
  }
  return out;
}

export function snapToScale(m: number, scale: number[] | null): number {
  if (!scale || !scale.length) return Math.round(m);
  let best = Math.round(m), bd = 99;
  for (let k = Math.floor(m) - 2; k <= Math.ceil(m) + 2; k++) if (scale.includes(((k % 12) + 12) % 12) && Math.abs(k - m) < bd) { bd = Math.abs(k - m); best = k; }
  return best;
}

export const scalePitchClasses = (tonic: number, mode: 'major' | 'minor') =>
  (mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]).map((s) => (s + tonic) % 12);

/** Diatonic interval: semitones needed to move `degrees` scale steps above midi note m. */
export function diatonicInterval(m: number, degrees: number, scale: number[]): number {
  const pc = ((Math.round(m) % 12) + 12) % 12;
  let idx = scale.indexOf(pc);
  if (idx < 0) { let b = 0, bd = 99; scale.forEach((s, i) => { const d = Math.min(Math.abs(s - pc), 12 - Math.abs(s - pc)); if (d < bd) { bd = d; b = i; } }); idx = b; }
  const steps = Math.abs(degrees), dir = Math.sign(degrees);
  let semis = 0, cur = idx;
  for (let s = 0; s < steps; s++) {
    const nx = (cur + dir + 7) % 7;
    let d = scale[nx] - scale[cur];
    if (dir > 0 && d <= 0) d += 12; if (dir < 0 && d >= 0) d -= 12;
    semis += d; cur = nx;
  }
  return semis;
}
