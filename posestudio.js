// RECAST AI+ v0.3 — Pose Studio: your rigged body as an editable model.
// Pose it by dragging joints, save poses, build dances from keyframes or presets, learn a dance from
// any video, place yourself on a colour / photo / video background, and export PNG images or MP4 videos.
import { h, toast, confirmBox, slider, check, seg, chip, progressBar, fileButton, downloadBlob, shareFile } from './ui.js';
import { db, uid } from './db.js';
import { FaceRenderer } from './facerender.js';
import { buildRig, deformRig } from './puppet.js';
import { restInfo, fk, fromJoints, restPose, dragJoint, samplePose, mirrorPose, PRESETS, retargetFrames, HANDLES } from './poserig.js';
import { blobToCanvas } from './profile.js';
import { probe, makePlan, iterateFrames, FrameGrabber, VideoWriter, isImageFile } from './media.js';
import { getTask, nextTs, hasModel } from './models.js';
import { smoothSeries } from './smoothing.js';
import { audioCtx } from './dub.js';

const SIZES = { portrait: [1080, 1920, 'Portrait 9:16'], square: [1080, 1080, 'Square 1:1'], landscape: [1920, 1080, 'Landscape 16:9'] };
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const panel = (...k) => h('section', { class: 'panel' }, ...k);
const note = (t, kind = '') => h('div', { class: 'note ' + kind }, t);

