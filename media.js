// RECAST AI+ — media I/O: probe, sequential decode, random-access frames, MP4 encode, audio.
// Primary path: Mediabunny (WebCodecs). Fallback: <video> seeking + MediaRecorder.
import { fitSize } from './geometry.js';

const MB_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1/+esm';
let MB = null, mbErr = null;
export async function mediabunny() {
  if (MB || mbErr) return MB;
  try {
    if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder not available in this browser');
    MB = await import(/* @vite-ignore */ MB_URL);
  } catch (e) { mbErr = e; MB = null; }
  return MB;
}
export const mediabunnyError = () => mbErr;

export const PRESETS = {
  preview: { label: 'Mobile Preview', maxSide: 640, maxFps: 15, maxSec: 15, pose: 'pose_lite', note: 'Short clips, ≤640px, ≤15 fps. Fastest and safest on iPhone.' },
  quality: { label: 'Mobile Quality', maxSide: 1080, maxFps: 30, maxSec: 30, pose: 'pose_full', note: 'Up to 1080px and 30 fps, processed frame by frame.' },
  high: { label: 'Experimental High Quality', maxSide: 1920, maxFps: 60, maxSec: 60, pose: 'pose_full', note: 'Source resolution up to 1920px. May exhaust memory on long clips.' },
  photo: { label: 'Photo / Poster', maxSide: 3072, maxFps: 1, maxSec: 1, pose: 'pose_full', photo: true, note: 'Single image at full resolution up to 3072px on the long side.' },
};
export const VIDEO_PRESETS = ['preview', 'quality', 'high'];

export const isImageFile = f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|avif)$/i.test(f.name || '');

/** Decode an image (EXIF orientation applied) to a canvas of the given size (or natural size). */
export async function imageToCanvas(blob, width, height) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    // Safari fallback via <img> (also handles HEIC on Apple devices)
    const url = URL.createObjectURL(blob);
    try { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This image format cannot be decoded here. Try JPEG or PNG.')); i.src = url; }); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const w = width || bmp.width, h = height || bmp.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return c;
}

function videoEl(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'; v.src = url;
  return v;
}
const once = (el, ev) => new Promise((res, rej) => {
  const ok = () => { cleanup(); res(); }, bad = () => { cleanup(); rej(el.error || new Error(ev + ' failed')); };
  const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok); el.addEventListener('error', bad);
});

/** Probe a video file → metadata. */
export async function probe(file) {
  if (isImageFile(file)) {
    const c = await imageToCanvas(file);
    return { kind: 'photo', name: file.name, size: file.size, type: file.type, engine: 'image', width: c.width, height: c.height, fps: 1, duration: 1, codec: (file.type || 'image').replace('image/', '').toUpperCase(), audio: [], rotation: 0, orientation: c.width > c.height ? 'Landscape' : c.width < c.height ? 'Portrait' : 'Square' };
  }
  const meta = { name: file.name, size: file.size, type: file.type, engine: 'video-element', width: 0, height: 0, fps: 0, duration: 0, codec: '?', audio: [], rotation: 0 };
  const mb = await mediabunny();
  if (mb) {
    try {
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) throw new Error('No video track found');
      meta.width = vt.displayWidth; meta.height = vt.displayHeight; meta.rotation = vt.rotation || 0;
      meta.codec = (await vt.getCodecParameterString?.()) || vt.codec || '?';
      meta.duration = await input.computeDuration();
      try { const st = await vt.computePacketStats(120); meta.fps = st.averagePacketRate; } catch {}
      meta.canDecode = await vt.canDecode?.() ?? true;
      const ats = await input.getAudioTracks();
      for (const a of ats) meta.audio.push({ codec: a.codec, channels: a.numberOfChannels, sampleRate: a.sampleRate });
      meta.engine = meta.canDecode ? 'mediabunny' : 'video-element';
      try { meta.format = (await input.getFormat())?.name; } catch {}
    } catch (e) { meta.mbError = String(e?.message || e); }
  }
  if (!meta.width || !meta.duration) {
    const url = URL.createObjectURL(file), v = videoEl(url);
    try {
      await once(v, 'loadedmetadata');
      meta.width = v.videoWidth; meta.height = v.videoHeight; meta.duration = v.duration;
      meta.engine = 'video-element';
    } finally { URL.revokeObjectURL(url); }
  }
  if (!meta.fps || !isFinite(meta.fps)) { meta.fps = 30; meta.fpsGuessed = true; }
  meta.orientation = meta.width > meta.height ? 'Landscape' : meta.width < meta.height ? 'Portrait' : 'Square';
  return meta;
}

