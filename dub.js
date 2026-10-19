// RECAST AI+ v0.2 — Dub Studio: replace the original actor's lines with the new actor's voice.
// Pipeline: extract scene audio → find lines (Whisper transcription or voice-activity detection) →
// record each line on a teleprompter (or import a line you generated elsewhere) → trim + time-fit
// (WSOLA, pitch preserved) to the original line so the mouth timing still matches → remove/duck the
// original voice inside each line → mix with room tone → feed the render as the new audio track.

// ───────── pure DSP (unit-tested) ─────────
export function toMono(channels) {
  const n = channels[0].length, out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** Energy-based voice activity: returns [{start,end}] in seconds. */
export function detectVoice(mono, sr, { frameMs = 20, minSpeech = 0.25, mergeGap = 0.35, pad = 0.1 } = {}) {
  const fl = Math.max(1, Math.round(sr * frameMs / 1000)), nf = Math.floor(mono.length / fl);
  if (!nf) return [];
  const db = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let s = 0; for (let i = f * fl; i < (f + 1) * fl; i++) s += mono[i] * mono[i]; db[f] = 10 * Math.log10(s / fl + 1e-10); }
  const sorted = Array.from(db).sort((a, b) => a - b), floor = sorted[Math.floor(nf * 0.15)], peak = sorted[Math.floor(nf * 0.98)];
  const thr = Math.max(floor + 10, peak - 30, -50);
  const segs = []; let st = -1;
  for (let f = 0; f <= nf; f++) {
    const on = f < nf && db[f] > thr;
    if (on && st < 0) st = f;
    if (!on && st >= 0) { segs.push([st * fl / sr, f * fl / sr]); st = -1; }
  }
  const merged = [];
  for (const s of segs) { const last = merged[merged.length - 1]; if (last && s[0] - last[1] < mergeGap) last[1] = s[1]; else merged.push([...s]); }
  const dur = mono.length / sr;
  return merged.filter(([a, b]) => b - a >= minSpeech).map(([a, b]) => ({ start: Math.max(0, a - pad), end: Math.min(dur, b + pad) }));
}

/** Trim leading/trailing silence. Returns [startSample, endSample]. */
export function trimSilence(mono, sr) {
  const v = detectVoice(mono, sr, { minSpeech: 0.08, mergeGap: 10, pad: 0.06 });
  if (!v.length) return [0, mono.length];
  return [Math.floor(v[0].start * sr), Math.ceil(v[v.length - 1].end * sr)];
}

/** WSOLA time-stretch (pitch preserved). stretch > 1 = longer. */
export function wsola(x, sr, stretch) {
  if (Math.abs(stretch - 1) < 1e-3) return Float32Array.from(x);
  const N = Math.round(sr * 0.04) & ~1, Hs = N / 2, Ha = Hs / stretch, tol = Math.round(sr * 0.012);
  const outLen = Math.round(x.length * stretch), y = new Float32Array(outLen + N), wsum = new Float32Array(outLen + N);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  let prev = 0;
  for (let k = 0; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const nat = prev + Hs; let bc = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const p = nominal + d; if (p < 0 || p + N > x.length) continue;
        let c = 0; for (let i = 0; i < N; i += 4) { const a = nat + i < x.length ? x[nat + i] : 0; c += a * x[p + i]; }
        if (c > bc) { bc = c; best = p; }
      }
    }
    best = Math.max(0, Math.min(x.length - N, best));
    if (best < 0) break;
    const o = k * Hs;
    for (let i = 0; i < N && o + i < y.length; i++) { y[o + i] += x[best + i] * win[i]; wsum[o + i] += win[i]; }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-3) y[i] /= wsum[i];
  return y.subarray(0, outLen);
}

export const rms = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };

/** Fit a take to a line: trim silence, time-stretch to the line length (clamped), level-match. */
export function fitTake(mono, sr, lineDur, targetRms, { maxStretch = 1.4, minStretch = 0.7 } = {}) {
  const [a, b] = trimSilence(mono, sr), core = mono.subarray(a, b);
  const raw = core.length / sr, want = lineDur;
  let stretch = want / Math.max(raw, 1e-3), warn = null;
  if (stretch > maxStretch) { warn = `Take is ${(want - raw).toFixed(2)} s short: it was slowed as far as sounds natural. Speak a little slower.`; stretch = maxStretch; }
  if (stretch < minStretch) { warn = `Take is ${(raw - want).toFixed(2)} s long: it was sped up as far as sounds natural. Speak a little faster.`; stretch = minStretch; }
  if (Math.abs(stretch - 1) < 0.03) stretch = 1;
  const out = wsola(core, sr, stretch), r = rms(out), g = r > 1e-5 && targetRms ? Math.min(8, targetRms / r) : 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] * g));
  return { samples: out, stretch, rawDur: raw, gain: g, warn };
}

