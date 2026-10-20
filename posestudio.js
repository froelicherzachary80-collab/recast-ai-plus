// RECAST AI+ v0.4 — Pose Studio: your T-pose model(s) posed into any scene.
// Up to 4 characters on a stage. Pose by dragging joints or from the library (poster, superhero,
// dance, everyday, and two-person romance/friends/action scenes). Animate with keyframes, presets or a
// dance learned from video (solo or duet). Drop yourself into any photo (match and paint out a person
// who is already there), grade the look, add power effects and poster titles, export PNG/JPEG/MP4.
import { h, toast, confirmBox, slider, check, seg, chip, progressBar, fileButton, downloadBlob, shareFile } from './ui.js';
import { db, uid } from './db.js';
import { FaceRenderer } from './facerender.js';
import { buildRig, deformRig } from './puppet.js';
import { restInfo, fk, fromJoints, restPose, dragJoint, samplePose, mirrorPose, PRESETS, retargetFrames, HANDLES } from './poserig.js';
import { makePose, POSES, DUOS, searchPoses, fxAnchor } from './poselib.js';
import { makeTPoseModel } from './tpose.js';
import { GRADES, gradeCanvas, vignette, letterbox, drawEffect, drawAura, drawPoster, TITLE_FONTS } from './fx.js';
import { blobToCanvas } from './profile.js';
import { probe, makePlan, iterateFrames, FrameGrabber, VideoWriter } from './media.js';
import { getTask, nextTs, hasModel, segment } from './models.js';
import { smoothSeries } from './smoothing.js';
import { pushPullFill } from './plate.js';
import { audioCtx } from './dub.js';

const SIZES = { portrait: [1080, 1920, 'Story 9:16'], poster: [1600, 2400, 'Poster 2:3'], square: [1080, 1080, 'Square'], landscape: [1920, 1080, 'Wide 16:9'] };
const FX_TYPES = { glow: 'Hand glow', beam: 'Energy beam', lightning: 'Lightning', shock: 'Shockwave', trail: 'Jet trail', aura: 'Aura' };
const FX_JOINTS = { handR: 'Right-side hand', handL: 'Left-side hand', feet: 'Feet' };
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const note = (t, kind = '') => h('div', { class: 'note ' + kind }, t);
const sec = (title, open, ...kids) => h('details', { class: 'panel', open }, h('summary', null, h('h2', null, title)), ...kids);
const clone = o => JSON.parse(JSON.stringify(o));
const lowest = J => Math.max(J.lAn[1], J.rAn[1]);
const usable = p => p.body?.ok && (p.self || p.consent);

/** Pose landmarks for the largest n people per frame, ordered left → right. */
async function readPeople(file, n, onProgress, signal) {
  const key = (await hasModel('pose_full')) ? 'pose_full' : 'pose_lite';
  const meta = await probe(file), plan = makePlan(meta, { start: 0, end: Math.min(meta.duration, 30) }, meta.kind === 'photo' ? 'photo' : 'quality');
  const task = await getTask(key, meta.kind === 'photo' ? 'IMAGE' : 'VIDEO', { num: Math.max(2, n) });
  const tracks = Array.from({ length: n }, () => new Array(plan.frames).fill(null));
  for await (const { index, canvas } of iterateFrames(file, meta, plan, { signal })) {
    if (signal?.aborted) throw new Error('Cancelled');
    const r = meta.kind === 'photo' ? task.detect(canvas) : task.detectForVideo(canvas, nextTs());
    const people = (r.landmarks || []).map(lm => { const xs = lm.map(p => p.x), ys = lm.map(p => p.y); return { lm, size: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)), cx: (lm[23].x + lm[24].x) / 2 }; })
      .sort((a, b) => b.size - a.size).slice(0, n).sort((a, b) => a.cx - b.cx);
    people.forEach((p, i) => { const f = new Float32Array(66); p.lm.slice(0, 33).forEach((q, j) => { f[j * 2] = q.x * plan.width; f[j * 2 + 1] = q.y * plan.height; }); tracks[i][index] = f; });
    onProgress?.(index + 1, plan.frames);
    if (index % 2) await new Promise(res => setTimeout(res, 0));
  }
  return { tracks: meta.kind === 'photo' ? tracks : tracks.map(t => smoothSeries(t, plan.fps, 1.5, 0.03)), meta, plan };
}