/** Processing plan: frames, fps, size — never silently reduced (UI shows plan.notes). */
export function makePlan(meta, trim, presetKey) {
  if (meta.kind === 'photo') {
    const size = fitSize(meta.width, meta.height, PRESETS.photo.maxSide), notes = [];
    if (size.scale < 1) notes.push(`Photo processed at ${size.width}×${size.height} (source ${meta.width}×${meta.height}); 3072px keeps the editor within iPhone Safari's canvas memory limit.`);
    return { start: 0, end: 1, fps: 1, width: size.width, height: size.height, frames: 1, preset: 'photo', photo: true, notes };
  }
  const P = PRESETS[presetKey] && !PRESETS[presetKey].photo ? PRESETS[presetKey] : PRESETS.preview;
  const start = Math.max(0, trim?.start || 0);
  let end = Math.min(meta.duration, trim?.end || meta.duration);
  const notes = [];
  if (end - start > P.maxSec) { end = start + P.maxSec; notes.push(`Clip limited to ${P.maxSec}s by the ${P.label} preset. Trim a shorter range or switch preset.`); }
  const fps = Math.min(meta.fps, P.maxFps);
  if (fps < meta.fps - 0.5) notes.push(`Processing at ${fps} fps (source ${meta.fps.toFixed(2)} fps). Duration and timing are kept.`);
  const size = fitSize(meta.width, meta.height, P.maxSide);
  if (size.scale < 1) notes.push(`Processing at ${size.width}×${size.height} (source ${meta.width}×${meta.height}) to stay within iPhone memory limits.`);
  const frames = Math.max(1, Math.floor((end - start) * fps + 1e-6));
  return { start, end, fps, width: size.width, height: size.height, frames, preset: presetKey, notes };
}

/** Pure: given a decoded frame [ts, ts+dur), return the first target index NOT covered by it (from k). */
export function framesCovered(ts, dur, nominal, plan, k) {
  const covers = ts + (dur > 0 ? dur : nominal) - 1e-4;
  while (k < plan.frames && plan.start + k / plan.fps < covers) k++;
  return k;
}

/** Sequential frame iterator: yields {index, time, canvas} for k = 0..plan.frames-1. */
export async function* iterateFrames(file, meta, plan, { signal } = {}) {
  if (meta.engine === 'image') { yield { index: 0, time: 0, canvas: await imageToCanvas(file, plan.width, plan.height) }; return; }
  const mb = meta.engine === 'mediabunny' ? await mediabunny() : null;
  if (mb) {
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    const sink = new mb.CanvasSink(vt, { width: plan.width, height: plan.height, fit: 'fill', poolSize: 2 });
    const nominal = 1 / Math.max(meta.fps, 1);
    let k = 0;
    for await (const wc of sink.canvases(plan.start, plan.end + 1)) {
      if (signal?.aborted) return;
      const next = framesCovered(wc.timestamp, wc.duration, nominal, plan, k);
      for (; k < next; k++) yield { index: k, time: plan.start + k / plan.fps, canvas: wc.canvas };
      if (k >= plan.frames) break;
    }
    return;
  }
  const grab = new VideoElementGrabber(file, plan);
  try {
    for (let k = 0; k < plan.frames; k++) {
      if (signal?.aborted) return;
      yield { index: k, time: plan.start + k / plan.fps, canvas: await grab.get(k) };
    }
  } finally { grab.dispose(); }
}