/** 16-bit PCM WAV encoder. */
export function encodeWav(channels, sr) {
  const n = channels[0].length, nc = channels.length, buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nc, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * nc * 2, true);
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const s = Math.max(-1, Math.min(1, channels[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Deterministic synthetic room impulse (exponential-decay noise). */
export function roomImpulse(sr, seconds, seed = 7) {
  const n = Math.max(1, Math.round(sr * seconds)), L = new Float32Array(n), R = new Float32Array(n);
  let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) { const e = Math.pow(1 - i / n, 3.2); L[i] = rnd() * e; R[i] = rnd() * e; }
  return [L, R];
}

// ───────── browser side ─────────
let AC = null;
export const audioCtx = () => (AC ||= new (window.AudioContext || window.webkitAudioContext)());

/** Extract the trimmed scene audio as an AudioBuffer (Mediabunny sink, else decodeAudioData). */
export async function extractSceneAudio(file, plan, mediabunny) {
  const mb = await mediabunny();
  if (mb) {
    try {
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const at = await input.getPrimaryAudioTrack();
      if (at && (await at.canDecode())) {
        const parts = []; let sr = 0, nc = 0;
        for await (const { buffer, timestamp } of new mb.AudioBufferSink(at).buffers(plan.start, plan.end)) { parts.push({ buffer, timestamp }); sr = buffer.sampleRate; nc = buffer.numberOfChannels; }
        if (parts.length) {
          const len = Math.round((plan.end - plan.start) * sr), out = new AudioBuffer({ length: len, numberOfChannels: nc, sampleRate: sr });
          for (const { buffer, timestamp } of parts) {
            const off = Math.round((timestamp - plan.start) * sr);
            for (let c = 0; c < nc; c++) {
              const src = buffer.getChannelData(c), dst = out.getChannelData(c);
              for (let i = 0; i < src.length; i++) { const j = off + i; if (j >= 0 && j < len) dst[j] = src[i]; }
            }
          }
          return out;
        }
      }
    } catch (e) { console.warn('mediabunny audio', e); }
  }
  const full = await audioCtx().decodeAudioData(await file.arrayBuffer());
  const sr = full.sampleRate, a = Math.round(plan.start * sr), len = Math.min(full.length - a, Math.round((plan.end - plan.start) * sr));
  const out = new AudioBuffer({ length: Math.max(1, len), numberOfChannels: full.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < full.numberOfChannels; c++) out.copyToChannel(full.getChannelData(c).subarray(a, a + len), c);
  return out;
}

export async function resample(mono, fromSr, toSr) {
  const len = Math.max(1, Math.round(mono.length * toSr / fromSr));
  const oc = new OfflineAudioContext(1, len, toSr), b = oc.createBuffer(1, mono.length, fromSr);
  b.copyToChannel(mono, 0); const s = oc.createBufferSource(); s.buffer = b; s.connect(oc.destination); s.start();
  return (await oc.startRendering()).getChannelData(0);
}

// Whisper via Transformers.js (downloads the model from Hugging Face on first use; cached by the browser).
const TJS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
export const WHISPER_MODELS = { 'whisper-tiny': 'onnx-community/whisper-tiny', 'whisper-base': 'onnx-community/whisper-base' };
let asr = null, asrKey = '';
export async function transcribe(mono16k, { model = 'whisper-base', language = null, onStatus } = {}) {
  const T = await import(/* @vite-ignore */ TJS_URL);
  const id = WHISPER_MODELS[model];
  const webgpu = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  if (!asr || asrKey !== id) {
    onStatus?.('Loading ' + model + (webgpu ? ' (WebGPU)' : ' (WASM)') + '…');
    const progress_callback = p => { if (p.status === 'progress' && p.total) onStatus?.(`Downloading ${p.file}: ${Math.round(p.loaded / p.total * 100)}%`); };
    try {
      asr = await T.pipeline('automatic-speech-recognition', id, webgpu ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback } : { device: 'wasm', dtype: 'q8', progress_callback });
    } catch (e) {
      if (!webgpu) throw e;
      onStatus?.('WebGPU failed, retrying on WASM…');
      asr = await T.pipeline('automatic-speech-recognition', id, { device: 'wasm', dtype: 'q8', progress_callback });
    }
    asrKey = id;
  }
  onStatus?.('Transcribing…');
  const out = await asr(mono16k, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5, ...(language ? { language, task: 'transcribe' } : {}) });
  return (out.chunks || []).filter(c => c.text?.trim()).map(c => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] + 2), text: c.text.trim() }));
}

