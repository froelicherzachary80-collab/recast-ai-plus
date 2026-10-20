// RECAST AI+ v0.5 — Edit Studio: TikTok-style transition edits from your recasts.
// Clips (recast exports, posters, any video/photo) are cut to the beat of a song, with flash / black /
// zoom-punch / whip / shake / glitch / crossfade transitions, zoom-on-beat, captions, grade and grain,
// then exported as a 9:16 MP4 with the music (and optional dialogue from the clips).
import { h, toast, confirmBox, slider, check, seg, chip, progressBar, fileButton, downloadBlob, shareFile } from './ui.js';
import { db, uid } from './db.js';
import { probe, FrameGrabber, VideoWriter, iterateFrames, mediabunny, isImageFile } from './media.js';
import { fitSize, clamp } from './geometry.js';
import { blobToCanvas } from './profile.js';
import { analyzeBeats } from './beats.js';
import { TRANSITIONS, buildAutoEdit, frameAt, beatPulse, resizeSegment, editLength } from './edit.js';
import { GRADES, gradeCanvas, vignette, letterbox } from './fx.js';
import { audioCtx, extractSceneAudio, toMono } from './dub.js';

const ASPECTS = { '9x16': [1080, 1920, '9:16'], '4x5': [1080, 1350, '4:5'], '1x1': [1080, 1080, '1:1'], '16x9': [1920, 1080, '16:9'] };
const CAPTION_STYLES = { sub: 'Subtitle (small, lowercase)', bold: 'Big title', type: 'Typewriter' };
const COLORS = ['#8d5cff', '#4fd1a1', '#f2b84b', '#5ec8ff', '#ff8fb1', '#c3e86b', '#ff9f5a', '#9aa7ff'];
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const sec = (title, open, ...kids) => h('details', { class: 'panel', open }, h('summary', null, h('h2', null, title)), ...kids);
const note = (t, kind = '') => h('div', { class: 'note ' + kind }, t);
const ease = p => 1 - Math.pow(1 - p, 3);
const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

let noiseC = null;
function noise() {
  if (noiseC) return noiseC;
  noiseC = mk(256, 256); const c = noiseC.getContext('2d'), d = c.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  c.putImageData(d, 0, 0); return noiseC;
}

/** Draw `img` to cover W×H with focus point, zoom and offset. */
function drawCover(ctx, img, W, H, fx = 0.5, fy = 0.5, z = 1, dx = 0, dy = 0) {
  const iw = img.width, ih = img.height, s = Math.max(W / iw, H / ih) * z, w = iw * s, hh = ih * s;
  const x = clamp((W - w) * fx, W - w, 0) + dx, y = clamp((H - hh) * fy, H - hh, 0) + dy;
  ctx.drawImage(img, x, y, w, hh);
}