class VideoElementGrabber {
  constructor(file, plan) {
    this.plan = plan; this.url = URL.createObjectURL(file); this.v = videoEl(this.url);
    this.c = document.createElement('canvas'); this.c.width = plan.width; this.c.height = plan.height;
    this.ctx = this.c.getContext('2d', { willReadFrequently: true }); this.ready = once(this.v, 'loadeddata');
  }
  async get(k) {
    await this.ready;
    const t = this.plan.start + k / this.plan.fps + 0.25 / this.plan.fps;
    if (Math.abs(this.v.currentTime - t) > 1e-3) { const p = once(this.v, 'seeked'); this.v.currentTime = t; await p; }
    this.ctx.drawImage(this.v, 0, 0, this.c.width, this.c.height);
    return this.c;
  }
  dispose() { try { this.v.removeAttribute('src'); this.v.load(); } catch {} URL.revokeObjectURL(this.url); }
}

/** Random-access frame grabber for editor scrubbing. Returns a canvas copy owned by caller. */
export class FrameGrabber {
  constructor(file, meta, plan) { this.file = file; this.meta = meta; this.plan = plan; this.cache = new Map(); this.busy = Promise.resolve(); }
  async init() {
    if (this.meta.engine === 'image') { this.cache.set(0, await imageToCanvas(this.file, this.plan.width, this.plan.height)); this.photo = true; return this; }
    const mb = this.meta.engine === 'mediabunny' ? await mediabunny() : null;
    if (mb) {
      const input = new mb.Input({ source: new mb.BlobSource(this.file), formats: mb.ALL_FORMATS });
      this.sink = new mb.CanvasSink(await input.getPrimaryVideoTrack(), { width: this.plan.width, height: this.plan.height, fit: 'fill', poolSize: 0 });
    } else this.vg = new VideoElementGrabber(this.file, this.plan);
    return this;
  }
  get(k) {
    k = Math.max(0, Math.min(this.plan.frames - 1, k | 0));
    if (this.cache.has(k)) return Promise.resolve(this.cache.get(k));
    const job = this.busy.then(async () => {
      if (this.cache.has(k)) return this.cache.get(k);
      const t = this.plan.start + k / this.plan.fps + 0.25 / this.plan.fps;
      let src;
      if (this.sink) { const wc = await this.sink.getCanvas(t); src = wc?.canvas; } else src = await this.vg.get(k);
      const c = document.createElement('canvas'); c.width = this.plan.width; c.height = this.plan.height;
      if (src) c.getContext('2d').drawImage(src, 0, 0);
      this.cache.set(k, c);
      if (this.cache.size > 24 && !this.photo) this.cache.delete(this.cache.keys().next().value);
      return c;
    });
    this.busy = job.catch(() => {});
    return job;
  }
  dispose() { this.cache.clear(); this.vg?.dispose(); }
}