/** Renderer for one character on a stage. */
class Stage {
  constructor(prof, W, H) {
    this.prof = prof; this.W = W; this.H = H;
    this.I = restInfo(prof.body.joints);
    this.rig = buildRig(prof.body.alpha, prof.body.w, prof.body.h, prof.body.joints);
    this.gl = new FaceRenderer(W, H); this.out = mk(W, H); this.bgC = mk(W, H);
  }
  async init() { this.tex = this.gl.texture('studio:' + this.prof.id, await blobToCanvas(this.prof.body.png, 4096)); return this; }
  resize(W, H) { this.W = W; this.H = H; this.gl.resize(W, H); for (const c of [this.out, this.bgC]) { c.width = W; c.height = H; } }
  /** Draw background (color / image / video frame, cover-fit) into bgC. */
  background(cfg, img) {
    const c = this.bgC.getContext('2d'), W = this.W, H = this.H;
    c.fillStyle = cfg.color || '#15131c'; c.fillRect(0, 0, W, H);
    if (img) { const s = Math.max(W / img.width, H / img.height); c.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s); }
    else if (!cfg.flat) { const g = c.createLinearGradient(0, H * 0.55, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)'); c.fillStyle = g; c.fillRect(0, 0, W, H); }
  }
  /** Compose pose on the current background → this.out. */
  compose(pose, { shadow = true, label = false } = {}) {
    const J = fk(pose, this.I), ctx = this.out.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(this.bgC, 0, 0);
    if (shadow) {
      const fy = Math.max(J.lAn[1], J.rAn[1]) + 0.04 * this.I.torso * pose.s, fx = (J.lAn[0] + J.rAn[0]) / 2, rw = Math.max(40, Math.abs(J.lSh[0] - J.rSh[0]) * 0.9 + 30);
      ctx.save(); ctx.translate(fx, fy); ctx.scale(1, 0.18); const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rw); g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rw, 0, 7); ctx.fill(); ctx.restore();
    }
    const pos = deformRig(this.rig, J);
    this.gl.render(this.out, [{ tex: this.tex, pos, uv: this.rig.uv, alpha: new Float32Array(this.rig.n).fill(1), gain: new Float32Array(this.rig.n * 3).fill(1), idx: this.rig.idx, opacity: 1, grain: 0.008, sat: 1, bias: 0.2 }]);
    ctx.drawImage(this.gl.canvas, 0, 0);
    if (label) { const fs = Math.round(this.H * 0.022), t = 'AI-edited · RECAST AI+'; ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`; const tw = ctx.measureText(t).width; ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(this.W - tw - fs * 1.9, this.H - fs * 2.6, tw + fs, fs * 1.5); ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.fillText(t, this.W - tw - fs * 1.4, this.H - fs * 2.4); }
    return { canvas: this.out, joints: J };
  }
  dispose() { this.gl.dispose(); }
}

/** Run pose detection over a dance video (or one photo) → per-frame landmark arrays in px. */
async function readDancer(file, onProgress, signal) {
  const key = (await hasModel('pose_full')) ? 'pose_full' : 'pose_lite';
  const meta = await probe(file), plan = makePlan(meta, { start: 0, end: Math.min(meta.duration, 30) }, meta.kind === 'photo' ? 'photo' : 'quality');
  const task = await getTask(key, meta.kind === 'photo' ? 'IMAGE' : 'VIDEO', { num: 2 });
  const frames = new Array(plan.frames).fill(null);
  for await (const { index, canvas } of iterateFrames(file, meta, plan, { signal })) {
    if (signal?.aborted) throw new Error('Cancelled');
    const r = meta.kind === 'photo' ? task.detect(canvas) : task.detectForVideo(canvas, nextTs());
    let best = null, bs = 0;
    for (const lm of r.landmarks || []) { const xs = lm.map(p => p.x), ys = lm.map(p => p.y), sz = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)); if (sz > bs) { bs = sz; best = lm; } }
    if (best) { const f = new Float32Array(66); best.slice(0, 33).forEach((p, i) => { f[i * 2] = p.x * plan.width; f[i * 2 + 1] = p.y * plan.height; }); frames[index] = f; }
    onProgress?.(index + 1, plan.frames);
    if (index % 2) await new Promise(r => setTimeout(r, 0));
  }
  return { frames: meta.kind === 'photo' ? frames : smoothSeries(frames, plan.fps, 1.5, 0.03), meta, plan };
}

export async function poseStudio({ profiles, profileId, setTop, go, onCleanup }) {
  const rigged = profiles.filter(p => p.body?.ok && (p.self || p.consent));
  setTop('Pose Studio', profileId ? '#/pose' : null);
  if (!rigged.length) return [h('h1', null, 'Pose Studio'), note(h('span', null, 'Pose Studio needs a character with a rigged full-body photo (and consent, if it is not you). ', h('a', { href: '#/library' }, 'Open Characters'), ' → add a Full body photo.'), 'warn'), h('p', { class: 'muted small' }, 'Tip: stand facing the camera, head to feet in frame, arms a little away from your sides, on a plain background.')];
  const prof = rigged.find(p => p.id === profileId) || rigged[0];
  const key = 'studio:' + prof.id;
  let st = (await db.get('kv', key).catch(() => null)) || null;
  const [W0, H0] = SIZES[st?.size || 'portrait'];
  const stage = await new Stage(prof, W0, H0).init();
  const I = stage.I;
  const fitScale = (W, H) => Math.min(H * 0.78 / (prof.body.h), W * 0.9 / prof.body.w);
  if (!st || st.rigAt !== (prof.updatedAt || prof.createdAt)) {
    const s = fitScale(W0, H0), base = restPose(I, W0 / 2, 0, s), J = fk(base, I);
    base.y = H0 * 0.92 - Math.max(J.lAn[1], J.rAn[1]); // feet near the bottom of the frame
    st = { id: key, profileId: prof.id, rigAt: prof.updatedAt || prof.createdAt, size: 'portrait', bg: { type: 'color', color: '#1b1726' }, pose: base, rest: base, poses: [], dances: [], danceId: null, loops: 2, label: true };
  }
  const save = () => db.put('kv', st).catch(() => {});
  const view = mk(stage.W, stage.H); view.style.touchAction = 'none'; view.style.width = '100%'; view.style.height = 'auto'; view.setAttribute('aria-label', 'Pose stage. Drag the dots to pose.');
  let bgImg = null, bgVideo = null, music = null, t = 0, playing = false, showRig = true, drag = null;
  const loadBg = async () => {
    bgImg = null; bgVideo?.g?.dispose(); bgVideo = null;
    const rec = st.bg.type !== 'color' ? await db.get('renders', 'studiobg:' + prof.id) : null;
    if (rec?.blob && st.bg.type === 'image') bgImg = await blobToCanvas(rec.blob, 2600);
    if (rec?.blob && st.bg.type === 'video') { const f = new File([rec.blob], rec.name || 'bg.mp4', { type: rec.blob.type }); const meta = await probe(f); const plan = makePlan(meta, { start: 0, end: Math.min(meta.duration, 60) }, 'quality'); bgVideo = { g: await new FrameGrabber(f, meta, plan).init(), plan }; }
  };
  const bgFrame = async (time) => bgVideo ? bgVideo.g.get(Math.floor(time * bgVideo.plan.fps) % bgVideo.plan.frames) : bgImg;
  const dance = () => st.dances.find(d => d.id === st.danceId) || null;
  const poseAt = time => { const d = dance(); return d && d.keys.length ? samplePose(d, time) : st.pose; };
  let raf = 0;
  const paint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paintNow); };
  const paintNow = async () => {
    const pose = playing || dance()?.keys.length ? poseAt(t) : st.pose;
    stage.background(st.bg, await bgFrame(t));
    const { canvas, joints } = stage.compose(drag ? st.pose : pose);
    const c = view.getContext('2d'); c.drawImage(canvas, 0, 0);
    if (showRig && !playing) {
      const r = stage.W / 90; c.lineWidth = r * 0.35; c.strokeStyle = 'rgba(181,151,255,.85)';
      const J = drag ? fk(st.pose, I) : joints;
      c.beginPath(); for (const [a, b] of [['pelvis', 'neck'], ['neck', 'nose'], ['lSh', 'lEl'], ['lEl', 'lWr'], ['rSh', 'rEl'], ['rEl', 'rWr'], ['lHip', 'lKn'], ['lKn', 'lAn'], ['rHip', 'rKn'], ['rKn', 'rAn'], ['lSh', 'rSh'], ['lHip', 'rHip']]) { c.moveTo(...J[a]); c.lineTo(...J[b]); } c.stroke();
      for (const n of HANDLES) { c.fillStyle = n === 'pelvis' ? '#4fd1a1' : n === drag ? '#ffffff' : '#8d5cff'; c.beginPath(); c.arc(J[n][0], J[n][1], n === 'pelvis' ? r * 1.25 : r, 0, 7); c.fill(); c.lineWidth = r * 0.25; c.strokeStyle = '#0b0a0f'; c.stroke(); }
    }
    tlDraw();
  };
  const toStage = ev => { const r = view.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * stage.W, (ev.clientY - r.top) / r.height * stage.H]; };
  view.addEventListener('pointerdown', ev => {
    if (playing) return;
    const p = toStage(ev), d = dance(); if (d?.keys.length) st.pose = poseAt(t);
    const J = fk(st.pose, I); let best = null, bd = stage.W / 14;
    for (const n of HANDLES) { const dd = Math.hypot(J[n][0] - p[0], J[n][1] - p[1]); if (dd < bd) { bd = dd; best = n; } }
    if (best) { drag = best; view.setPointerCapture(ev.pointerId); paint(); }
  });
  view.addEventListener('pointermove', ev => { if (!drag) return; st.pose = dragJoint(st.pose, I, drag, toStage(ev)); paint(); });
  const endDrag = () => { if (!drag) return; drag = null; const d = dance(); if (d) setKey(d, t, st.pose); save(); paint(); drawPanels(); };
  view.addEventListener('pointerup', endDrag); view.addEventListener('pointercancel', endDrag);

  // timeline
  const tl = mk(900, 46); tl.className = 'timeline';
  const tlDraw = () => {
    const d = dance(), c = tl.getContext('2d'); c.clearRect(0, 0, 900, 46);
    if (!d) { c.fillStyle = '#6f6980'; c.font = '600 13px "IBM Plex Mono", monospace'; c.fillText('Single pose — pick or create a dance to animate', 12, 27); return; }
    const X = tt => 10 + tt / Math.max(0.1, d.duration) * 880;
    c.fillStyle = '#2b2735'; c.fillRect(10, 20, 880, 6);
    if (d.source === 'video') { c.fillStyle = 'rgba(141,92,255,.5)'; c.fillRect(10, 20, X(d.duration) - 10, 6); }
    else { c.fillStyle = '#fff'; for (const k of d.keys) { const x = X(k.t); c.beginPath(); c.moveTo(x, 12); c.lineTo(x + 6, 23); c.lineTo(x, 34); c.lineTo(x - 6, 23); c.fill(); } }
    c.fillStyle = '#b597ff'; c.fillRect(X(t) - 1, 4, 3, 38);
  };
  tl.addEventListener('pointerdown', ev => { const d = dance(); if (!d) return; const r = tl.getBoundingClientRect(); t = Math.max(0, Math.min(d.duration, ((ev.clientX - r.left) / r.width * 900 - 10) / 880 * d.duration)); st.pose = poseAt(t); scrubLbl(); paint(); });
  const tLbl = h('span', { class: 'mono small muted' });
  const scrubLbl = () => (tLbl.textContent = dance() ? `${t.toFixed(2)} s / ${dance().duration.toFixed(2)} s` : '');
  const setKey = (d, time, pose) => {
    if (d.source === 'video') return; // learned dances are dense; edit by converting
    const i = d.keys.findIndex(k => Math.abs(k.t - time) < 0.02);
    const k = { t: +time.toFixed(3), pose: JSON.parse(JSON.stringify(pose)) };
    if (i >= 0) d.keys[i] = k; else { d.keys.push(k); d.keys.sort((a, b) => a.t - b.t); }
    if (time > d.duration) d.duration = time;
  };
  const play = async () => {
    const d = dance(); if (!d) return;
    playing = !playing; drawPanels();
    let last = performance.now();
    const src = music ? audioCtx().createBufferSource() : null;
    if (src) { await audioCtx().resume(); src.buffer = music; src.connect(audioCtx().destination); src.start(0, t % music.duration); }
    while (playing) {
      const now = performance.now(); t += (now - last) / 1000; last = now;
      if (t > d.duration) { if (d.loop) t %= d.duration; else { t = d.duration; playing = false; } }
      scrubLbl(); await paintNow(); await new Promise(r => requestAnimationFrame(r));
    }
    try { src?.stop(); } catch {}
    st.pose = poseAt(t); drawPanels(); paint();
  };

  // panels
  const panels = h('div', { class: 'stack' }), exportBox = h('div', { class: 'stack' });
  const drawPanels = () => {
    const d = dance();
    panels.replaceChildren(
      panel(h('div', { class: 'row between' }, h('h2', null, 'Pose'), h('div', { class: 'row' },
          h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(showRig), onclick: () => { showRig = !showRig; drawPanels(); paint(); } }, 'Show joints'))),
        h('p', { class: 'muted small' }, 'Drag the purple dots: elbows and knees swing the limb, wrists and ankles bend it (bone lengths stay yours). Green dot moves the whole body, neck leans the torso, head dot turns the head.'),
        slider('Size', st.pose.s, { min: 0.2, max: 4, step: 0.01, oninput: v => { const r = v / st.pose.s; st.pose = { ...st.pose, s: v }; if (d && d.source !== 'video') d.keys.forEach(k => (k.pose.s *= r)); paint(); save(); } }),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { st.pose = JSON.parse(JSON.stringify({ ...st.rest, x: st.pose.x, y: st.pose.y, s: st.pose.s })); if (d) setKey(d, t, st.pose); save(); paint(); } }, 'Reset to my photo pose'),
          h('button', { class: 'btn sm', onclick: () => { st.pose = mirrorPose(st.pose, stage.W / 2); if (d) setKey(d, t, st.pose); save(); paint(); } }, 'Mirror'),
          h('button', { class: 'btn sm', onclick: () => { st.poses.push({ id: uid('pz'), name: `Pose ${st.poses.length + 1}`, pose: JSON.parse(JSON.stringify(st.pose)) }); save(); drawPanels(); toast('Pose saved'); } }, 'Save pose'),
          fileButton('Copy pose from a photo', 'image/*', async f => {
            try { toast('Reading the pose…'); const r = await readDancer(f); const [p] = retargetFrames(r.frames, I, [st.pose.x, st.pose.y], st.pose.s); if (!p) throw new Error('No person found in that photo.'); st.pose = p; if (d) setKey(d, t, p); save(); paint(); }
            catch (e) { toast(e.message, true); }
          }, { cls: 'btn sm' })),
        st.poses.length ? h('div', { class: 'row' }, st.poses.map(pz => h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, onclick: () => { st.pose = JSON.parse(JSON.stringify(pz.pose)); if (d) setKey(d, t, st.pose); save(); paint(); } }, pz.name, h('button', { class: 'btn sm ghost', 'aria-label': 'Delete pose', style: { minHeight: '20px', padding: '0 4px' }, onclick: ev => { ev.stopPropagation(); st.poses = st.poses.filter(x => x !== pz); save(); drawPanels(); } }, '×')))) : null),
      panel(h('h2', null, 'Dance'),
        h('div', { class: 'row' },
          h('select', { 'aria-label': 'Dance', style: { width: 'auto', flex: 1 }, onchange: e => { st.danceId = e.target.value || null; t = 0; st.pose = poseAt(0); save(); drawPanels(); paint(); } },
            h('option', { value: '' }, 'No dance (single pose)'), st.dances.map(x => h('option', { value: x.id, selected: x.id === st.danceId }, x.name))),
          h('button', { class: 'btn sm', onclick: () => { const nd = { id: uid('d'), name: `My dance ${st.dances.length + 1}`, source: 'keys', duration: 2, loop: true, ease: 'smooth', keys: [{ t: 0, pose: JSON.parse(JSON.stringify(st.pose)) }] }; st.dances.push(nd); st.danceId = nd.id; t = 0; save(); drawPanels(); paint(); } }, '+ New')),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Presets:'), Object.entries(PRESETS).map(([k, pr]) => h('button', { class: 'btn sm ghost', onclick: () => { const base = { ...st.rest, x: st.pose.x, y: st.pose.y, s: st.pose.s, a: { ...st.rest.a } }; const nd = { id: uid('d'), name: pr.name, source: 'preset', duration: pr.duration, loop: true, ease: 'smooth', keys: pr.make(I, base) }; st.dances.push(nd); st.danceId = nd.id; t = 0; save(); drawPanels(); play(); } }, pr.name))),
        h('div', { class: 'row' },
          fileButton('Learn a dance from a video', 'video/*', async f => {
            const bar = progressBar(), msg = h('p', { class: 'small muted mono' }, 'Reading the dancer…'), ctrl = new AbortController();
            const box = h('div', { class: 'modal' }, h('div', { class: 'box' }, h('h2', null, 'Learning the dance'), bar, msg, h('button', { class: 'btn', onclick: () => ctrl.abort() }, 'Cancel')));
            document.body.appendChild(box);
            try {
              const r = await readDancer(f, (a, b) => { bar.set(a / b); msg.textContent = `Frame ${a}/${b}`; }, ctrl.signal);
              const found = r.frames.filter(Boolean).length; if (found < 3) throw new Error('No dancer was found in that video.');
              const poses = retargetFrames(r.frames, I, [st.pose.x, st.pose.y], st.pose.s);
              const nd = { id: uid('d'), name: (f.name || 'Video dance').replace(/\.\w+$/, '').slice(0, 30), source: 'video', duration: r.plan.frames / r.plan.fps, loop: false, ease: 'linear', fps: r.plan.fps, keys: poses.map((p, i) => p && { t: i / r.plan.fps, pose: p }).filter(Boolean), coverage: found / r.plan.frames, hasAudio: r.meta.audio?.length > 0 };
              await db.put('renders', { id: 'dancevid:' + nd.id, blob: f, name: f.name, at: Date.now() });
              st.dances.push(nd); st.danceId = nd.id; t = 0; save();
              toast(`Learned ${nd.duration.toFixed(1)} s of dance (dancer found in ${Math.round(nd.coverage * 100)}% of frames)`);
            } catch (e) { if (e.message !== 'Cancelled') toast('Could not learn the dance: ' + e.message, true, 7000); }
            box.remove(); drawPanels(); paint();
          }, { cls: 'btn sm primary' }),
          fileButton(music ? 'Replace music' : 'Add music', 'audio/*,video/*', async f => { try { music = await audioCtx().decodeAudioData(await f.arrayBuffer()); await db.put('renders', { id: 'studiomusic:' + prof.id, blob: f, name: f.name, at: Date.now() }); toast(`Music: ${f.name} (${music.duration.toFixed(1)} s)`); drawPanels(); } catch (e) { toast('Could not read that audio: ' + e.message, true); } }, { cls: 'btn sm' }),
          music ? h('button', { class: 'btn sm ghost danger', onclick: async () => { music = null; await db.del('renders', 'studiomusic:' + prof.id); drawPanels(); } }, 'Remove music') : null),
        d ? h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('button', { class: 'btn sm', 'aria-label': playing ? 'Pause' : 'Play', onclick: play }, playing ? '❚❚' : '▶'), tLbl, d.source === 'video' ? chip(`learned · ${d.fps?.toFixed?.(0) || ''} fps${d.hasAudio ? ' · has audio' : ''}`, 'v') : chip(`${d.keys.length} keyframes`)),
          tl,
          d.source !== 'video' ? h('div', { class: 'row' },
            h('button', { class: 'btn sm', onclick: () => { setKey(d, t, st.pose); save(); drawPanels(); paint(); } }, '◆ Set key here'),
            h('button', { class: 'btn sm ghost', onclick: () => { d.keys = d.keys.filter(k => Math.abs(k.t - t) >= 0.02); save(); drawPanels(); paint(); } }, 'Delete key'),
            h('button', { class: 'btn sm ghost', onclick: () => { const ks = d.keys.filter(k => k.t < t - 0.02); if (ks.length) { t = ks[ks.length - 1].t; st.pose = poseAt(t); scrubLbl(); paint(); } } }, '← key'),
            h('button', { class: 'btn sm ghost', onclick: () => { const k = d.keys.find(k => k.t > t + 0.02); if (k) { t = k.t; st.pose = poseAt(t); scrubLbl(); paint(); } } }, 'key →')) :
            h('p', { class: 'muted small' }, 'Learned dances follow the dancer frame by frame. To hand-edit, convert to keyframes.'),
          d.source === 'video' ? h('button', { class: 'btn sm', onclick: () => { const step = Math.max(1, Math.round((d.fps || 30) / 6)); d.keys = d.keys.filter((_, i) => i % step === 0); d.source = 'keys'; d.ease = 'smooth'; save(); drawPanels(); paint(); toast(`Converted to ${d.keys.length} keyframes`); } }, 'Convert to keyframes (6 per second)') : null,
          slider('Length', d.duration, { min: 0.5, max: 60, step: 0.1, fmt: v => (+v).toFixed(1) + ' s', oninput: v => { if (d.source === 'video') return; d.duration = Math.max(v, d.keys[d.keys.length - 1]?.t || 0); save(); tlDraw(); } }),
          h('div', { class: 'row' }, check('Loop', d.loop, v => { d.loop = v; save(); }), d.source !== 'video' ? seg([['smooth', 'Smooth'], ['linear', 'Linear']], d.ease, v => { d.ease = v; save(); paint(); }) : null,
            h('button', { class: 'btn sm', onclick: () => { d.keys = d.keys.map(k => ({ t: k.t, pose: mirrorPose(k.pose, stage.W / 2) })); save(); paint(); } }, 'Mirror dance'),
            h('label', { class: 'small muted row' }, 'Name', h('input', { type: 'text', value: d.name, style: { width: '150px' }, oninput: e => { d.name = e.target.value; save(); } })),
            h('button', { class: 'btn sm ghost danger', onclick: async () => { if (!(await confirmBox(`Delete “${d.name}”?`))) return; st.dances = st.dances.filter(x => x !== d); st.danceId = null; await db.del('renders', 'dancevid:' + d.id); save(); drawPanels(); paint(); } }, 'Delete dance'))) : null),
      panel(h('h2', null, 'Stage'),
        seg(Object.entries(SIZES).map(([k, v]) => [k, v[2]]), st.size, async v => {
          const [W, H] = SIZES[v], sx = W / stage.W, sy = H / stage.H, k = Math.min(sx, sy);
          const fix = p => ({ ...p, x: p.x * sx, y: p.y * sy, s: p.s * k });
          st.pose = fix(st.pose); st.rest = fix(st.rest); st.poses.forEach(z => (z.pose = fix(z.pose))); st.dances.forEach(dd => dd.keys.forEach(kk => (kk.pose = fix(kk.pose))));
          st.size = v; stage.resize(W, H); view.width = W; view.height = H; save(); await loadBg(); paint();
        }),
        seg([['color', 'Colour'], ['image', 'Photo'], ['video', 'Video']], st.bg.type, async v => { st.bg.type = v; save(); await loadBg(); drawPanels(); paint(); }),
        h('div', { class: 'row' }, h('input', { type: 'color', value: st.bg.color, 'aria-label': 'Background colour', oninput: e => { st.bg.color = e.target.value; save(); paint(); } }),
          st.bg.type !== 'color' ? fileButton(st.bg.type === 'image' ? 'Choose photo' : 'Choose video', st.bg.type === 'image' ? 'image/*' : 'video/*', async f => { await db.put('renders', { id: 'studiobg:' + prof.id, blob: f, name: f.name, at: Date.now() }); await loadBg(); paint(); }, { cls: 'btn sm' }) : null),
        h('p', { class: 'muted small' }, 'Put yourself into any photo or video. Background videos loop under the dance.')),
    );
    scrubLbl();
  };

  const doExport = async (kind) => {
    const d = dance(), ctrl = new AbortController(), bar = progressBar(), msg = h('p', { class: 'small muted mono' });
    exportBox.replaceChildren(panel(h('h2', null, kind === 'png' ? 'Saving image…' : 'Rendering video…'), bar, msg, kind === 'mp4' ? h('button', { class: 'btn sm', onclick: () => ctrl.abort() }, 'Cancel') : null));
    try {
      let blob, name, mime;
      const safe = s => (s || '').replace(/[^\w-]+/g, '').slice(0, 30);
      if (kind === 'png') {
        stage.background(st.bg, await bgFrame(t)); stage.compose(d?.keys.length ? poseAt(t) : st.pose, { label: st.label });
        blob = await new Promise(r => stage.out.toBlob(r, 'image/png')); mime = 'image/png'; name = `RECAST_${safe(prof.name)}_Pose.png`; bar.set(1);
      } else {
        if (!d) throw new Error('Pick or create a dance first.');
        const fps = 30, total = d.loop ? d.duration * st.loops : d.duration, N = Math.max(1, Math.round(total * fps));
        let audioFile = null, meta = null, plan = { width: stage.W, height: stage.H, fps, frames: N, start: 0, end: total }, audioBuffer = null;
        if (music) {
          const len = Math.round(total * music.sampleRate), ab = new AudioBuffer({ length: len, numberOfChannels: music.numberOfChannels, sampleRate: music.sampleRate });
          for (let c = 0; c < music.numberOfChannels; c++) { const src = music.getChannelData(c), dst = ab.getChannelData(c); for (let i = 0; i < len; i++) dst[i] = src[i % src.length]; }
          audioBuffer = ab;
        } else if (d.source === 'video' && d.hasAudio) {
          const rec = await db.get('renders', 'dancevid:' + d.id);
          if (rec?.blob) { audioFile = new File([rec.blob], rec.name || 'dance.mp4', { type: rec.blob.type }); meta = await probe(audioFile); }
        }
        const w = new VideoWriter(stage.out, plan); await w.start({ audioFile, meta, audioBuffer, includeAudio: !!(audioBuffer || audioFile) });
        for (let i = 0; i < N; i++) {
          if (ctrl.signal.aborted) { await w.cancel(); throw new Error('Cancelled'); }
          const tt = i / fps; stage.background(st.bg, await bgFrame(tt)); stage.compose(poseAt(tt), { label: st.label });
          await w.addFrame(i); bar.set((i + 1) / N); msg.textContent = `Frame ${i + 1}/${N}`;
          if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
        }
        msg.textContent = 'Finalizing…';
        const out = await w.finish(); blob = out.blob; mime = out.mime; name = `RECAST_${safe(prof.name)}_${safe(d.name)}${st.label ? '_AI-edited' : ''}.${out.ext}`;
        (w.notes || []).forEach(n => toast(n));
      }
      const url = URL.createObjectURL(blob);
      exportBox.replaceChildren(panel(h('div', { class: 'row between' }, h('h2', null, kind === 'png' ? 'Image ready' : 'Video ready'), chip(`${(blob.size / 1048576).toFixed(1)} MB`, 'ok')),
        kind === 'png' ? h('img', { src: url, alt: 'Exported pose', style: { maxHeight: '60vh', margin: '0 auto', borderRadius: '12px' } }) : h('video', { src: url, controls: true, playsInline: true, style: { maxHeight: '60vh', margin: '0 auto', borderRadius: '12px' } }),
        h('p', { class: 'small muted mono' }, name),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { if (!(await shareFile(blob, name, mime))) downloadBlob(blob, name); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); } } }, 'Save / Share'), h('button', { class: 'btn', onclick: () => downloadBlob(blob, name) }, 'Download'))));
    } catch (e) { exportBox.replaceChildren(note((e.message === 'Cancelled' ? 'Export cancelled.' : 'Export failed: ' + e.message), e.message === 'Cancelled' ? 'warn' : 'bad')); }
  };

  const musicRec = await db.get('renders', 'studiomusic:' + prof.id).catch(() => null);
  if (musicRec?.blob) try { music = await audioCtx().decodeAudioData(await musicRec.blob.arrayBuffer()); } catch {}
  await loadBg(); save(); drawPanels(); paint();
  onCleanup?.(() => { playing = false; cancelAnimationFrame(raf); bgVideo?.g?.dispose(); stage.dispose(); });
  return [
    h('div', { class: 'row between' }, h('h1', null, 'Pose Studio'),
      rigged.length > 1 ? h('select', { 'aria-label': 'Character', style: { width: 'auto' }, onchange: e => go('#/pose/' + e.target.value) }, rigged.map(p => h('option', { value: p.id, selected: p.id === prof.id }, p.name))) : chip(prof.name, 'v')),
    h('div', { class: 'editor' },
      h('div', { class: 'stack' }, h('div', { class: 'monitor', style: { maxWidth: st.size === 'portrait' ? '460px' : '100%', margin: '0 auto', width: '100%' } }, view),
        panel(h('h2', null, 'Export'), check('Add “AI-edited” label', st.label, v => { st.label = v; save(); }),
          dance()?.loop !== false ? slider('Loops', st.loops, { min: 1, max: 10, step: 1, fmt: v => `×${v}`, oninput: v => { st.loops = v; save(); } }) : null,
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => doExport('png') }, 'Save image (PNG)'), h('button', { class: 'btn', onclick: () => doExport('mp4') }, 'Export video (MP4)')),
          h('p', { class: 'muted small' }, 'Video export plays the selected dance at 30 fps with your music, or with the dance video’s own sound for learned dances.')),
        exportBox),
      h('div', { class: 'stack side' }, panels)),
    h('p', { class: 'muted small' }, 'How it works: your full-body photo is a 2D model with a 10-bone skeleton. Poses bend the photo, so turning sideways or showing your back, crossed limbs and hands can look unnatural. Everything runs on this device.'),
  ];
}