export async function poseStudio({ profiles, profileId, setTop, go, onCleanup }) {
  setTop('Pose Studio', null);
  const ready = profiles.filter(usable);
  if (!ready.length) return [h('h1', null, 'Pose Studio'), note(h('span', null, 'Pose Studio needs a character with a full-body photo (and consent, if it is not you). ', h('a', { href: '#/library' }, 'Open Characters'), ' → add a Full body photo, then tap “Make T-pose model”.'), 'warn'), h('p', { class: 'muted small' }, 'For the best model, also add a photo of yourself standing in a T-pose: arms straight out to the sides, facing the camera, head to feet in frame, plain background.')];
  try { await Promise.all(['64px Anton', '40px Oswald', '300 20px Oswald'].map(f => document.fonts?.load(f))); } catch {}

  const KEY = 'studio:v4';
  let st = await db.get('kv', KEY).catch(() => null);
  const first = ready.find(p => p.id === profileId) || ready.find(p => p.self) || ready[0];
  if (!st) st = { id: KEY, size: 'portrait', bg: { type: 'color', color: '#1b1726' }, look: { grade: 'none', amount: 1, vignette: 0.25, bars: false, shadow: true }, text: { title: '', tagline: '', credits: '', date: '', pos: 'bottom', font: 'anton', color: '#ffffff' }, layers: [], sel: null, poses: [], dances: [], loops: 2, label: true, fmt: 'png' };
  st.layers = st.layers.filter(L => profiles.some(p => p.id === L.profileId && usable(p)));
  let W = SIZES[st.size][0], H = SIZES[st.size][1];
  const gl = new FaceRenderer(W, H), out = mk(W, H), bgC = mk(W, H), blank = mk(W, H), layerC = mk(W, H);
  const rigs = new Map();
  const bodyFor = (prof, view) => (view === 'back' && prof.bodyRear?.ok ? prof.bodyRear : view === 'side' && prof.bodySide?.ok ? prof.bodySide : prof.body);
  const rigFor = async (prof, view = 'front') => {
    const body = bodyFor(prof, view), id = prof.id + ':' + view, k = id + ':' + (body.at || prof.updatedAt || 0) + ':' + body.w;
    if (!rigs.has(id) || rigs.get(id).k !== k) {
      const I = restInfo(body.joints), rig = buildRig(body.alpha, body.w, body.h, body.joints, { cells: 52 });
      rigs.set(id, { k, I, rig, tex: gl.texture('studio:' + k, await blobToCanvas(body.png, 4096)), prof });
    }
    return rigs.get(id);
  };
  const profOf = L => profiles.find(p => p.id === L.profileId);
  const relaxedAt = (R, x, floorY, s) => { const P = restPose(R.I, x, 0, s), J = fk(P, R.I); P.y = floorY - lowest(J); return P; };
  const addLayer = async prof => {
    const R = await rigFor(prof), s = Math.min(H * 0.74 / prof.body.h, W * 0.42 / prof.body.w) * (st.layers.length ? 0.97 : 1);
    const x = W * (st.layers.length ? Math.min(0.85, 0.3 + st.layers.length * 0.4) : 0.5);
    const L = { id: uid('ly'), profileId: prof.id, pose: relaxedAt(R, x, H * 0.93, s), danceId: null, fx: [] };
    st.layers.push(L); st.sel = L.id; return L;
  };
  if (!st.layers.length) await addLayer(first);
  for (const L of st.layers) await rigFor(profOf(L), L.view || 'front');
  if (!st.layers.some(L => L.id === st.sel)) st.sel = st.layers[0].id;
  const save = () => db.put('kv', st).catch(() => {});
  const sel = () => st.layers.find(L => L.id === st.sel);
  const R_ = L => rigs.get(L.profileId + ':' + (L.view || 'front'));
  const danceOf = L => st.dances.find(d => d.id === L.danceId) || null;
  const anyDance = () => st.layers.some(L => danceOf(L)?.keys.length);
  const fromDance = (L, d, p) => { const R = R_(L), k = (L.pose.s * R.I.torso) / d.origin.torsoPx; return { x: L.pose.x + (p.x - d.origin.x) * k, y: L.pose.y + (p.y - d.origin.y) * k, s: L.pose.s * (p.s / d.origin.s), a: p.a }; };
  const toDance = (L, d, P) => { const R = R_(L), k = (L.pose.s * R.I.torso) / d.origin.torsoPx; return { x: d.origin.x + (P.x - L.pose.x) / k, y: d.origin.y + (P.y - L.pose.y) / k, s: d.origin.s * (P.s / L.pose.s), a: { ...P.a } }; };
  const poseOf = (L, t) => { const d = danceOf(L); return d?.keys.length ? fromDance(L, d, samplePose(d, t)) : L.pose; };
  const newDance = (L, name, source, keys, extra = {}) => { const R = R_(L); const d = { id: uid('d'), name, source, duration: 2, loop: true, ease: 'smooth', keys, origin: { x: L.pose.x, y: L.pose.y, s: L.pose.s, torsoPx: L.pose.s * R.I.torso }, ...extra }; st.dances.push(d); L.danceId = d.id; return d; };
  const setKey = (L, t, P) => {
    const d = danceOf(L); if (!d) { L.pose = P; return; }
    if (d.source === 'video') { toast('Learned dances are frame-by-frame. Convert to keyframes to edit.', true); return; }
    const k = { t: +t.toFixed(3), pose: toDance(L, d, P) }, i = d.keys.findIndex(q => Math.abs(q.t - t) < 0.02);
    if (i >= 0) d.keys[i] = k; else { d.keys.push(k); d.keys.sort((a, b) => a.t - b.t); }
    if (t > d.duration) d.duration = t;
  };

  // backgrounds
  let bgImg = null, bgVideo = null, music = null, t = 0, playing = false, showRig = true, drag = null, raf = 0;
  const loadBg = async () => {
    bgImg = null; bgVideo?.g?.dispose(); bgVideo = null;
    const rec = st.bg.type !== 'color' ? await db.get('renders', 'studiobg:v4') : null;
    if (rec?.blob && st.bg.type === 'image') bgImg = await blobToCanvas(rec.blob, 3000);
    if (rec?.blob && st.bg.type === 'video') { const f = new File([rec.blob], rec.name || 'bg.mp4', { type: rec.blob.type }); const meta = await probe(f); const plan = makePlan(meta, { start: 0, end: Math.min(meta.duration, 60) }, 'quality'); bgVideo = { g: await new FrameGrabber(f, meta, plan).init(), plan }; }
  };
  const bgFrame = async time => bgVideo ? bgVideo.g.get(Math.floor(time * bgVideo.plan.fps) % bgVideo.plan.frames) : bgImg;
  const coverMap = img => { const s = Math.max(W / img.width, H / img.height); return { s, ox: (W - img.width * s) / 2, oy: (H - img.height * s) / 2 }; };

  /** Compose the whole scene at time `time` into `out`. */
  const compose = async (time, { overlay = false, editing = null } = {}) => {
    const c = out.getContext('2d', { willReadFrequently: true }); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    const bctx = bgC.getContext('2d'), img = await bgFrame(time);
    bctx.fillStyle = st.bg.color || '#15131c'; bctx.fillRect(0, 0, W, H);
    if (img) { const m = coverMap(img); bctx.drawImage(img, m.ox, m.oy, img.width * m.s, img.height * m.s); }
    c.drawImage(bgC, 0, 0);
    const placed = [];
    for (const L of st.layers) {
      const R = R_(L), P = editing?.layer === L ? editing.pose : poseOf(L, time), J = fk(P, R.I), T = R.I.torso * P.s;
      if (st.look.shadow) {
        // shadow stays on the floor (the layer's still pose) and fades when the character jumps or flies
        const floor = lowest(fk(L.pose, R.I)), air = Math.max(0, floor - lowest(J)), fade = Math.max(0, 1 - air / (T * 1.5));
        const fx = (J.lAn[0] + J.rAn[0]) / 2, rw = (Math.abs(J.lSh[0] - J.rSh[0]) * 0.9 + T * 0.25) * (1 - 0.3 * (1 - fade));
        if (fade > 0.02) { c.save(); c.translate(fx, floor + 0.03 * T); c.scale(1, 0.18); const g = c.createRadialGradient(0, 0, 0, 0, 0, rw); g.addColorStop(0, `rgba(0,0,0,${0.42 * fade})`); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.beginPath(); c.arc(0, 0, rw, 0, 7); c.fill(); c.restore(); }
      }
      gl.render(blank, [{ tex: R.tex, pos: deformRig(R.rig, J), uv: R.rig.uv, alpha: new Float32Array(R.rig.n).fill(1), gain: new Float32Array(R.rig.n * 3).fill(1), idx: R.rig.idx, opacity: 1, grain: 0.006, sat: 1, bias: 0.2 }]);
      const lc = layerC.getContext('2d'); lc.clearRect(0, 0, W, H); lc.drawImage(gl.canvas, 0, 0);
      for (const f of L.fx.filter(f => f.type === 'aura')) drawAura(c, layerC, f, T, time);
      c.drawImage(layerC, 0, 0);
      for (const f of L.fx.filter(f => f.type !== 'aura')) drawEffect(c, f, fxAnchor(R.I, P, f.joint || 'handR'), T, W, H, time);
      placed.push({ L, J, T });
    }
    gradeCanvas(c, W, H, st.look.grade, st.look.amount);
    vignette(c, W, H, st.look.vignette); letterbox(c, W, H, st.look.bars); drawPoster(c, W, H, st.text);
    if (st.label) { const fs = Math.round(H * 0.018), s = 'AI-edited · RECAST AI+'; c.font = `600 ${fs}px -apple-system, system-ui, sans-serif`; const tw = c.measureText(s).width; c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(W - tw - fs * 1.9, H - fs * 2.6, tw + fs, fs * 1.5); c.fillStyle = '#fff'; c.textBaseline = 'top'; c.fillText(s, W - tw - fs * 1.4, H - fs * 2.4); }
    if (overlay) for (const { L, J } of placed) {
      const on = L.id === st.sel, r = W / (on ? 85 : 140);
      c.lineWidth = r * 0.35; c.strokeStyle = on ? 'rgba(181,151,255,.9)' : 'rgba(255,255,255,.35)';
      c.beginPath(); for (const [a, b] of [['pelvis', 'neck'], ['neck', 'nose'], ['lSh', 'lEl'], ['lEl', 'lWr'], ['rSh', 'rEl'], ['rEl', 'rWr'], ['lHip', 'lKn'], ['lKn', 'lAn'], ['rHip', 'rKn'], ['rKn', 'rAn'], ['lSh', 'rSh'], ['lHip', 'rHip']]) { c.moveTo(...J[a]); c.lineTo(...J[b]); } c.stroke();
      for (const n of HANDLES) { c.fillStyle = n === 'pelvis' ? '#4fd1a1' : drag?.name === n && drag.layer === L ? '#fff' : on ? '#8d5cff' : 'rgba(255,255,255,.6)'; c.beginPath(); c.arc(J[n][0], J[n][1], n === 'pelvis' ? r * 1.25 : r, 0, 7); c.fill(); c.lineWidth = r * 0.25; c.strokeStyle = '#0b0a0f'; c.stroke(); }
    }
    return out;
  };

  const view = mk(W, H); view.style.cssText = 'width:100%;height:auto;touch-action:none'; view.setAttribute('aria-label', 'Stage. Drag the dots to pose. Tap a character to select it.');
  const paint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(async () => { await compose(t, { overlay: showRig && !playing, editing: drag }); view.getContext('2d').drawImage(out, 0, 0); tlDraw(); }); };
  const toStage = ev => { const r = view.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * W, (ev.clientY - r.top) / r.height * H]; };
  view.addEventListener('pointerdown', ev => {
    if (playing) return;
    const p = toStage(ev); let best = null, bd = W / 13;
    for (const L of [...st.layers].reverse()) { const P = poseOf(L, t), J = fk(P, R_(L).I); for (const n of HANDLES) { const d = Math.hypot(J[n][0] - p[0], J[n][1] - p[1]) * (L.id === st.sel ? 0.8 : 1); if (d < bd) { bd = d; best = { layer: L, name: n, pose: clone(P) }; } } }
    if (best) { drag = best; if (st.sel !== best.layer.id) { st.sel = best.layer.id; drawPanels(); } view.setPointerCapture(ev.pointerId); paint(); }
  });
  view.addEventListener('pointermove', ev => { if (!drag) return; drag.pose = dragJoint(drag.pose, R_(drag.layer).I, drag.name, toStage(ev)); paint(); });
  const endDrag = () => { if (!drag) return; setKey(drag.layer, t, drag.pose); drag = null; save(); paint(); };
  view.addEventListener('pointerup', endDrag); view.addEventListener('pointercancel', endDrag);

  // timeline for the selected layer's dance
  const tl = mk(900, 46); tl.className = 'timeline';
  const duration = () => Math.max(0.1, ...st.layers.map(L => danceOf(L)?.duration || 0));
  const tlDraw = () => {
    const c = tl.getContext('2d'), d = danceOf(sel()); c.clearRect(0, 0, 900, 46);
    if (!anyDance()) { c.fillStyle = '#6f6980'; c.font = '600 13px "IBM Plex Mono", monospace'; c.fillText('Still image — add a dance to animate', 12, 27); return; }
    const D = duration(), X = tt => 10 + tt / D * 880;
    c.fillStyle = '#2b2735'; c.fillRect(10, 20, 880, 6);
    if (d?.source === 'video') { c.fillStyle = 'rgba(141,92,255,.5)'; c.fillRect(10, 20, X(d.duration) - 10, 6); }
    else if (d) { c.fillStyle = '#fff'; for (const k of d.keys) { const x = X(k.t); c.beginPath(); c.moveTo(x, 12); c.lineTo(x + 6, 23); c.lineTo(x, 34); c.lineTo(x - 6, 23); c.fill(); } }
    c.fillStyle = '#b597ff'; c.fillRect(X(t) - 1, 4, 3, 38);
  };
  const tLbl = h('span', { class: 'mono small muted' });
  const scrubLbl = () => (tLbl.textContent = anyDance() ? `${t.toFixed(2)} / ${duration().toFixed(2)} s` : '');
  tl.addEventListener('pointerdown', ev => { if (!anyDance()) return; const r = tl.getBoundingClientRect(); t = Math.max(0, Math.min(duration(), ((ev.clientX - r.left) / r.width * 900 - 10) / 880 * duration())); scrubLbl(); paint(); });
  const play = async () => {
    if (!anyDance()) return;
    playing = !playing; drawPanels(); let last = performance.now();
    const src = music ? audioCtx().createBufferSource() : null;
    if (src) { await audioCtx().resume(); src.buffer = music; src.connect(audioCtx().destination); src.start(0, t % music.duration); }
    while (playing) {
      const now = performance.now(); t += (now - last) / 1000; last = now;
      const D = duration(); if (t > D) { if (st.layers.some(L => danceOf(L)?.loop)) t %= D; else { t = D; playing = false; } }
      scrubLbl(); await compose(t); view.getContext('2d').drawImage(out, 0, 0); tlDraw();
      await new Promise(r => requestAnimationFrame(r));
    }
    try { src?.stop(); } catch {}
    drawPanels(); paint();
  };

  // applying library poses
  const applySolo = (L, p) => {
    const R = R_(L), cur = poseOf(L, t), floor = lowest(fk(cur, R.I));
    const base = relaxedAt(R, cur.x, floor, cur.s);
    setKey(L, t, makePose(R.I, base, p.spec));
    if (p.fx) L.fx = clone(p.fx);
  };
  const applyDuo = async d => {
    if (st.layers.length < 2) { toast('Add a second character first (Cast → + Add character).', true); return; }
    const S = sel(), other = st.layers.find(L => L !== S) , pair = [S, other].sort((a, b) => poseOf(a, t).x - poseOf(b, t).x);
    const A = { I: R_(pair[0]).I, pose: poseOf(pair[0], t) }, B = { I: R_(pair[1]).I, pose: poseOf(pair[1], t) };
    const r = d.make(A, B);
    setKey(pair[0], t, r.A); setKey(pair[1], t, r.B);
    pair[0].fx = clone(r.fxA || []); pair[1].fx = clone(r.fxB || []);
    const rest = st.layers.filter(L => !pair.includes(L));
    st.layers = r.order === 'BA' ? [pair[1], pair[0], ...rest] : [pair[0], pair[1], ...rest];
  };

  // ── panels
  const panels = h('div', { class: 'stack' }), exportBox = h('div', { class: 'stack' });
  let query = '', cat = 'Poster';
  const drawPanels = () => {
    const L = sel(), prof = profOf(L), d = danceOf(L);
    const libResults = query ? searchPoses(query) : { solo: POSES.filter(p => p.cat === cat), duo: cat === 'Duo' ? DUOS : [] };
    panels.replaceChildren(
      sec('Cast', true,
        h('div', { class: 'row' }, st.layers.map((Y, i) => h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(Y.id === st.sel), onclick: () => { st.sel = Y.id; save(); drawPanels(); paint(); } }, `${i + 1}. ${profOf(Y)?.name}`))),
        h('div', { class: 'row' },
          st.layers.length < 4 ? h('select', { 'aria-label': 'Add character', style: { width: 'auto' }, onchange: async e => { const p = ready.find(x => x.id === e.target.value); if (!p) return; await addLayer(p); save(); drawPanels(); paint(); } }, h('option', { value: '' }, '+ Add character'), ready.map(p => h('option', { value: p.id }, p.name))) : null,
          h('button', { class: 'btn sm', onclick: () => { const i = st.layers.indexOf(L); if (i < st.layers.length - 1) { st.layers.splice(i, 1); st.layers.splice(i + 1, 0, L); save(); drawPanels(); paint(); } } }, 'Bring forward'),
          h('button', { class: 'btn sm', onclick: () => { const i = st.layers.indexOf(L); if (i > 0) { st.layers.splice(i, 1); st.layers.splice(i - 1, 0, L); save(); drawPanels(); paint(); } } }, 'Send back'),
          st.layers.length > 1 ? h('button', { class: 'btn sm ghost danger', onclick: () => { st.layers = st.layers.filter(Y => Y !== L); st.sel = st.layers[0].id; save(); drawPanels(); paint(); } }, 'Remove') : null),
        h('label', { class: 'f' }, 'Facing', seg([['front', 'Front'], ['side', prof.bodySide?.ok ? 'Side' : 'Side (none)'], ['back', prof.bodyRear?.ok ? 'Back' : 'Back (none)']], L.view || 'front', async v => {
          if ((v === 'side' && !prof.bodySide?.ok) || (v === 'back' && !prof.bodyRear?.ok)) { toast(`No ${v} view for ${prof.name}. Generate views from one photo in Characters.`, true); drawPanels(); return; }
          const was = L.view || 'front'; L.view = v; await rigFor(prof, v);
          if ((was === 'back') !== (v === 'back')) L.pose = mirrorPose(L.pose, L.pose.x); // keep the same arm on the same side of the screen
          L.danceId = null; save(); drawPanels(); paint();
        })),
        h('p', { class: 'muted small' }, 'Only you and people who agreed (consent recorded) can be added. Side and back views are estimates unless you added real photos.')),
      sec(`Model · ${prof.name}`, false,
        h('div', { class: 'row' }, chip(prof.body.source === 'tpose-photo' ? 'T-pose photo' : prof.body.source === 'tpose-generated' ? 'T-pose (generated)' : 'original photo pose', prof.body.source?.startsWith('tpose') ? 'ok' : 'warn')),
        h('p', { class: 'muted small' }, 'A T-pose model (arms straight out) bends best into raised-arm, superhero and dance poses.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm primary', onclick: async ev => {
            ev.target.disabled = true;
            try {
              const src = prof.bodyPhoto || prof.body; if (!prof.bodyPhoto) prof.bodyPhoto = prof.body;
              prof.body = await makeTPoseModel(src, { toCanvas: blobToCanvas, Renderer: FaceRenderer }); prof.updatedAt = Date.now();
              await db.put('profiles', prof); const R = await rigFor(prof);
              for (const Y of st.layers.filter(Y => Y.profileId === prof.id && (Y.view || 'front') === 'front')) { const cur = Y.pose; Y.pose = relaxedAt(R, cur.x, lowest(fk(cur, R.I)), cur.s); Y.danceId = null; }
              save(); toast('T-pose model ready'); prof.body.issues?.forEach(i => toast(i, false, 6000));
            } catch (e) { toast('T-pose failed: ' + e.message, true); }
            drawPanels(); paint();
          } }, prof.body.source === 'tpose-generated' ? 'Regenerate T-pose' : 'Make T-pose model'),
          prof.bodyPhoto && prof.body.source?.startsWith('tpose') ? h('button', { class: 'btn sm', onclick: async () => { prof.body = prof.bodyPhoto; prof.updatedAt = Date.now(); await db.put('profiles', prof); const R = await rigFor(prof); for (const Y of st.layers.filter(Y => Y.profileId === prof.id && (Y.view || 'front') === 'front')) Y.pose = relaxedAt(R, Y.pose.x, lowest(fk(Y.pose, R.I)), Y.pose.s); save(); drawPanels(); paint(); } }, 'Use original photo') : null,
          h('a', { class: 'btn sm ghost', href: `#/character/${prof.id}` }, 'Upload a real T-pose photo'))),
      sec('Pose library', true,
        h('input', { type: 'text', id: 'pz-q', placeholder: 'Search: hero, couple, dance, flying…', value: query, oninput: e => { query = e.target.value; drawLib(); } }),
        query ? null : h('div', { class: 'row' }, ['Basics', 'Poster', 'Superhero', 'Dance', 'Everyday', 'Duo'].map(c => h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(c === cat), onclick: () => { cat = c; drawPanels(); } }, c))),
        libBox),
      sec('Pose tools', false,
        h('p', { class: 'muted small' }, 'Drag the dots: elbows/knees swing a limb, wrists/ankles bend it, neck leans, head dot turns the head, green dot moves the body. Tap another character’s dots to select them.'),
        slider('Size', L.pose.s, { min: 0.1, max: 4, step: 0.01, oninput: v => { L.pose = { ...L.pose, s: v }; save(); paint(); } }),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { const R = R_(L), cur = poseOf(L, t); setKey(L, t, relaxedAt(R, cur.x, lowest(fk(cur, R.I)), cur.s)); save(); paint(); } }, 'Reset to model pose'),
          h('button', { class: 'btn sm', onclick: () => { const cur = poseOf(L, t); setKey(L, t, mirrorPose(cur, cur.x)); save(); paint(); } }, 'Mirror'),
          h('button', { class: 'btn sm', onclick: () => { st.poses.push({ id: uid('pz'), name: `My pose ${st.poses.length + 1}`, a: { ...poseOf(L, t).a } }); save(); drawPanels(); toast('Pose saved'); } }, 'Save pose'),
          fileButton('Copy pose from photo', 'image/*', async f => {
            try { toast('Reading the pose…'); const r = await readPeople(f, 1); const cur = poseOf(L, t); const [p] = retargetFrames(r.tracks[0], R_(L).I, [cur.x, cur.y], cur.s); if (!p) throw new Error('No person found in that photo.'); setKey(L, t, p); save(); paint(); }
            catch (e) { toast(e.message, true); }
          }, { cls: 'btn sm' })),
        st.poses.length ? h('div', { class: 'row' }, st.poses.map(pz => h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, onclick: () => { const cur = poseOf(L, t); setKey(L, t, { ...cur, a: { ...pz.a } }); save(); paint(); } }, pz.name, h('button', { class: 'btn sm ghost', 'aria-label': 'Delete pose', style: { minHeight: '20px', padding: '0 4px' }, onclick: ev => { ev.stopPropagation(); st.poses = st.poses.filter(x => x !== pz); save(); drawPanels(); } }, '×')))) : null),
      sec('Dance & motion', !!d,
        h('div', { class: 'row' },
          h('select', { 'aria-label': 'Dance for this character', style: { width: 'auto', flex: 1 }, onchange: e => { L.danceId = e.target.value || null; save(); drawPanels(); paint(); } }, h('option', { value: '' }, 'Still (no dance)'), st.dances.map(x => h('option', { value: x.id, selected: x.id === L.danceId }, x.name))),
          h('button', { class: 'btn sm', onclick: () => { newDance(L, `Dance ${st.dances.length + 1}`, 'keys', [{ t: 0, pose: clone(L.pose) }]); t = 0; save(); drawPanels(); paint(); } }, '+ Keyframe dance')),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Presets:'), Object.entries(PRESETS).map(([k, pr]) => h('button', { class: 'btn sm ghost', onclick: () => { const R = R_(L), base = relaxedAt(R, L.pose.x, lowest(fk(L.pose, R.I)), L.pose.s); const nd = newDance(L, pr.name, 'preset', pr.make(R.I, base)); nd.duration = pr.duration; t = 0; save(); drawPanels(); play(); } }, pr.name))),
        h('div', { class: 'row' },
          fileButton('Learn from video', 'video/*', f => learn(f, 1), { cls: 'btn sm primary' }),
          st.layers.length > 1 ? fileButton('Learn a duet (2 dancers)', 'video/*', f => learn(f, 2), { cls: 'btn sm' }) : null,
          fileButton(music ? 'Replace music' : 'Add music', 'audio/*,video/*', async f => { try { music = await audioCtx().decodeAudioData(await f.arrayBuffer()); await db.put('renders', { id: 'studiomusic:v4', blob: f, name: f.name, at: Date.now() }); toast(`Music: ${f.name}`); drawPanels(); } catch (e) { toast('Could not read that audio: ' + e.message, true); } }, { cls: 'btn sm' }),
          music ? h('button', { class: 'btn sm ghost danger', onclick: async () => { music = null; await db.del('renders', 'studiomusic:v4'); drawPanels(); } }, 'Remove music') : null),
        anyDance() ? h('div', { class: 'row' }, h('button', { class: 'btn sm', 'aria-label': playing ? 'Pause' : 'Play', onclick: play }, playing ? '❚❚' : '▶'), tLbl) : null,
        tl,
        d && d.source !== 'video' ? h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { setKey(L, t, clone(poseOf(L, t))); save(); paint(); } }, '◆ Key here'),
          h('button', { class: 'btn sm ghost', onclick: () => { d.keys = d.keys.filter(k => Math.abs(k.t - t) >= 0.02); save(); paint(); } }, 'Delete key'),
          h('button', { class: 'btn sm ghost', onclick: () => { const ks = d.keys.filter(k => k.t < t - 0.02); if (ks.length) { t = ks[ks.length - 1].t; scrubLbl(); paint(); } } }, '← key'),
          h('button', { class: 'btn sm ghost', onclick: () => { const k = d.keys.find(k => k.t > t + 0.02); if (k) { t = k.t; scrubLbl(); paint(); } } }, 'key →')) : null,
        d?.source === 'video' ? h('button', { class: 'btn sm', onclick: () => { const step = Math.max(1, Math.round((d.fps || 30) / 6)); d.keys = d.keys.filter((_, i) => i % step === 0); d.source = 'keys'; d.ease = 'smooth'; save(); drawPanels(); paint(); } }, 'Convert to keyframes') : null,
        d ? h('div', { class: 'row' },
          d.source !== 'video' ? h('div', { style: { flex: '1 1 220px' } }, slider('Length', d.duration, { min: 0.5, max: 60, step: 0.1, fmt: v => (+v).toFixed(1) + ' s', oninput: v => { d.duration = Math.max(v, d.keys[d.keys.length - 1]?.t || 0); save(); tlDraw(); } })) : null,
          check('Loop', d.loop, v => { d.loop = v; save(); }),
          h('input', { type: 'text', id: 'dn-' + d.id, value: d.name, 'aria-label': 'Dance name', style: { width: '150px' }, oninput: e => { d.name = e.target.value; save(); } }),
          h('button', { class: 'btn sm ghost danger', onclick: async () => { if (!(await confirmBox(`Delete “${d.name}”?`))) return; st.dances = st.dances.filter(x => x !== d); st.layers.forEach(Y => { if (Y.danceId === d.id) Y.danceId = null; }); save(); drawPanels(); paint(); } }, 'Delete dance')) : null),
      sec('Scene & photo', false,
        seg(Object.entries(SIZES).map(([k, v]) => [k, v[2]]), st.size, async v => { const [nw, nh] = SIZES[v], sx = nw / W, sy = nh / H, k = Math.min(sx, sy); const fix = p => ({ ...p, x: p.x * sx, y: p.y * sy, s: p.s * k }); st.layers.forEach(Y => (Y.pose = fix(Y.pose))); st.dances.forEach(D => { D.origin = { ...D.origin, x: D.origin.x * sx, y: D.origin.y * sy, s: D.origin.s * k, torsoPx: D.origin.torsoPx * k }; D.keys.forEach(q => (q.pose = fix(q.pose))); }); st.size = v; W = nw; H = nh; gl.resize(W, H); for (const c of [out, bgC, blank, layerC, view]) { c.width = W; c.height = H; } save(); paint(); }),
        seg([['color', 'Colour'], ['image', 'Photo'], ['video', 'Video']], st.bg.type, async v => { st.bg.type = v; save(); await loadBg(); drawPanels(); paint(); }),
        h('div', { class: 'row' }, h('input', { type: 'color', value: st.bg.color, 'aria-label': 'Background colour', oninput: e => { st.bg.color = e.target.value; save(); paint(); } }),
          st.bg.type !== 'color' ? fileButton(st.bg.type === 'image' ? 'Choose photo' : 'Choose video', st.bg.type === 'image' ? 'image/*' : 'video/*', async f => { await db.put('renders', { id: 'studiobg:v4', blob: f, name: f.name, at: Date.now() }); await db.del('renders', 'studiobg:v4:orig'); await loadBg(); drawPanels(); paint(); }, { cls: 'btn sm' }) : null),
        st.bg.type === 'image' && bgImg ? h('div', { class: 'stack' },
          h('h3', null, 'Put me into this photo'),
          h('p', { class: 'muted small' }, 'Finds the biggest person in the photo and puts the selected character in their exact spot, size and pose. Then paint them out so only you remain.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn sm primary', onclick: ev => matchPerson(ev.target) }, 'Match the person in the photo'),
            h('button', { class: 'btn sm', onclick: ev => paintOut(ev.target) }, 'Paint out the original person'),
            h('button', { class: 'btn sm ghost', onclick: async () => { const o = await db.get('renders', 'studiobg:v4:orig'); if (!o) { toast('Nothing to undo'); return; } await db.put('renders', { ...o, id: 'studiobg:v4' }); await db.del('renders', 'studiobg:v4:orig'); await loadBg(); paint(); } }, 'Undo paint-out')),
          h('p', { class: 'muted small' }, 'Paint-out fills the gap with colours from around the person, so busy backgrounds can look smeared behind you.')) : null),
      sec('Look & effects', false,
        h('label', { class: 'f' }, 'Colour grade', h('select', { onchange: e => { st.look.grade = e.target.value; save(); paint(); } }, Object.entries(GRADES).map(([k, g]) => h('option', { value: k, selected: k === st.look.grade }, g.name)))),
        slider('Grade strength', st.look.amount, { min: 0, max: 1, step: 0.05, oninput: v => { st.look.amount = v; save(); paint(); } }),
        slider('Vignette', st.look.vignette, { min: 0, max: 1, step: 0.05, oninput: v => { st.look.vignette = v; save(); paint(); } }),
        h('div', { class: 'row' }, check('Cinema bars', st.look.bars, v => { st.look.bars = v; save(); paint(); }), check('Ground shadow', st.look.shadow, v => { st.look.shadow = v; save(); paint(); })),
        h('h3', null, `Effects on ${prof.name}`),
        ...L.fx.map((f, i) => h('div', { class: 'row' }, chip(FX_TYPES[f.type] || f.type, 'v'), f.type !== 'aura' ? h('select', { 'aria-label': 'Effect position', style: { width: 'auto' }, onchange: e => { f.joint = e.target.value; save(); paint(); } }, Object.entries(FX_JOINTS).map(([k, v]) => h('option', { value: k, selected: k === f.joint }, v))) : null,
          h('input', { type: 'color', value: f.color || '#9fd8ff', 'aria-label': 'Effect colour', oninput: e => { f.color = e.target.value; save(); paint(); } }),
          h('div', { style: { flex: '1 1 140px' } }, slider('Size', f.size ?? 1, { min: 0.3, max: 3, step: 0.05, oninput: v => { f.size = v; save(); paint(); } })),
          h('button', { class: 'btn sm ghost danger', onclick: () => { L.fx.splice(i, 1); save(); drawPanels(); paint(); } }, '×'))),
        h('select', { 'aria-label': 'Add effect', onchange: e => { if (!e.target.value) return; L.fx.push({ type: e.target.value, joint: e.target.value === 'shock' || e.target.value === 'trail' ? 'feet' : 'handR', color: '#9fd8ff', size: 1 }); save(); drawPanels(); paint(); } }, h('option', { value: '' }, '+ Add effect'), Object.entries(FX_TYPES).map(([k, v]) => h('option', { value: k }, v)))),
      sec('Poster text', false,
        ...[['title', 'Title'], ['tagline', 'Tagline'], ['date', 'Date line (e.g. “Coming this summer”)'], ['credits', 'Credits block']].map(([k, l]) => h('label', { class: 'f' }, l, k === 'credits' ? h('textarea', { id: 'pt-' + k, rows: 2, value: st.text[k], oninput: e => { st.text[k] = e.target.value; save(); paint(); } }) : h('input', { type: 'text', id: 'pt-' + k, value: st.text[k], oninput: e => { st.text[k] = e.target.value; save(); paint(); } }))),
        h('div', { class: 'row' }, seg([['top', 'Top'], ['bottom', 'Bottom']], st.text.pos, v => { st.text.pos = v; save(); paint(); }),
          h('select', { 'aria-label': 'Title font', style: { width: 'auto' }, onchange: e => { st.text.font = e.target.value; save(); paint(); } }, Object.keys(TITLE_FONTS).map(k => h('option', { value: k, selected: k === st.text.font }, k[0].toUpperCase() + k.slice(1)))),
          h('input', { type: 'color', value: st.text.color, 'aria-label': 'Text colour', oninput: e => { st.text.color = e.target.value; save(); paint(); } })),
        h('p', { class: 'muted small' }, 'Use your own titles. Do not use studio logos or real film names you do not own.')),
    );
    drawLib(libResults); scrubLbl();
  };
  const libBox = h('div', { class: 'stack' });
  const drawLib = (res = query ? searchPoses(query) : { solo: POSES.filter(p => p.cat === cat), duo: cat === 'Duo' ? DUOS : [] }) => {
    const L = sel();
    libBox.replaceChildren(
      res.solo.length ? h('div', { class: 'row' }, res.solo.map(p => h('button', { class: 'btn sm', onclick: () => { applySolo(L, p); save(); drawPanels(); paint(); } }, p.name, p.fx ? ' ✦' : ''))) : null,
      res.duo.length ? h('div', { class: 'stack' }, h('p', { class: 'small muted' }, st.layers.length > 1 ? 'Two-person scenes use the selected character and the next one.' : 'Add a second character in Cast to use these.'),
        h('div', { class: 'row' }, res.duo.map(dd => h('button', { class: 'btn sm', disabled: st.layers.length < 2, onclick: async () => { await applyDuo(dd); save(); drawPanels(); paint(); } }, `${dd.cat}: ${dd.name}`)))) : null,
      !res.solo.length && !res.duo.length ? h('p', { class: 'muted small' }, 'No poses match. Try “hero”, “dance”, “couple” or “fly”.') : null,
      cat === 'Duo' || query ? h('p', { class: 'muted small' }, 'Both models are front-facing photos, so two-person scenes are side by side. Face-to-face moments (kissing, dancing chest to chest) need side-view models, which is on the roadmap.') : null);
  };

  const learn = async (f, n) => {
    const bar = progressBar(), msg = h('p', { class: 'small muted mono' }, 'Reading the dancers…'), ctrl = new AbortController();
    const box = h('div', { class: 'modal' }, h('div', { class: 'box' }, h('h2', null, n > 1 ? 'Learning the duet' : 'Learning the dance'), bar, msg, h('button', { class: 'btn', onclick: () => ctrl.abort() }, 'Cancel')));
    document.body.appendChild(box);
    try {
      const r = await readPeople(f, n, (a, b) => { bar.set(a / b); msg.textContent = `Frame ${a}/${b}`; }, ctrl.signal);
      const targets = n > 1 ? [...st.layers].sort((a, b) => a.pose.x - b.pose.x).slice(0, n) : [sel()];
      const name = (f.name || 'Video dance').replace(/\.\w+$/, '').slice(0, 26);
      let audioId = null;
      for (let i = 0; i < targets.length; i++) {
        const tr = r.tracks[i], found = tr.filter(Boolean).length; if (found < 3) throw new Error(`Dancer ${i + 1} was not found in that video.`);
        const L = targets[i], R = R_(L), poses = retargetFrames(tr, R.I, [L.pose.x, L.pose.y], L.pose.s);
        const nd = newDance(L, n > 1 ? `${name} (${i ? 'right' : 'left'})` : name, 'video', poses.map((p, k) => p && { t: k / r.plan.fps, pose: p }).filter(Boolean), { loop: false, ease: 'linear', fps: r.plan.fps, hasAudio: r.meta.audio?.length > 0 });
        nd.duration = r.plan.frames / r.plan.fps;
        if (i === 0) { audioId = nd.id; await db.put('renders', { id: 'dancevid:' + nd.id, blob: f, name: f.name, at: Date.now() }); }
        nd.audioFrom = audioId;
      }
      t = 0; save(); toast(n > 1 ? 'Duet learned' : 'Dance learned');
    } catch (e) { if (e.message !== 'Cancelled') toast('Could not learn the dance: ' + e.message, true, 7000); }
    box.remove(); drawPanels(); paint();
  };

  const matchPerson = async btn => {
    btn.disabled = true;
    try {
      const rec = await db.get('renders', 'studiobg:v4'); if (!rec?.blob) throw new Error('Choose a background photo first.');
      const r = await readPeople(new File([rec.blob], rec.name || 'bg.jpg', { type: rec.blob.type }), 1);
      const f = r.tracks[0][0]; if (!f) throw new Error('No person found in the photo.');
      const img = await blobToCanvas(rec.blob, 3000), m = coverMap(img), k = img.width / r.plan.width;
      const idx = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28 }, J = {};
      for (const [n, i] of Object.entries(idx)) J[n] = [m.ox + f[i * 2] * k * m.s, m.oy + f[i * 2 + 1] * k * m.s];
      J.neck = [(J.lSh[0] + J.rSh[0]) / 2, (J.lSh[1] + J.rSh[1]) / 2]; J.pelvis = [(J.lHip[0] + J.rHip[0]) / 2, (J.lHip[1] + J.rHip[1]) / 2];
      const L = sel(), P = fromJoints(J, R_(L).I);
      L.danceId = null; L.pose = P; save(); drawPanels(); paint();
      toast('Placed in the person’s spot. Tap “Paint out” to remove them.');
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  };
  const paintOut = async btn => {
    btn.disabled = true;
    try {
      if (!(await hasModel('selfie'))) throw new Error('Install the Selfie Segmenter model first.');
      const rec = await db.get('renders', 'studiobg:v4'); if (!rec?.blob) throw new Error('Choose a background photo first.');
      const img = await blobToCanvas(rec.blob, 2400), w = img.width, hh = img.height, ctx = img.getContext('2d', { willReadFrequently: true });
      const seg = segment(await getTask('selfie', 'IMAGE'), img, 'IMAGE', [-1]), m = seg.masks[0], mw = seg.width, mh = seg.height;
      const d = ctx.getImageData(0, 0, w, hh).data, rgb = new Float32Array(w * hh * 3), known = new Float32Array(w * hh).fill(1);
      const pad = Math.round(Math.min(w, hh) * 0.012);
      const person = new Uint8Array(mw * mh); const pm = Math.max(1, Math.round(pad * mw / w));
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (m[y * mw + x] > 0.3) for (let yy = Math.max(0, y - pm); yy <= Math.min(mh - 1, y + pm); yy++) for (let xx = Math.max(0, x - pm); xx <= Math.min(mw - 1, x + pm); xx++) person[yy * mw + xx] = 1;
      let holes = 0;
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const i = y * w + x; rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; if (person[Math.min(mh - 1, (y * mh / hh) | 0) * mw + Math.min(mw - 1, (x * mw / w) | 0)]) { known[i] = 0; holes++; } }
      if (!holes) throw new Error('No person found to paint out.');
      const filled = pushPullFill(rgb, known, w, hh), o = ctx.createImageData(w, hh);
      for (let i = 0; i < w * hh; i++) { o.data[i * 4] = filled[i * 3]; o.data[i * 4 + 1] = filled[i * 3 + 1]; o.data[i * 4 + 2] = filled[i * 3 + 2]; o.data[i * 4 + 3] = 255; }
      ctx.putImageData(o, 0, 0);
      if (!(await db.get('renders', 'studiobg:v4:orig'))) await db.put('renders', { ...rec, id: 'studiobg:v4:orig' });
      await db.put('renders', { id: 'studiobg:v4', blob: await new Promise(r => img.toBlob(r, 'image/jpeg', 0.93)), name: 'painted-out.jpg', at: Date.now() });
      await loadBg(); paint(); toast(`Painted out ${(holes / (w * hh) * 100).toFixed(1)}% of the photo`);
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  };

  const doExport = async kind => {
    const ctrl = new AbortController(), bar = progressBar(), msg = h('p', { class: 'small muted mono' });
    exportBox.replaceChildren(h('section', { class: 'panel' }, h('h2', null, kind === 'mp4' ? 'Rendering video…' : 'Saving image…'), bar, msg, kind === 'mp4' ? h('button', { class: 'btn sm', onclick: () => ctrl.abort() }, 'Cancel') : null));
    try {
      let blob, name, mime;
      const safe = s => (s || '').replace(/[^\w-]+/g, '').slice(0, 30), who = st.layers.map(L => safe(profOf(L).name)).join('-');
      if (kind !== 'mp4') {
        await compose(t); mime = kind === 'jpg' ? 'image/jpeg' : 'image/png';
        blob = await new Promise(r => out.toBlob(r, mime, 0.94)); name = `RECAST_${who}_${safe(st.text.title) || 'Pose'}.${kind}`; bar.set(1);
      } else {
        if (!anyDance()) throw new Error('Give at least one character a dance first.');
        const fps = 30, loops = st.layers.some(L => danceOf(L)?.loop) ? st.loops : 1, total = duration() * loops, N = Math.max(1, Math.round(total * fps));
        const plan = { width: W, height: H, fps, frames: N, start: 0, end: total };
        let audioFile = null, meta = null, audioBuffer = null;
        if (music) { const len = Math.round(total * music.sampleRate), ab = new AudioBuffer({ length: len, numberOfChannels: music.numberOfChannels, sampleRate: music.sampleRate }); for (let c = 0; c < music.numberOfChannels; c++) { const s = music.getChannelData(c), dd = ab.getChannelData(c); for (let i = 0; i < len; i++) dd[i] = s[i % s.length]; } audioBuffer = ab; }
        else { const vd = st.layers.map(danceOf).find(D => D?.source === 'video' && D.hasAudio); const rec = vd && (await db.get('renders', 'dancevid:' + (vd.audioFrom || vd.id))); if (rec?.blob) { audioFile = new File([rec.blob], rec.name || 'dance.mp4', { type: rec.blob.type }); meta = await probe(audioFile); } }
        const w = new VideoWriter(out, plan); await w.start({ audioFile, meta, audioBuffer, includeAudio: !!(audioBuffer || audioFile) });
        for (let i = 0; i < N; i++) {
          if (ctrl.signal.aborted) { await w.cancel(); throw new Error('Cancelled'); }
          await compose(i / fps); await w.addFrame(i); bar.set((i + 1) / N); msg.textContent = `Frame ${i + 1}/${N}`;
          if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
        }
        msg.textContent = 'Finalizing…';
        const o = await w.finish(); blob = o.blob; mime = o.mime; name = `RECAST_${who}_${safe(st.text.title) || 'Dance'}${st.label ? '_AI-edited' : ''}.${o.ext}`;
        (w.notes || []).forEach(n => toast(n));
      }
      const url = URL.createObjectURL(blob);
      exportBox.replaceChildren(h('section', { class: 'panel' }, h('div', { class: 'row between' }, h('h2', null, 'Ready'), chip(`${(blob.size / 1048576).toFixed(1)} MB`, 'ok')),
        kind === 'mp4' ? h('video', { src: url, controls: true, playsInline: true, style: { maxHeight: '60vh', margin: '0 auto', borderRadius: '12px' } }) : h('img', { src: url, alt: 'Exported image', style: { maxHeight: '60vh', margin: '0 auto', borderRadius: '12px' } }),
        h('p', { class: 'small muted mono' }, name),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { if (!(await shareFile(blob, name, mime))) downloadBlob(blob, name); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); } } }, 'Save / Share'), h('button', { class: 'btn', onclick: () => downloadBlob(blob, name) }, 'Download'))));
    } catch (e) { exportBox.replaceChildren(note(e.message === 'Cancelled' ? 'Export cancelled.' : 'Export failed: ' + e.message, e.message === 'Cancelled' ? 'warn' : 'bad')); }
  };

  const mrec = await db.get('renders', 'studiomusic:v4').catch(() => null);
  if (mrec?.blob) try { music = await audioCtx().decodeAudioData(await mrec.blob.arrayBuffer()); } catch {}
  await loadBg(); save(); drawPanels(); paint();
  onCleanup?.(() => { playing = false; cancelAnimationFrame(raf); bgVideo?.g?.dispose(); gl.dispose(); });

  return [
    h('div', { class: 'row between' }, h('h1', null, 'Pose Studio'), h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(showRig), onclick: e => { showRig = !showRig; e.currentTarget.setAttribute('aria-pressed', String(showRig)); paint(); } }, 'Show joints')),
    h('div', { class: 'editor' },
      h('div', { class: 'stack' },
        h('div', { class: 'monitor', style: { maxWidth: H > W ? '470px' : '100%', margin: '0 auto', width: '100%' } }, view),
        h('section', { class: 'panel' }, h('h2', null, 'Export'),
          check('Add “AI-edited” label', st.label, v => { st.label = v; save(); paint(); }),
          slider('Dance loops in video', st.loops, { min: 1, max: 10, step: 1, fmt: v => `×${v}`, oninput: v => { st.loops = v; save(); } }),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => doExport('png') }, 'Image (PNG)'), h('button', { class: 'btn', onclick: () => doExport('jpg') }, 'Image (JPEG)'), h('button', { class: 'btn', onclick: () => doExport('mp4') }, 'Video (MP4)'))),
        exportBox),
      h('div', { class: 'stack side' }, panels)),
    h('p', { class: 'muted small' }, 'How it works: each character is a 2D model made from one photo with a 10-bone skeleton. Poses bend that photo, so side and back views, crossed limbs and hands can look unnatural. It does not generate new clothing or angles. Everything runs on this device.'),
  ];
}