/** Codec support report for the capability test & export options. */
export async function codecSupport() {
  const out = { videoEncoder: typeof VideoEncoder !== 'undefined', videoDecoder: typeof VideoDecoder !== 'undefined', audioEncoder: typeof AudioEncoder !== 'undefined', encode: {}, decode: {}, mediaRecorder: [] };
  const cfgs = { 'H.264 (avc1.42001f)': 'avc1.42001f', 'H.264 High (avc1.640028)': 'avc1.640028', 'HEVC (hvc1.1.6.L93.B0)': 'hvc1.1.6.L93.B0', 'VP9': 'vp09.00.10.08', 'AV1': 'av01.0.04M.08' };
  for (const [name, codec] of Object.entries(cfgs)) {
    try { out.encode[name] = out.videoEncoder ? !!(await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 4e6, framerate: 30 })).supported : false; } catch { out.encode[name] = false; }
    try { out.decode[name] = out.videoDecoder ? !!(await VideoDecoder.isConfigSupported({ codec })).supported : false; } catch { out.decode[name] = false; }
  }
  for (const [name, codec] of Object.entries({ 'AAC': 'mp4a.40.2', 'Opus': 'opus' })) {
    try { out.encode[name] = out.audioEncoder ? !!(await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported : false; } catch { out.encode[name] = false; }
  }
  if (typeof MediaRecorder !== 'undefined') for (const t of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']) if (MediaRecorder.isTypeSupported?.(t)) out.mediaRecorder.push(t);
  return out;
}

/** MP4 writer. Mediabunny when available, else MediaRecorder (real-time paced). */
export class VideoWriter {
  constructor(canvas, plan) { this.canvas = canvas; this.plan = plan; this.mode = null; this.notes = []; }
  async start({ audioFile, meta, includeAudio = true } = {}) {
    const mb = await mediabunny();
    if (mb) {
      const codecs = ['avc', 'hevc', 'vp9'];
      let vcodec = null;
      for (const c of codecs) { try { if (await mb.canEncodeVideo(c, { width: this.plan.width, height: this.plan.height })) { vcodec = c; break; } } catch {} }
      if (vcodec) {
        this.mb = mb; this.mode = 'mediabunny'; this.vcodec = vcodec;
        this.target = new mb.BufferTarget();
        this.output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: this.target });
        this.vsrc = new mb.CanvasSource(this.canvas, { codec: vcodec, bitrate: mb.QUALITY_HIGH });
        this.output.addVideoTrack(this.vsrc, { frameRate: this.plan.fps });
        if (includeAudio && meta?.audio?.length) await this._setupAudio(audioFile);
        await this.output.start();
        if (this._pendingAudio) await this._pendingAudio();
        if (vcodec !== 'avc') this.notes.push(`H.264 encoding unsupported here; using ${vcodec.toUpperCase()} in MP4.`);
        return;
      }
      this.notes.push('No supported WebCodecs video encoder; using MediaRecorder fallback.');
    }
    this.mode = 'recorder';
    this.frames = [];
    this.notes.push('MediaRecorder fallback: frames are buffered then replayed in real time; audio is not included.');
  }
  async _setupAudio(file) {
    const mb = this.mb;
    let acodec = null;
    for (const c of ['aac', 'opus']) { try { if (await mb.canEncodeAudio(c)) { acodec = c; break; } } catch {} }
    if (!acodec) { this.notes.push('This browser cannot encode AAC/Opus audio: export will be silent.'); return; }
    try {
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const at = await input.getPrimaryAudioTrack();
      if (!at || !(await at.canDecode())) { this.notes.push('Source audio cannot be decoded here: export will be silent.'); return; }
      const asrc = new mb.AudioBufferSource({ codec: acodec, bitrate: mb.QUALITY_MEDIUM });
      this.output.addAudioTrack(asrc);
      const { start, end } = this.plan, total = end - start;
      this._pendingAudio = async () => {
        const sink = new mb.AudioBufferSink(at);
        let written = 0;
        for await (const { buffer, timestamp } of sink.buffers(start, end)) {
          const skip = Math.max(0, Math.round((start - timestamp) * buffer.sampleRate));
          const remain = Math.round((total - written) * buffer.sampleRate);
          const len = Math.min(buffer.length - skip, remain);
          if (len <= 0) { if (remain <= 0) break; continue; }
          const ab = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
          for (let c = 0; c < buffer.numberOfChannels; c++) ab.copyToChannel(buffer.getChannelData(c).subarray(skip, skip + len), c);
          await asrc.add(ab);
          written += len / buffer.sampleRate;
        }
        asrc.close();
        this.audioSeconds = written;
      };
      this.notes.push(`Original audio kept (${acodec.toUpperCase()}).`);
    } catch (e) { this.notes.push('Audio could not be prepared: ' + (e?.message || e) + '. Export will be silent.'); this._pendingAudio = null; }
  }
  async addFrame(index) {
    if (this.mode === 'mediabunny') { await this.vsrc.add(index / this.plan.fps, 1 / this.plan.fps); return; }
    this.frames.push(await createImageBitmap(this.canvas));
  }
  async finish(onProgress) {
    if (this.mode === 'mediabunny') {
      this.vsrc.close();
      await this.output.finalize();
      return { blob: new Blob([this.target.buffer], { type: 'video/mp4' }), mime: 'video/mp4', ext: 'mp4', codec: this.vcodec };
    }
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm'];
    const mime = types.find(t => MediaRecorder.isTypeSupported?.(t));
    if (!mime) throw new Error('This browser has neither WebCodecs encoding nor MediaRecorder; video export is unavailable.');
    const c = document.createElement('canvas'); c.width = this.plan.width; c.height = this.plan.height;
    const ctx = c.getContext('2d'); const stream = c.captureStream(this.plan.fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 }); const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => (rec.onstop = r));
    rec.start(); const t0 = performance.now();
    for (let i = 0; i < this.frames.length; i++) {
      const due = t0 + (i * 1000) / this.plan.fps; const wait = due - performance.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      ctx.drawImage(this.frames[i], 0, 0); this.frames[i].close?.(); onProgress?.(i + 1, this.frames.length);
    }
    await new Promise(r => setTimeout(r, 1000 / this.plan.fps + 50));
    rec.stop(); await done;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    return { blob: new Blob(chunks, { type: mime.split(';')[0] }), mime, ext, codec: 'MediaRecorder' };
  }
  async cancel() { try { if (this.mode === 'mediabunny') await this.output.cancel(); } catch {} this.frames?.forEach(f => f.close?.()); }
}