/** Microphone recorder. */
export class MicRecorder {
  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } });
    return this;
  }
  start() {
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported?.(t));
    this.chunks = []; this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.rec.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.done = new Promise(r => (this.rec.onstop = r)); this.rec.start(100);
  }
  async stop() { this.rec.stop(); await this.done; return new Blob(this.chunks, { type: this.rec.mimeType || 'audio/mp4' }); }
  close() { this.stream?.getTracks().forEach(t => t.stop()); }
}
export async function decodeBlob(blob) { return audioCtx().decodeAudioData(await blob.arrayBuffer()); }

export function beep(freq = 880, ms = 120) {
  const ac = audioCtx(), o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = freq; g.gain.value = 0.15; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + ms / 1000);
}

/** Mix the final dub. scene: AudioBuffer; lines: [{start,end,fit:Float32Array(sr), enabled}].
 *  mode: 'mute' (silence original in lines), 'duck' (lower by duckDb), 'center' (remove center-panned voice, keep stereo sides). */
export async function mixDub(scene, lines, { mode = 'duck', duckDb = -28, room = 0.15, tone = 0, voiceGain = 1 } = {}) {
  const sr = scene.sampleRate, nc = Math.max(2, scene.numberOfChannels), len = scene.length;
  const oc = new OfflineAudioContext(nc, len, sr);
  const active = lines.filter(l => l.enabled !== false && l.fit);
  const orig = oc.createBufferSource(); orig.buffer = scene;
  const og = oc.createGain(); orig.connect(og); og.connect(oc.destination);
  const lowG = mode === 'mute' ? 0.0001 : mode === 'center' ? 0.0001 : Math.pow(10, duckDb / 20), F = 0.05;
  og.gain.setValueAtTime(1, 0);
  let side = null, sg = null;
  if (mode === 'center' && scene.numberOfChannels >= 2) {
    const L = scene.getChannelData(0), R = scene.getChannelData(1), sb = oc.createBuffer(2, len, sr), a = sb.getChannelData(0), b = sb.getChannelData(1);
    for (let i = 0; i < len; i++) { const s = (L[i] - R[i]) * 0.5; a[i] = s; b[i] = -s; }
    side = oc.createBufferSource(); side.buffer = sb; sg = oc.createGain(); sg.gain.setValueAtTime(0, 0); side.connect(sg); sg.connect(oc.destination);
  }
  for (const l of active) {
    const t0 = Math.max(0, l.start - F), t1 = l.end + F;
    og.gain.setValueAtTime(1, t0); og.gain.linearRampToValueAtTime(lowG, t0 + F); og.gain.setValueAtTime(lowG, t1 - F); og.gain.linearRampToValueAtTime(1, t1);
    if (sg) { sg.gain.setValueAtTime(0, t0); sg.gain.linearRampToValueAtTime(1, t0 + F); sg.gain.setValueAtTime(1, t1 - F); sg.gain.linearRampToValueAtTime(0, t1); }
  }
  // voice bus: high-pass, tone (low-pass tilt to match scene), room reverb
  const bus = oc.createGain(); bus.gain.value = voiceGain;
  const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85;
  const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 16000 - tone * 12000;
  bus.connect(hp); hp.connect(lp);
  const dry = oc.createGain(); dry.gain.value = 1 - room * 0.5; lp.connect(dry); dry.connect(oc.destination);
  if (room > 0.01) {
    const [IL, IR] = roomImpulse(sr, 0.25 + room * 1.2), ir = oc.createBuffer(2, IL.length, sr); ir.copyToChannel(IL, 0); ir.copyToChannel(IR, 1);
    const conv = oc.createConvolver(); conv.buffer = ir; const wet = oc.createGain(); wet.gain.value = room * 0.6;
    lp.connect(conv); conv.connect(wet); wet.connect(oc.destination);
  }
  for (const l of active) {
    const b = oc.createBuffer(1, l.fit.length, sr); b.copyToChannel(l.fit, 0);
    const s = oc.createBufferSource(); s.buffer = b; const g = oc.createGain(); g.gain.value = l.gain ?? 1;
    s.connect(g); g.connect(bus); s.start(Math.max(0, l.start + (l.offset || 0)));
  }
  orig.start(0); side?.start(0);
  return oc.startRendering();
}
