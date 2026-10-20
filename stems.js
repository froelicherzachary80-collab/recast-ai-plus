// RECAST AI+ v0.6 — stem separation for uploaded edits:
//   character voices (dialogue) · song vocals (singing) · music (drums + bass + other)
// AI engine: HTDemucs (Meta, MIT) via the demucs-web package + ONNX Runtime Web (WebGPU, else WASM).
// Basic engine (no download): centre-channel spectral masking. Then each vocal segment is classified as
// speech or singing from its pitch behaviour; you can flip any segment by hand.
import { fft } from './beats.js';
import { encodeWav } from './dub.js';
import { db } from './db.js';

const ORT_V = '1.20.1';
const ORT_URLS = [`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_V}/dist/ort.webgpu.bundle.min.mjs`, `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_V}/+esm`];
const DEMUCS_URL = 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/+esm';
export const DEMUCS_MODEL = { key: 'demucs', url: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx' };

// ───────── pure DSP (unit-tested) ─────────
const hann = n => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

/** STFT → {re, im} arrays of frames (each Float32Array n). */
export function stft(x, n = 2048, hop = 512) {
  const w = hann(n), frames = Math.max(1, Math.ceil((x.length + n) / hop)), re = [], im = [];
  for (let f = 0; f < frames; f++) {
    const r = new Float32Array(n), i = new Float32Array(n), off = f * hop - n / 2;
    for (let k = 0; k < n; k++) { const j = off + k; r[k] = j >= 0 && j < x.length ? x[j] * w[k] : 0; }
    fft(r, i); re.push(r); im.push(i);
  }
  return { re, im, n, hop, len: x.length };
}
/** Inverse STFT with weighted overlap-add. */
export function istft(S) {
  const { re, im, n, hop, len } = S, w = hann(n), out = new Float32Array(len), wsum = new Float32Array(len);
  for (let f = 0; f < re.length; f++) {
    const r = Float32Array.from(re[f]), i = Float32Array.from(im[f]).map(v => -v);
    fft(r, i); // inverse via conj(FFT(conj))
    const off = f * hop - n / 2;
    for (let k = 0; k < n; k++) { const j = off + k; if (j < 0 || j >= len) continue; out[j] += (r[k] / n) * w[k]; wsum[j] += w[k] * w[k]; }
  }
  for (let j = 0; j < len; j++) if (wsum[j] > 1e-6) out[j] /= wsum[j];
  return out;
}

/** Basic separation: centre-panned, voice-band energy → vocals; the rest → music. */
export function separateBasic(L, R, sr, { n = 2048, hop = 512 } = {}) {
  const SL = stft(L, n, hop), SR = stft(R, n, hop), mono = !hasStereo(L, R);
  const V = { re: [], im: [], n, hop, len: L.length };
  for (let f = 0; f < SL.re.length; f++) {
    const vr = new Float32Array(n), vi = new Float32Array(n);
    for (let k = 0; k <= n / 2; k++) {
      const hz = k * sr / n, band = hz < 90 ? 0 : hz < 150 ? (hz - 90) / 60 : hz < 6000 ? 1 : hz < 9000 ? (9000 - hz) / 3000 : 0;
      const lr = SL.re[f][k], li = SL.im[f][k], rr = SR.re[f][k], ri = SR.im[f][k];
      const ml = Math.hypot(lr, li), mr = Math.hypot(rr, ri), dr = Math.hypot(lr - rr, li - ri);
      const centre = mono ? 0.7 : Math.max(0, 1 - dr / (ml + mr + 1e-9)) ** 3;
      const m = band * centre, ar = (lr + rr) / 2, ai = (li + ri) / 2;
      vr[k] = ar * m; vi[k] = ai * m; if (k > 0 && k < n / 2) { vr[n - k] = vr[k]; vi[n - k] = -vi[k]; }
    }
    V.re.push(vr); V.im.push(vi);
  }
  const voc = istft(V), musL = new Float32Array(L.length), musR = new Float32Array(R.length);
  for (let i = 0; i < L.length; i++) { musL[i] = L[i] - voc[i]; musR[i] = R[i] - voc[i]; }
  return { vocals: { left: voc, right: voc }, music: { left: musL, right: musR }, engine: 'basic' };
}
const hasStereo = (L, R) => { let d = 0, s = 0; for (let i = 0; i < L.length; i += 7) { d += Math.abs(L[i] - R[i]); s += Math.abs(L[i]) + Math.abs(R[i]); } return d > s * 0.02; };

/** Pitch track (Hz, 0 = unvoiced) by normalized autocorrelation, hop 10 ms. */
export function pitchTrack(x, sr, { hopMs = 10, minF = 80, maxF = 700 } = {}) {
  const hop = Math.round(sr * hopMs / 1000), win = Math.round(sr * 0.04), out = [];
  const lo = Math.floor(sr / maxF), hi = Math.ceil(sr / minF);
  for (let s = 0; s + win + hi < x.length; s += hop) {
    let e = 0; for (let i = 0; i < win; i++) e += x[s + i] * x[s + i];
    if (e / win < 1e-5) { out.push(0); continue; }
    let best = 0, bl = 0;
    for (let L = lo; L <= hi; L++) { let c = 0, e2 = 0; for (let i = 0; i < win; i++) { c += x[s + i] * x[s + i + L]; e2 += x[s + i + L] ** 2; } const r = c / Math.sqrt(e * e2 + 1e-12); if (r > best) { best = r; bl = L; } }
    out.push(best > 0.6 ? sr / bl : 0);
  }
  return out;
}

/** Speech or singing? Singing holds steady notes; speech glides and breaks into syllables. */
export function classifySegment(x, sr) {
  const f0 = pitchTrack(x, sr), voiced = f0.filter(v => v > 0).length / Math.max(1, f0.length);
  let stable = 0, pairs = 0, run = 0, longest = 0;
  for (let i = 1; i < f0.length; i++) {
    if (f0[i] > 0 && f0[i - 1] > 0) { pairs++; const st = Math.abs(12 * Math.log2(f0[i] / f0[i - 1])); if (st < 0.3) { stable++; run++; longest = Math.max(longest, run); } else run = 0; } else run = 0;
  }
  const stableFrac = pairs ? stable / pairs : 0, longestS = longest * 0.01;
  // held notes are the strongest cue; continuous voicing with very steady pitch is the second
  const singing = longestS >= 0.2 || (stableFrac > 0.85 && voiced > 0.92 && longestS > 0.12);
  const confidence = Math.min(1, singing ? (longestS - 0.12) / 0.2 : (0.2 - longestS) / 0.12);
  return { kind: singing ? 'singing' : 'voice', confidence: Math.max(0, confidence), voiced, stableFrac, longest: longestS };
}

/** Segment the vocal stem and classify it in 0.5 s windows (smoothed), so a song with spoken lines in
 *  between is split at the right places. Labels are suggestions: the UI lets you flip any part. */
export function classifyVocals(vocals, sr, { win = 0.5, hop = 0.25, minSeg = 0.4 } = {}) {
  const active = activeParts(vocals, sr), out = [];
  for (const seg of active) {
    const labels = [];
    for (let t = seg.start; t < seg.end - 0.05; t += hop) {
      const a = Math.floor(t * sr), b = Math.min(vocals.length, Math.floor(Math.min(seg.end, t + win) * sr));
      labels.push({ t, c: b - a > sr * 0.15 ? classifySegment(vocals.subarray(a, b), sr) : { kind: 'voice', confidence: 0 } });
    }
    const sm = labels.map((l, i) => { const w = labels.slice(Math.max(0, i - 1), i + 2), sing = w.filter(x => x.c.kind === 'singing').length; return sing * 2 > w.length ? 'singing' : 'voice'; });
    let cur = null;
    sm.forEach((k, i) => {
      const t0 = i === 0 ? seg.start : labels[i].t + hop / 2, t1 = i === sm.length - 1 ? seg.end : labels[i + 1].t + hop / 2;
      if (cur && cur.kind === k) cur.end = t1; else { cur = { start: t0, end: t1, kind: k }; out.push(cur); }
    });
  }
  // absorb tiny fragments into their neighbour
  for (let i = out.length - 1; i >= 0; i--) if (out[i].end - out[i].start < minSeg && out.length > 1) { const prev = out[i - 1], next = out[i + 1]; const n = prev && Math.abs(prev.end - out[i].start) < 0.01 ? prev : next && Math.abs(next.start - out[i].end) < 0.01 ? next : null; if (n) { n.start = Math.min(n.start, out[i].start); n.end = Math.max(n.end, out[i].end); out.splice(i, 1); } }
  return out.map(s => ({ ...s, auto: s.kind }));
}

/** Where the vocal stem has sound at all (absolute + relative level), merged across short pauses. */
export function activeParts(x, sr, { frameMs = 20, mergeGap = 0.3, minLen = 0.2 } = {}) {
  const fl = Math.round(sr * frameMs / 1000), nf = Math.floor(x.length / fl), db = new Float32Array(nf);
  let peak = -120; for (let f = 0; f < nf; f++) { let e = 0; for (let i = f * fl; i < (f + 1) * fl; i++) e += x[i] * x[i]; db[f] = 10 * Math.log10(e / fl + 1e-12); peak = Math.max(peak, db[f]); }
  const thr = Math.max(-50, peak - 35), segs = [];
  let st = -1; for (let f = 0; f <= nf; f++) { const on = f < nf && db[f] > thr; if (on && st < 0) st = f; if (!on && st >= 0) { segs.push([st * fl / sr, f * fl / sr]); st = -1; } }
  const merged = []; for (const s2 of segs) { const l = merged[merged.length - 1]; if (l && s2[0] - l[1] < mergeGap) l[1] = s2[1]; else merged.push([...s2]); }
  return merged.filter(([a, b]) => b - a >= minLen).map(([a, b]) => ({ start: a, end: b }));
}

/** Split the vocal stem into voice / singing tracks by segment, with 25 ms fades. */
export function splitVocals(voc, sr, segs) {
  const voice = new Float32Array(voc.length), sing = new Float32Array(voc.length), F = Math.round(sr * 0.025);
  for (const s of segs) {
    const a = Math.max(0, Math.floor(s.start * sr)), b = Math.min(voc.length, Math.ceil(s.end * sr)), dst = s.kind === 'singing' ? sing : voice;
    for (let i = a; i < b; i++) { const g = Math.min(1, (i - a) / F, (b - i) / F); dst[i] += voc[i] * g; }
  }
  return { voice, sing };
}

// ───────── browser ─────────
let ortMod = null;
export async function loadOrt() {
  if (ortMod) return ortMod;
  let err;
  for (const u of ORT_URLS) { try { const m = await import(/* @vite-ignore */ u); ortMod = m.default?.InferenceSession ? m.default : m; break; } catch (e) { err = e; } }
  if (!ortMod) throw new Error('Could not load ONNX Runtime Web: ' + (err?.message || err));
  ortMod.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_V}/dist/`;
  ortMod.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  return ortMod;
}

/** HTDemucs separation of a stereo 44.1 kHz signal. Model bytes come from the Model Manager cache. */
export async function separateAI(L, R, { onProgress, onStatus } = {}) {
  const rec = await db.get('models', DEMUCS_MODEL.key);
  if (!rec) throw new Error('Install “HTDemucs stem separator” in Model Manager first (≈ 172 MB).');
  onStatus?.('Loading ONNX Runtime…'); const ort = await loadOrt();
  onStatus?.('Loading the separator…'); const { DemucsProcessor } = await import(/* @vite-ignore */ DEMUCS_URL);
  const proc = new DemucsProcessor({ ort, onProgress: p => onProgress?.(p.progress ?? 0, p), sessionOptions: { executionProviders: navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'] } });
  const bytes = rec.bytes.buffer ? rec.bytes.buffer.slice(rec.bytes.byteOffset, rec.bytes.byteOffset + rec.bytes.byteLength) : rec.bytes;
  await proc.loadModel(bytes);
  onStatus?.('Separating (this takes a while on a phone)…');
  const r = await proc.separate(L, R);
  const mix = (...xs) => { const o = new Float32Array(L.length); for (const x of xs) for (let i = 0; i < o.length; i++) o[i] += x[i] || 0; return o; };
  return { vocals: r.vocals, music: { left: mix(r.drums.left, r.bass.left, r.other.left), right: mix(r.drums.right, r.bass.right, r.other.right) }, engine: 'htdemucs' };
}

/** Resample stereo to sr2 with OfflineAudioContext. */
export async function resampleStereo(buf, sr2) {
  const len = Math.max(1, Math.round(buf.duration * sr2)), oc = new OfflineAudioContext(2, len, sr2), s = oc.createBufferSource();
  s.buffer = buf; s.connect(oc.destination); s.start(); const out = await oc.startRendering();
  return { L: out.getChannelData(0), R: out.getChannelData(1), sr: sr2 };
}

/** Full pipeline. scene: AudioBuffer. engine: 'ai' | 'basic'. Returns stems as stereo Float32 at sr. */
export async function separateScene(scene, engine, opts = {}) {
  const { L, R, sr } = await resampleStereo(scene, 44100);
  const sep = engine === 'ai' ? await separateAI(L, R, opts) : separateBasic(L, R, sr);
  const vocMono = new Float32Array(L.length); for (let i = 0; i < L.length; i++) vocMono[i] = (sep.vocals.left[i] + sep.vocals.right[i]) / 2;
  opts.onStatus?.('Telling speech from singing…');
  const segs = classifyVocals(vocMono, sr);
  return { sr, length: L.length, engine: sep.engine, vocals: sep.vocals, music: sep.music, segs };
}

/** Voice / singing / music stems (stereo) from a separation + (edited) segment labels. */
export function buildStemTracks(sep) {
  const sl = splitVocals(sep.vocals.left, sep.sr, sep.segs), sr2 = splitVocals(sep.vocals.right, sep.sr, sep.segs);
  return { voice: [sl.voice, sr2.voice], singing: [sl.sing, sr2.sing], music: [sep.music.left, sep.music.right] };
}
export const stemWav = (pair, sr) => encodeWav(pair, sr);

/** Mix stems + new takes. voice stem is silenced inside dubbed lines (true replacement, not ducking). */
export async function mixStems(tracks, sr, lines, { voiceVol = 1, singVol = 1, musicVol = 1, newVol = 1, room = 0.1 } = {}) {
  const len = tracks.music[0].length, oc = new OfflineAudioContext(2, len, sr);
  const play = (pair, vol, gainAutomation) => { const b = oc.createBuffer(2, len, sr); b.copyToChannel(pair[0], 0); b.copyToChannel(pair[1], 1); const s = oc.createBufferSource(); s.buffer = b; const g = oc.createGain(); g.gain.value = vol; gainAutomation?.(g.gain); s.connect(g); g.connect(oc.destination); s.start(0); };
  play(tracks.music, musicVol); play(tracks.singing, singVol);
  const dub = lines.filter(l => l.fit && l.enabled !== false), F = 0.03;
  play(tracks.voice, voiceVol, gp => { for (const l of dub) { gp.setValueAtTime(voiceVol, Math.max(0, l.start - F)); gp.linearRampToValueAtTime(0, l.start); gp.setValueAtTime(0, l.end); gp.linearRampToValueAtTime(voiceVol, l.end + F); } });
  for (const l of dub) {
    const b = oc.createBuffer(1, l.fit.length, l.sr || sr); b.copyToChannel(l.fit, 0);
    const s = oc.createBufferSource(); s.buffer = b; const g = oc.createGain(); g.gain.value = newVol * (l.gain ?? 1);
    s.connect(g); g.connect(oc.destination); s.start(Math.max(0, l.start));
  }
  return oc.startRendering();
}