export async function editStudio({ setTop, onCleanup }) {
  setTop('Edit Studio', null);
  const KEY = 'edit:v1';
  let st = await db.get('kv', KEY).catch(() => null);
  if (!st) st = { id: KEY, aspect: '9x16', clips: [], music: null, bpm: 100, every: 1, style: 'auto', speed: 1, length: 15, segs: [], captions: [], look: { grade: 'none', amount: 0.8, grain: 0.04, vignette: 0.2, pulse: true, bars: false }, clipVol: 0, musicVol: 1, label: true };
  const save = () => db.put('kv', st).catch(() => {});
  let W = ASPECTS[st.aspect][0], H = ASPECTS[st.aspect][1];
  const PW = Math.round(W / 3), PH = Math.round(H / 3); // preview size
  let pw = PW, ph = PH;
  const view = mk(pw, ph); view.style.cssText = 'width:100%;height:auto;display:block';
  const tmp = mk(pw, ph);
  let t = 0, selSeg = null, draft = null, playing = false, music = null, playSrc = null;

  // ── clip cache
  const cache = new Map();
  const openClip = async c => {
    if (cache.has(c.id)) return cache.get(c.id);
    const rec = await db.get('renders', c.key); if (!rec?.blob) throw new Error(`“${c.name}” is no longer on this device.`);
    const file = new File([rec.blob], c.name || 'clip', { type: rec.blob.type });
    const o = { file };
    if (c.kind === 'image') o.img = await blobToCanvas(rec.blob, 2400);
    else {
      o.meta = await probe(file);
      const size = fitSize(o.meta.width, o.meta.height, 480);
      o.plan = { start: 0, end: o.meta.duration, fps: 15, frames: Math.max(1, Math.floor(o.meta.duration * 15)), width: size.width, height: size.height };
      o.g = await new FrameGrabber(file, o.meta, o.plan).init();
    }
    cache.set(c.id, o); return o;
  };
  const clipOf = s => st.clips.find(c => c.id === s.clipId);
  const previewSrc = async (s, src) => { const c = clipOf(s); if (!c) return null; const o = await openClip(c); return o.img || o.g.get(Math.floor(clamp(src, 0, c.dur - 0.01) * 15)); };
  const beats = () => st.music?.beats?.length ? st.music.beats : Array.from({ length: Math.ceil((st.length + 4) * st.bpm / 60) }, (_, i) => i * 60 / st.bpm);
  const musicStart = () => (st.music ? st.music.start : 0);

  /** Render output time `time` into ctx (W×H). getSrc(seg, srcTime) → canvas; getPrev(i) → previous segment's last frame. */
  const renderAt = async (ctx, Wd, Hd, time, getSrc, getPrev) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, Wd, Hd);
    const f = frameAt(st.segs, time); if (!f) return;
    const c = clipOf(f.seg), img = await getSrc(f.seg, f.src); if (!img || !c) return;
    const dur = f.seg.t1 - f.seg.t0, p = f.trans, type = f.seg.trans.type;
    let z = 1 + (st.look.pulse ? 0.035 * beatPulse(beats(), musicStart(), time) : 0);
    if (c.kind === 'image') z *= 1 + 0.07 * (f.local / Math.max(0.1, dur));
    let dx = 0, dy = 0;
    if (p !== null && type === 'zoom') z *= 1 + 0.25 * (1 - ease(p));
    if (p !== null && type === 'shake') { const a = Wd * 0.035 * (1 - p); dx = (Math.random() - 0.5) * a * 2; dy = (Math.random() - 0.5) * a * 2; z *= 1.06; }
    if (p !== null && (type === 'slide' || type === 'fade')) {
      const prev = await getPrev(f.i), pc = st.segs[f.i - 1] && clipOf(st.segs[f.i - 1]);
      if (type === 'slide' && prev) {
        const e = ease(p), off = Wd * e;
        for (let k = 0; k < 3; k++) { ctx.globalAlpha = k ? 0.3 : 1; drawCover(ctx, prev, Wd, Hd, pc?.focusX ?? 0.5, pc?.focusY ?? 0.5, 1, -off - k * Wd * 0.04 * (1 - e), 0); }
        for (let k = 0; k < 3; k++) { ctx.globalAlpha = k ? 0.3 : 1; drawCover(ctx, img, Wd, Hd, c.focusX ?? 0.5, c.focusY ?? 0.5, z, Wd - off + k * Wd * 0.04 * (1 - e), 0); }
        ctx.globalAlpha = 1;
      } else if (type === 'fade' && prev) {
        drawCover(ctx, prev, Wd, Hd, pc?.focusX ?? 0.5, pc?.focusY ?? 0.5, 1); ctx.globalAlpha = p; drawCover(ctx, img, Wd, Hd, c.focusX ?? 0.5, c.focusY ?? 0.5, z); ctx.globalAlpha = 1;
      } else drawCover(ctx, img, Wd, Hd, c.focusX ?? 0.5, c.focusY ?? 0.5, z);
    } else {
      drawCover(ctx, img, Wd, Hd, c.focusX ?? 0.5, c.focusY ?? 0.5, z, dx, dy);
      if (p !== null && type === 'zoom') { ctx.globalAlpha = 0.35 * (1 - p); drawCover(ctx, img, Wd, Hd, c.focusX ?? 0.5, c.focusY ?? 0.5, z * 1.08); ctx.globalAlpha = 1; }
    }
    if (p !== null && type === 'glitch') {
      const k = 1 - p, n = 9;
      for (let i = 0; i < n; i++) { const y = Math.random() * Hd, hh = Hd * (0.02 + Math.random() * 0.06), off = (Math.random() - 0.5) * Wd * 0.12 * k; ctx.drawImage(ctx.canvas, 0, y, Wd, hh, off, y, Wd, hh); }
      ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.25 * k; ctx.fillStyle = '#00e5ff'; ctx.fillRect(Wd * 0.01 * k * 6, 0, Wd, Hd); ctx.fillStyle = '#ff2bd6'; ctx.fillRect(-Wd * 0.01 * k * 6, 0, Wd, Hd);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
    gradeCanvas(ctx, Wd, Hd, st.look.grade, st.look.amount);
    if (p !== null && type === 'flash') { ctx.fillStyle = `rgba(255,255,255,${(1 - p).toFixed(3)})`; ctx.fillRect(0, 0, Wd, Hd); }
    if (p !== null && type === 'dip') { ctx.fillStyle = `rgba(0,0,0,${(1 - ease(p)).toFixed(3)})`; ctx.fillRect(0, 0, Wd, Hd); }
    if (st.look.grain > 0) { ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = Math.min(1, st.look.grain * 4); const nz = noise(), ox = Math.random() * 256, oy = Math.random() * 256, sc = Math.max(1, Wd / 540); ctx.save(); ctx.translate(-ox, -oy); ctx.scale(sc, sc); ctx.fillStyle = ctx.createPattern(nz, 'repeat'); ctx.fillRect(0, 0, Wd / sc + 512, Hd / sc + 512); ctx.restore(); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
    vignette(ctx, Wd, Hd, st.look.vignette); letterbox(ctx, Wd, Hd, st.look.bars);
    for (const cap of st.captions) if (time >= cap.t0 && time < cap.t1) drawCaption(ctx, Wd, Hd, cap, time);
    if (st.label) { const fs = Math.round(Hd * 0.017), s = 'AI-edited · RECAST AI+'; ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`; const tw = ctx.measureText(s).width; ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(Wd - tw - fs * 1.9, fs * 1.2, tw + fs, fs * 1.5); ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.fillText(s, Wd - tw - fs * 1.4, fs * 1.4); }
  };
  const drawCaption = (ctx, Wd, Hd, cap, time) => {
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = Hd * 0.008;
    let text = cap.text || '';
    if (cap.style === 'type') { const n = Math.ceil(text.length * clamp((time - cap.t0) / 0.5, 0, 1)); text = text.slice(0, n); }
    if (cap.style === 'bold') { const fs = Hd * 0.07; ctx.font = `${fs}px "Anton", Impact, sans-serif`; text = text.toUpperCase(); let s = fs; while (ctx.measureText(text).width > Wd * 0.9 && s > 10) { s *= 0.94; ctx.font = `${s}px "Anton", Impact, sans-serif`; } ctx.fillText(text, Wd / 2, Hd * 0.5); }
    else { const fs = Hd * 0.024; ctx.font = `500 ${fs}px "IBM Plex Sans", -apple-system, sans-serif`; text = cap.style === 'sub' ? text.toLowerCase() : text; const words = text.split(' '), lines = [''];
      for (const w of words) { const tryL = (lines[lines.length - 1] + ' ' + w).trim(); if (ctx.measureText(tryL).width > Wd * 0.8 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = tryL; }
      ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.14; ctx.strokeStyle = 'rgba(0,0,0,.55)';
      lines.forEach((l, i) => { const y = Hd * 0.62 + (i - (lines.length - 1) / 2) * fs * 1.3; ctx.strokeText(l, Wd / 2, y); ctx.fillText(l, Wd / 2, y); }); }
    ctx.restore();
  };

  // ── preview
  const paint = async () => {
    if (!st.segs.length) { const c = view.getContext('2d'); c.fillStyle = '#0b0a0f'; c.fillRect(0, 0, pw, ph); c.fillStyle = '#6f6980'; c.font = `600 ${Math.round(pw / 22)}px "IBM Plex Mono", monospace`; c.textAlign = 'center'; c.fillText('Add clips + music,', pw / 2, ph / 2 - pw / 18); c.fillText('then Auto-edit', pw / 2, ph / 2 + pw / 30); return; }
    try { await renderAt(view.getContext('2d', { willReadFrequently: true }), pw, ph, t, previewSrc, async i => { const s = st.segs[i - 1]; return s ? previewSrc(s, s.src + (s.t1 - s.t0) * s.speed - 0.05) : null; }); }
    catch (e) { toast(e.message, true); }
    tlDraw(); tLbl.textContent = `${fmtT(t)} / ${fmtT(editLength(st.segs))}`;
  };
  const tLbl = h('span', { class: 'mono small muted' });
  const playBtn = h('button', { class: 'btn sm', onclick: () => play() }, '▶ Preview');
  const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: 1000, value: 0, 'aria-label': 'Playhead', oninput: e => { t = e.target.value / 1000 * editLength(st.segs); stopPlay(); paint(); } });

  /** Mixed soundtrack (music + clip dialogue) for [0, L]. */
  const mixAudio = async L => {
    const sr = 48000, len = Math.max(1, Math.round(L * sr)), oc = new OfflineAudioContext(2, len, sr);
    let any = false;
    if (st.music) { const buf = await musicBuffer(); if (buf) { const s = oc.createBufferSource(); s.buffer = buf; const g = oc.createGain(); g.gain.value = st.musicVol; s.connect(g); g.connect(oc.destination); s.start(0, st.music.start); any = true; } }
    if (st.clipVol > 0) for (const s of st.segs) {
      const c = clipOf(s); if (!c || c.kind === 'image') continue;
      const o = await openClip(c); if (!o.meta.audio?.length) continue;
      if (!o.audio) { try { o.audio = await extractSceneAudio(o.file, { start: 0, end: o.meta.duration }, mediabunny); } catch { o.audio = null; } }
      if (!o.audio) continue;
      const src = oc.createBufferSource(); src.buffer = o.audio; src.playbackRate.value = s.speed;
      const g = oc.createGain(), d = s.t1 - s.t0; g.gain.setValueAtTime(0, s.t0); g.gain.linearRampToValueAtTime(st.clipVol, s.t0 + 0.02); g.gain.setValueAtTime(st.clipVol, Math.max(s.t0 + 0.02, s.t1 - 0.02)); g.gain.linearRampToValueAtTime(0, s.t1);
      src.connect(g); g.connect(oc.destination); src.start(s.t0, s.src, d * s.speed + 0.02); any = true;
    }
    return any ? oc.startRendering() : null;
  };
  const musicBuffer = async () => {
    if (music) return music;
    const rec = await db.get('renders', 'editmusic'); if (!rec?.blob) return null;
    music = await audioCtx().decodeAudioData(await rec.blob.arrayBuffer()); return music;
  };

  const stopPlay = () => { playing = false; try { playSrc?.stop(); } catch {} playSrc = null; };
  const play = async () => {
    if (playing) { stopPlay(); playBtn.textContent = '▶ Preview'; return; }
    if (!st.segs.length) return;
    const L = editLength(st.segs), fps = 15, N = Math.ceil(L * fps);
    if (!draft || draft.key !== draftKey()) {
      const bar = progressBar(), msg = h('p', { class: 'small muted mono' }, 'Rendering preview…');
      previewBox.replaceChildren(bar, msg);
      const frames = [], c = mk(pw, ph), ctx = c.getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < N; i++) {
        const tt = i / fps; await renderAt(ctx, pw, ph, tt, previewSrc, async k => { const s = st.segs[k - 1]; return s ? previewSrc(s, s.src + (s.t1 - s.t0) * s.speed - 0.05) : null; });
        frames.push(await createImageBitmap(c)); bar.set((i + 1) / N); msg.textContent = `Preview frame ${i + 1}/${N}`;
        if (i % 4 === 0) await new Promise(r => setTimeout(r, 0));
      }
      draft = { key: draftKey(), frames, audio: await mixAudio(L).catch(() => null) };
      previewBox.replaceChildren();
    }
    playing = true; playBtn.textContent = '❚❚ Pause';
    const ac = audioCtx(); await ac.resume();
    const start = Math.min(t, L - 0.05), t0 = ac.currentTime - start;
    if (draft.audio) { playSrc = ac.createBufferSource(); playSrc.buffer = draft.audio; playSrc.connect(ac.destination); playSrc.start(0, start); }
    const ctx = view.getContext('2d');
    while (playing) {
      t = ac.currentTime - t0; if (t >= L) { t = L; break; }
      ctx.drawImage(draft.frames[Math.min(draft.frames.length - 1, Math.floor(t * fps))], 0, 0, pw, ph);
      tLbl.textContent = `${fmtT(t)} / ${fmtT(L)}`; scrub.value = t / L * 1000; tlDraw();
      await new Promise(r => requestAnimationFrame(r));
    }
    stopPlay(); playBtn.textContent = '▶ Preview'; paint();
  };
  const draftKey = () => JSON.stringify([st.segs, st.captions, st.look, st.clips.map(c => [c.id, c.focusX, c.focusY]), st.music?.start, st.clipVol, st.musicVol, st.label, st.aspect]);
  const previewBox = h('div', { class: 'stack' });

  // ── timeline
  const tl = mk(900, 70); tl.className = 'timeline';
  const tlDraw = () => {
    const c = tl.getContext('2d'), L = editLength(st.segs) || st.length; c.clearRect(0, 0, 900, 70);
    const X = v => 6 + v / L * 888;
    c.strokeStyle = 'rgba(255,255,255,.18)'; for (const b of beats()) { const x = X(b - musicStart()); if (x < 6 || x > 894) continue; c.beginPath(); c.moveTo(x, 2); c.lineTo(x, 10); c.stroke(); }
    st.segs.forEach((s, i) => {
      const ci = st.clips.findIndex(c2 => c2.id === s.clipId), x0 = X(s.t0), x1 = X(s.t1);
      c.fillStyle = COLORS[(ci < 0 ? 0 : ci) % COLORS.length] + (s.id === selSeg ? 'ff' : '99'); c.fillRect(x0 + 0.5, 14, Math.max(1, x1 - x0 - 1), 30);
      if (s.trans.type !== 'cut') { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(x0, 14); c.lineTo(x0 + 7, 14); c.lineTo(x0, 22); c.fill(); }
      if (s.speed !== 1) { c.fillStyle = '#0b0a0f'; c.font = '600 10px "IBM Plex Mono", monospace'; c.fillText(`${s.speed}×`, x0 + 3, 40); }
    });
    c.fillStyle = 'rgba(242,184,75,.8)'; for (const cap of st.captions) c.fillRect(X(cap.t0), 50, Math.max(2, X(cap.t1) - X(cap.t0)), 8);
    c.fillStyle = '#b597ff'; c.fillRect(X(t) - 1, 0, 3, 70);
  };
  tl.addEventListener('pointerdown', ev => {
    const r = tl.getBoundingClientRect(), L = editLength(st.segs) || 1, x = (ev.clientX - r.left) / r.width * 900, tt = clamp((x - 6) / 888 * L, 0, L);
    t = tt; const f = frameAt(st.segs, tt); selSeg = f?.seg.id || null; stopPlay(); drawPanels(); paint();
  });

  // ── actions
  const addClip = async (blob, name, source, key) => {
    const kind = isImageFile({ type: blob.type, name }) ? 'image' : 'video';
    let dur = Infinity, w = 0, hh = 0;
    if (kind === 'video') { const m = await probe(new File([blob], name, { type: blob.type })); dur = m.duration; w = m.width; hh = m.height; }
    else { const c = await blobToCanvas(blob, 800); w = c.width; hh = c.height; }
    const c = { id: uid('c'), name, kind, dur, w, h: hh, source, key, focusX: 0.5, focusY: 0.35, inPoint: 0 };
    st.clips.push(c); save(); return c;
  };
  const autoEdit = () => {
    if (!st.clips.length) { toast('Add at least one clip first.', true); return; }
    const L = st.music ? Math.min(st.length, Math.max(1, st.music.duration - st.music.start)) : st.length;
    st.segs = buildAutoEdit({ clips: st.clips.map(c => ({ id: c.id, dur: c.kind === 'image' ? Infinity : c.dur, inPoint: c.inPoint || 0, kind: c.kind })), beats: beats(), strong: st.music?.strong || [], musicStart: musicStart(), length: L, every: st.every, style: st.style, speed: st.speed });
    selSeg = null; t = 0; save(); drawPanels(); paint();
    toast(`${st.segs.length} cuts on the beat${st.music ? ` (${st.music.bpm.toFixed(0)} BPM)` : ''}`);
  };
  const doExport = async () => {
    if (!st.segs.length) { toast('Auto-edit first.', true); return; }
    stopPlay();
    const L = editLength(st.segs), fps = 30, N = Math.round(L * fps), ctrl = new AbortController(), bar = progressBar(), msg = h('p', { class: 'small muted mono' }, 'Mixing audio…');
    exportBox.replaceChildren(h('section', { class: 'panel' }, h('h2', null, 'Exporting edit…'), bar, msg, h('button', { class: 'btn sm', onclick: () => ctrl.abort() }, 'Cancel')));
    try {
      const out = mk(W, H), ctx = out.getContext('2d', { willReadFrequently: true });
      const audioBuffer = await mixAudio(L).catch(e => { toast('Audio mix failed: ' + e.message, true); return null; });
      const plan = { width: W, height: H, fps, frames: N, start: 0, end: L };
      const w = new VideoWriter(out, plan); await w.start({ audioBuffer, includeAudio: !!audioBuffer });
      let frame = 0, held = null;
      for (let si = 0; si < st.segs.length; si++) {
        const s = st.segs[si], c = clipOf(s), o = await openClip(c), segFrames = Math.max(0, Math.round(s.t1 * fps) - Math.round(s.t0 * fps));
        let it = null, cur = null, lastSrcCopy = null;
        if (c.kind === 'video') {
          const size = fitSize(o.meta.width, o.meta.height, Math.max(W, H));
          it = iterateFrames(o.file, o.meta, { start: s.src, end: Math.min(o.meta.duration, s.src + (s.t1 - s.t0) * s.speed + 0.2), fps: fps / s.speed, frames: segFrames, width: size.width, height: size.height }, { signal: ctrl.signal });
        }
        for (let k = 0; k < segFrames; k++) {
          if (ctrl.signal.aborted) { await w.cancel(); throw new Error('Cancelled'); }
          if (it) { const n = await it.next(); if (!n.done) cur = n.value.canvas; }
          const src = c.kind === 'image' ? o.img : cur;
          await renderAt(ctx, W, H, (frame + 0.001) / fps, async () => src, async () => held);
          await w.addFrame(frame); frame++;
          if (k === segFrames - 1 && src) { lastSrcCopy = mk(src.width, src.height); lastSrcCopy.getContext('2d').drawImage(src, 0, 0); }
          bar.set(frame / N); msg.textContent = `Frame ${frame}/${N}`;
          if (frame % 3 === 0) await new Promise(r => setTimeout(r, 0));
        }
        await it?.return?.();
        held = lastSrcCopy || held;
      }
      msg.textContent = 'Finalizing…';
      const res = await w.finish(), name = `RECAST_Edit_${new Date().toISOString().slice(0, 10)}${st.label ? '_AI-edited' : ''}.${res.ext}`;
      (w.notes || []).forEach(n => toast(n));
      const url = URL.createObjectURL(res.blob);
      exportBox.replaceChildren(h('section', { class: 'panel' }, h('div', { class: 'row between' }, h('h2', null, 'Edit ready'), chip(`${(res.blob.size / 1048576).toFixed(1)} MB · ${L.toFixed(1)} s`, 'ok')),
        h('video', { src: url, controls: true, playsInline: true, style: { maxHeight: '60vh', margin: '0 auto', borderRadius: '12px' } }),
        h('p', { class: 'small muted mono' }, name),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { if (!(await shareFile(res.blob, name, res.mime))) downloadBlob(res.blob, name); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); } } }, 'Save / Share'), h('button', { class: 'btn', onclick: () => downloadBlob(res.blob, name) }, 'Download')),
        h('p', { class: 'muted small' }, 'Post only edits of footage you have the right to use, and keep the AI-edited label on.')));
    } catch (e) { exportBox.replaceChildren(note(e.message === 'Cancelled' ? 'Export cancelled.' : 'Export failed: ' + e.message, e.message === 'Cancelled' ? 'warn' : 'bad')); }
  };

  // ── panels
  const panels = h('div', { class: 'stack' }), exportBox = h('div', { class: 'stack' });
  const projects = (await db.all('projects')).filter(p => p.export).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const drawPanels = () => {
    const S = st.segs.find(s => s.id === selSeg);
    panels.replaceChildren(
      sec(`Clips · ${st.clips.length}`, !st.clips.length,
        projects.length ? h('select', { 'aria-label': 'Add a recast', onchange: async e => { const p = projects.find(x => x.id === e.target.value); if (!p) return; const rec = await db.get('renders', 'out:' + p.id); if (!rec?.blob) { toast('That export is gone. Render it again.', true); return; } await addClip(rec.blob, p.export.name || p.name, 'project', 'out:' + p.id); drawPanels(); paint(); } }, h('option', { value: '' }, '+ Add one of my recasts'), projects.map(p => h('option', { value: p.id }, `${p.name}${p.plan?.photo ? ' (poster)' : ''}`))) : h('p', { class: 'muted small' }, 'Your exported recasts and posters will appear here.'),
        h('div', { class: 'row' }, fileButton('+ Import videos / photos', 'video/*,image/*', async files => { for (const f of files) { const key = 'editclip:' + uid('k'); await db.put('renders', { id: key, blob: f, name: f.name, at: Date.now() }); try { await addClip(f, f.name, 'import', key); } catch (e) { toast(`${f.name}: ${e.message}`, true); } } drawPanels(); paint(); }, { multiple: true, cls: 'btn sm' })),
        ...st.clips.map((c, i) => h('div', { class: 'stack', style: { borderTop: '1px solid var(--line)', paddingTop: '8px' } },
          h('div', { class: 'row between' }, h('span', { class: 'row' }, h('span', { style: { width: '12px', height: '12px', borderRadius: '3px', background: COLORS[i % COLORS.length], display: 'inline-block' } }), h('b', { class: 'small' }, c.name.slice(0, 34))), h('span', { class: 'small muted mono' }, c.kind === 'image' ? 'photo' : `${c.dur.toFixed(1)} s`)),
          slider('Frame focus ↔', c.focusX ?? 0.5, { min: 0, max: 1, step: 0.01, oninput: v => { c.focusX = v; save(); paint(); } }),
          slider('Frame focus ↕', c.focusY ?? 0.35, { min: 0, max: 1, step: 0.01, oninput: v => { c.focusY = v; save(); paint(); } }),
          c.kind === 'video' ? slider('Start from', c.inPoint || 0, { min: 0, max: Math.max(0, c.dur - 0.5), step: 0.05, fmt: v => `${(+v).toFixed(2)} s`, oninput: v => { c.inPoint = v; save(); } }) : null,
          h('div', { class: 'row' }, h('button', { class: 'btn sm ghost', disabled: i === 0, onclick: () => { st.clips.splice(i, 1); st.clips.splice(i - 1, 0, c); save(); drawPanels(); } }, '↑'), h('button', { class: 'btn sm ghost', disabled: i === st.clips.length - 1, onclick: () => { st.clips.splice(i, 1); st.clips.splice(i + 1, 0, c); save(); drawPanels(); } }, '↓'),
            h('button', { class: 'btn sm ghost danger', onclick: async () => { st.clips = st.clips.filter(x => x !== c); st.segs = st.segs.filter(s => s.clipId !== c.id); cache.get(c.id)?.g?.dispose(); cache.delete(c.id); if (c.source === 'import') await db.del('renders', c.key); save(); drawPanels(); paint(); } }, 'Remove'))))),
      sec('Music & beat', !st.segs.length,
        h('div', { class: 'row' }, fileButton(st.music ? 'Replace song' : '+ Add a song', 'audio/*,video/*', async f => {
          try {
            toast('Finding the beat…'); const buf = await audioCtx().decodeAudioData(await f.arrayBuffer());
            const mono = toMono([...Array(buf.numberOfChannels).keys()].map(c => buf.getChannelData(c)));
            const step = Math.max(1, Math.floor(buf.sampleRate / 22050)), small = new Float32Array(Math.floor(mono.length / step)); for (let i = 0; i < small.length; i++) small[i] = mono[i * step];
            const r = analyzeBeats(small, buf.sampleRate / step);
            await db.put('renders', { id: 'editmusic', blob: f, name: f.name, at: Date.now() }); music = buf;
            st.music = { name: f.name, duration: buf.duration, start: 0, bpm: r.bpm, beats: r.beats, strong: r.strong };
            save(); drawPanels(); toast(`${r.bpm.toFixed(0)} BPM · ${r.beats.length} beats`);
          } catch (e) { toast('Could not read that song: ' + e.message, true); }
        }, { cls: 'btn sm primary' }), st.music ? chip(`${st.music.bpm.toFixed(0)} BPM`, 'v') : null, st.music ? h('button', { class: 'btn sm ghost danger', onclick: async () => { st.music = null; music = null; await db.del('renders', 'editmusic'); save(); drawPanels(); } }, 'Remove') : null),
        st.music ? h('p', { class: 'small muted' }, st.music.name) : slider('Tempo (no song)', st.bpm, { min: 60, max: 180, step: 1, fmt: v => `${v} BPM`, oninput: v => { st.bpm = v; save(); } }),
        st.music ? slider('Song starts at', st.music.start, { min: 0, max: Math.max(0, st.music.duration - 3), step: 0.05, fmt: v => fmtT(+v), oninput: v => { st.music.start = v; save(); } }) : null,
        slider('Edit length', st.length, { min: 3, max: 60, step: 0.5, fmt: v => `${(+v).toFixed(1)} s`, oninput: v => { st.length = v; save(); } }),
        h('label', { class: 'f' }, 'Cut every', seg([['0.5', '½ beat'], ['1', '1 beat'], ['2', '2 beats'], ['4', '4 beats']], String(st.every), v => { st.every = +v; save(); })),
        h('label', { class: 'f' }, 'Transitions', h('select', { onchange: e => { st.style = e.target.value; save(); } }, h('option', { value: 'auto', selected: st.style === 'auto' }, 'Auto mix (cuts + flashes on accents)'), Object.entries(TRANSITIONS).map(([k, v]) => h('option', { value: k, selected: st.style === k }, `All: ${v.name}`)))),
        slider('Speed', st.speed, { min: 0.5, max: 2, step: 0.05, fmt: v => `${(+v).toFixed(2)}×`, oninput: v => { st.speed = v; save(); } }),
        h('button', { class: 'btn primary block', onclick: autoEdit }, '✦ Auto-edit to the beat')),
      st.segs.length ? sec(S ? `Cut ${st.segs.indexOf(S) + 1} of ${st.segs.length}` : 'Cuts', !!S,
        S ? h('div', { class: 'stack' },
          h('label', { class: 'f' }, 'Clip', h('select', { onchange: e => { S.clipId = e.target.value; S.src = st.clips.find(c => c.id === S.clipId)?.inPoint || 0; save(); paint(); } }, st.clips.map(c => h('option', { value: c.id, selected: c.id === S.clipId }, c.name.slice(0, 40))))),
          clipOf(S)?.kind === 'video' ? slider('Clip time', S.src, { min: 0, max: Math.max(0, clipOf(S).dur - (S.t1 - S.t0) * S.speed), step: 0.02, fmt: v => `${(+v).toFixed(2)} s`, oninput: v => { S.src = v; save(); paint(); } }) : null,
          slider('Length', S.t1 - S.t0, { min: 0.1, max: 6, step: 0.05, fmt: v => `${(+v).toFixed(2)} s`, oninput: v => { resizeSegment(st.segs, st.segs.indexOf(S), v); save(); tlDraw(); } }),
          slider('Speed', S.speed, { min: 0.25, max: 3, step: 0.05, fmt: v => `${(+v).toFixed(2)}×`, oninput: v => { S.speed = v; save(); paint(); } }),
          h('label', { class: 'f' }, 'Transition into this cut', h('select', { onchange: e => { S.trans = { type: e.target.value, dur: TRANSITIONS[e.target.value].dur }; save(); paint(); } }, Object.entries(TRANSITIONS).map(([k, v]) => h('option', { value: k, selected: k === S.trans.type }, v.name)))),
          S.trans.type !== 'cut' ? slider('Transition time', S.trans.dur, { min: 0.04, max: 0.8, step: 0.01, fmt: v => `${(+v).toFixed(2)} s`, oninput: v => { S.trans.dur = v; save(); paint(); } }) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => { const f = frameAt(st.segs, t); if (!f || f.local < 0.1 || S.t1 - t < 0.1 || f.seg !== S) { toast('Move the playhead inside this cut first.', true); return; } const i = st.segs.indexOf(S), B = { ...S, id: uid('s'), t0: t, src: S.src + (t - S.t0) * S.speed, trans: { type: 'cut', dur: 0 } }; S.t1 = t; st.segs.splice(i + 1, 0, B); save(); drawPanels(); paint(); } }, 'Split at playhead'),
            h('button', { class: 'btn sm ghost danger', onclick: () => { const i = st.segs.indexOf(S), d = S.t1 - S.t0; st.segs.splice(i, 1); for (let k = i; k < st.segs.length; k++) { st.segs[k].t0 -= d; st.segs[k].t1 -= d; } selSeg = null; save(); drawPanels(); paint(); } }, 'Delete cut'))) : h('p', { class: 'muted small' }, 'Tap a block on the timeline to change its clip, timing, speed or transition.')) : null,
      sec(`Captions · ${st.captions.length}`, false,
        h('button', { class: 'btn sm', onclick: () => { st.captions.push({ id: uid('cap'), text: 'and you think…', t0: +t.toFixed(2), t1: +(t + 1.5).toFixed(2), style: 'sub' }); save(); drawPanels(); paint(); } }, '+ Caption at playhead'),
        ...st.captions.map(cap => h('div', { class: 'stack', style: { borderTop: '1px solid var(--line)', paddingTop: '8px' } },
          h('input', { type: 'text', id: 'cap-' + cap.id, value: cap.text, 'aria-label': 'Caption text', oninput: e => { cap.text = e.target.value; save(); paint(); } }),
          h('div', { class: 'row' },
            h('label', { class: 'small muted row' }, 'From', h('input', { type: 'number', step: 0.05, value: cap.t0, style: { width: '84px' }, onchange: e => { cap.t0 = Math.max(0, +e.target.value); save(); paint(); } })),
            h('label', { class: 'small muted row' }, 'To', h('input', { type: 'number', step: 0.05, value: cap.t1, style: { width: '84px' }, onchange: e => { cap.t1 = Math.max(cap.t0 + 0.1, +e.target.value); save(); paint(); } })),
            h('select', { 'aria-label': 'Caption style', style: { width: 'auto' }, onchange: e => { cap.style = e.target.value; save(); paint(); } }, Object.entries(CAPTION_STYLES).map(([k, v]) => h('option', { value: k, selected: k === cap.style }, v))),
            h('button', { class: 'btn sm ghost danger', onclick: () => { st.captions = st.captions.filter(x => x !== cap); save(); drawPanels(); paint(); } }, '×'))))),
      sec('Look & sound', false,
        h('label', { class: 'f' }, 'Format', seg(Object.entries(ASPECTS).map(([k, v]) => [k, v[2]]), st.aspect, v => { st.aspect = v; W = ASPECTS[v][0]; H = ASPECTS[v][1]; pw = Math.round(W / 3); ph = Math.round(H / 3); view.width = pw; view.height = ph; save(); paint(); })),
        h('label', { class: 'f' }, 'Colour grade', h('select', { onchange: e => { st.look.grade = e.target.value; save(); paint(); } }, Object.entries(GRADES).map(([k, g]) => h('option', { value: k, selected: k === st.look.grade }, g.name)))),
        slider('Grade strength', st.look.amount, { min: 0, max: 1, step: 0.05, oninput: v => { st.look.amount = v; save(); paint(); } }),
        slider('Film grain', st.look.grain, { min: 0, max: 0.2, step: 0.005, fmt: v => (+v).toFixed(3), oninput: v => { st.look.grain = v; save(); paint(); } }),
        slider('Vignette', st.look.vignette, { min: 0, max: 1, step: 0.05, oninput: v => { st.look.vignette = v; save(); paint(); } }),
        h('div', { class: 'row' }, check('Zoom on every beat', st.look.pulse, v => { st.look.pulse = v; save(); paint(); }), check('Cinema bars', st.look.bars, v => { st.look.bars = v; save(); paint(); }), check('“AI-edited” label', st.label, v => { st.label = v; save(); paint(); })),
        slider('Music volume', st.musicVol, { min: 0, max: 1.5, step: 0.05, oninput: v => { st.musicVol = v; save(); } }),
        slider('Clip sound / dialogue', st.clipVol, { min: 0, max: 1.5, step: 0.05, oninput: v => { st.clipVol = v; save(); } }),
        h('p', { class: 'muted small' }, 'Turn up clip sound to keep lines of dialogue under the song, like quote edits.')),
    );
    tlDraw();
  };

  await musicBuffer().catch(() => null);
  drawPanels(); paint();
  onCleanup?.(() => { stopPlay(); for (const o of cache.values()) o.g?.dispose(); draft?.frames.forEach(f => f.close?.()); });
  return [
    h('div', { class: 'row between' }, h('h1', null, 'Edit Studio'), chip('TikTok edits', 'v')),
    h('p', { class: 'muted small' }, 'Cut your recasts to the beat with flash, zoom and whip transitions, captions and a film look. Everything renders on this device.'),
    h('div', { class: 'editor' },
      h('div', { class: 'stack' },
        h('div', { class: 'monitor', style: { maxWidth: H > W ? '380px' : '100%', margin: '0 auto', width: '100%' } }, view),
        h('div', { class: 'row' }, playBtn, tLbl), scrub, tl, previewBox,
        h('section', { class: 'panel' }, h('h2', null, 'Export'), h('p', { class: 'muted small' }, `${ASPECTS[st.aspect][0]}×${ASPECTS[st.aspect][1]}, 30 fps MP4 with the song.`), h('button', { class: 'btn primary', onclick: doExport }, 'Export edit (MP4)')),
        exportBox),
      h('div', { class: 'stack side' }, panels)),
  ];
}