/** Reopen an exported file and compare sampled frames with the source to prove modification. */
export async function verifyExport(blob, srcFile, meta, plan, sampleFrames, regionsFor) {
  const res = { ok: false, details: [], duration: null, frames: null };
  const mb = await mediabunny();
  const outMeta = await probe(new File([blob], 'export.mp4', { type: blob.type }));
  res.duration = outMeta.duration; res.size = `${outMeta.width}×${outMeta.height}`; res.audio = outMeta.audio.length;
  const outPlan = { ...plan, start: 0, end: outMeta.duration };
  const g1 = await new FrameGrabber(new File([blob], 'export.mp4', { type: blob.type }), outMeta, outPlan).init();
  const g2 = await new FrameGrabber(srcFile, meta, plan).init();
  try {
    for (const k of sampleFrames) {
      const a = await g1.get(k), b = await g2.get(k);
      const reg = regionsFor(k);
      const diff = (r) => {
        const x = Math.max(0, r[0] | 0), y = Math.max(0, r[1] | 0), w = Math.max(1, Math.min(plan.width - x, (r[2] - r[0]) | 0)), h = Math.max(1, Math.min(plan.height - y, (r[3] - r[1]) | 0));
        const da = a.getContext('2d').getImageData(x, y, w, h).data, db2 = b.getContext('2d').getImageData(x, y, w, h).data;
        let s = 0; for (let i = 0; i < da.length; i += 4) s += Math.abs(da[i] - db2[i]) + Math.abs(da[i + 1] - db2[i + 1]) + Math.abs(da[i + 2] - db2[i + 2]);
        return s / (da.length / 4) / 3;
      };
      const inside = reg ? diff(reg) : null;
      const whole = diff([0, 0, plan.width, plan.height]);
      res.details.push({ frame: k, inside, whole });
    }
  } finally { g1.dispose(); g2.dispose(); }
  const withReg = res.details.filter(d => d.inside !== null);
  res.ok = withReg.length > 0 && withReg.some(d => d.inside > 6);
  res.engine = mb ? 'mediabunny' : 'video-element';
  return res;
}
