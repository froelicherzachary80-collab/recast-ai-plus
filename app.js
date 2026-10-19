// RECAST AI+ v0.1 — application shell and screens.
import { h, $, toast, confirmBox, slider, check, seg, chip, progressBar, fileButton, timecode, downloadBlob, shareFile, icon } from './ui.js';
import { db, uid, storageInfo, requestPersist } from './db.js';
import { MODELS, UNAVAILABLE_MODELS, modelStatus, downloadModel, importModel, deleteModel, hasModel, getTask, runtime as mpRuntime, loadVision, disposeAll } from './models.js';
import { probe, makePlan, PRESETS, VIDEO_PRESETS, FrameGrabber, verifyExport, mediabunny, isImageFile } from './media.js';
import { analyzeVideo, detectPeople } from './analysis.js';
import { trackSummary, swapTracksFrom, mergeTracks, iou } from './tracker.js';
import { buildMotion, jitter } from './smoothing.js';
import { prepareRuntime, composeFrame, drawTracking, disposeRuntime, DEFAULT_ENTRY, KEY_PROPS, outfitOn } from './compositor.js';
import { interpKeys, clamp } from './geometry.js';
import { SLOTS, VIDEO_SLOTS, analyzeReference, missingViews, extractHair, newProfile, blobToCanvas, recolorCanvas } from './profile.js';
import { renderProject } from './render.js';
import { capabilityTest, fmtBytes } from './caps.js';
import { runSelfTests } from './selftest.js';

// ───────────────────────── state ─────────────────────────
const S = {
  settings: { id: 'settings', preset: 'preview', disclosure: true, hands: false },
  profiles: [], wardrobe: [], project: null, file: null, grabber: null,
  rt: null, rtKey: '', job: null, queue: [], history: [], results: new Map(), caps: null, cleanup: [],
};
const COLORS = ['#b597ff', '#4fd1a1', '#f2b84b', '#5ec8ff', '#ff8fb1', '#c3e86b', '#ff9f5a', '#9aa7ff'];
const colorFor = id => COLORS[(id - 1) % COLORS.length];

export const MODES = [
  { key: 'face', name: 'Face Recast', status: 'functional', desc: 'Replace the face with a mesh-warped reference that follows the original expression and head pose.' },
  { key: 'hairface', name: 'Hair & Face Recast', status: 'functional', desc: 'Face replacement plus a hair layer cut from your photo. Needs the Multiclass model. Original hair outside the overlay can still show.' },
  { key: 'wardrobe', name: 'Wardrobe Recast', status: 'basic', desc: 'Pose-aligned garment overlays and clothing recolor on the tracked actor. Sleeves do not follow arms in v0.1.' },
  { key: 'full', name: 'Full Recast', status: 'experimental', desc: 'Face + hair + garments together. No body reshaping or background reconstruction in v0.1.' },
  { key: 'group', name: 'Group Recast', status: 'functional', desc: 'Different characters for several actors, rendered sequentially per frame.' },
  { key: 'performance', name: 'Performance Match', status: 'functional', desc: 'Lightest smoothing and full expression transfer: exact source timing over polish.' },
  { key: 'manual', name: 'Manual VFX Recast', status: 'partial', desc: 'Keyframes, restore brush, per-frame overrides. Mesh deformation handles are V0.2.' },
];
const statusChip = s => chip(s, s === 'functional' ? 'ok' : s === 'basic' || s === 'partial' ? 'v' : s === 'experimental' ? 'warn' : 'bad');
const STEPS = [['import', 'Source'], ['actors', 'Actors'], ['cast', 'Cast'], ['motion', 'MotionLock'], ['editor', 'Editor'], ['render', 'Render'], ['export', 'Export']];

// ───────────────────────── boot ─────────────────────────
async function boot() {
  try { const s = await db.get('kv', 'settings'); if (s) Object.assign(S.settings, s); } catch {}
  await reloadLibrary();
  window.addEventListener('hashchange', route);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  route();
}
async function reloadLibrary() {
  try { S.profiles = (await db.all('profiles')).sort((a, b) => a.createdAt - b.createdAt); } catch { S.profiles = []; }
  try { S.wardrobe = (await db.all('wardrobe')).sort((a, b) => a.createdAt - b.createdAt); } catch { S.wardrobe = []; }
}
const saveSettings = () => db.put('kv', S.settings).catch(() => {});
let saveT = null;
function saveProject(now = false) {
  if (!S.project) return;
  clearTimeout(saveT);
  const p = S.project; p.updatedAt = Date.now();
  const doSave = () => db.put('projects', p).catch(e => toast('Could not save project: ' + e.message, true));
  if (now) return doSave();
  saveT = setTimeout(doSave, 350);
}
async function openProject(id) {
  if (S.project?.id === id && S.file) return S.project;
  S.grabber?.dispose(); S.grabber = null; dropRuntime();
  const p = await db.get('projects', id);
  if (!p) throw new Error('Project not found on this device.');
  const src = await db.get('renders', 'src:' + id);
  S.project = p; S.file = src?.blob ? new File([src.blob], p.sourceName || 'source.mp4', { type: src.blob.type }) : null;
  return p;
}
async function grabber() {
  const p = S.project;
  if (!S.grabber) S.grabber = await new FrameGrabber(S.file, p.meta, p.plan).init();
  return S.grabber;
}
function dropRuntime() { if (S.rt) disposeRuntime(S.rt); S.rt = null; S.rtKey = ''; }
const motionParams = () => S.project.motion || { minCutoff: 1.2, beta: 0.02, maxGap: 6 };
async function getRuntime() {
  const p = S.project;
  const key = JSON.stringify({
    cast: p.cast.map(e => [e.id, e.trackId, e.profileId, e.hair.on, e.top.garmentId, e.top.clip, e.bottom.garmentId, e.bottom.clip, e.recolor.on]),
    prof: p.cast.map(e => { const pr = S.profiles.find(x => x.id === e.profileId); return pr ? [pr.updatedAt || pr.createdAt, pr.consent ? 1 : 0] : 0; }),
    ward: S.wardrobe.map(w => [w.id, w.updatedAt || w.createdAt]), m: motionParams(), a: p.analysis?.at,
  });
  if (S.rt && S.rtKey === key) return S.rt;
  dropRuntime();
  S.rt = await prepareRuntime(p, { profiles: S.profiles, wardrobe: S.wardrobe, analysis: p.analysis, motionParams: motionParams() });
  S.rtKey = key;
  return S.rt;
}

// ───────────────────────── chrome ─────────────────────────
function setTop(title, back) {
  S.top = [title, back];
  const tb = $('#topbar');
  tb.replaceChildren(
    back ? h('a', { class: 'iconbtn', href: back, 'aria-label': 'Back' }, icon('back')) : null,
    h('a', { class: 'brand', href: '#/' }, 'RECAST', h('b', null, ' AI+')),
    h('div', { class: 'ctx' }, title || ''),
    S.job ? h('a', { class: 'chip v', href: '#/queue' }, `Rendering ${Math.round((S.job.progress || 0) * 100)}%`) : null);
}
function setTabs(active) {
  const tabs = [['home', '#/', 'Studio'], ['cast', '#/library', 'Characters'], ['shirt', '#/wardrobe', 'Wardrobe'], ['chip', '#/models', 'Models'], ['gear', '#/settings', 'Settings']];
  $('#tabs').replaceChildren(...tabs.map(([ic, href, label]) => h('a', { href, class: active === href ? 'on' : '' }, icon(ic), label)));
}
function steps(pid, cur) {
  const p = S.project, idx = STEPS.findIndex(s => s[0] === cur);
  const done = { import: !!p.meta, actors: !!p.analysis, cast: p.cast.some(e => e.profileId), motion: !!p.analysis, editor: !!p.analysis, render: !!S.results.get(pid), export: !!p.export };
  const list = p.meta?.kind === 'photo' ? STEPS.filter(s => s[0] !== 'motion') : STEPS;
  return h('nav', { class: 'steps', 'aria-label': 'Recast steps' }, list.map(([k, l], i) => h('a', { href: `#/p/${pid}/${k}`, class: (k === cur ? 'on' : done[k] ? 'done' : ''), 'aria-current': k === cur ? 'step' : null }, h('span', { class: 'n' }, i + 1), l)));
}
const callout = (txt, kind = '') => h('div', { class: 'note ' + kind }, txt);
const panel = (...kids) => h('section', { class: 'panel' }, ...kids);

async function route() {
  for (const fn of S.cleanup.splice(0)) { try { fn(); } catch {} }
  const hash = location.hash || '#/';
  const view = $('#view');
  const table = [
    [/^#\/?$/, () => dashboard(), '#/'],
    [/^#\/new$/, () => newProject(), '#/'],
    [/^#\/p\/([^/]+)\/(\w+)$/, m => projectScreen(m[1], m[2]), '#/'],
    [/^#\/library$/, () => library(), '#/library'],
    [/^#\/character\/([^/]+)$/, m => characterBuilder(m[1]), '#/library'],
    [/^#\/wardrobe(?:\/([^/]+))?$/, m => wardrobeStudio(m[1]), '#/wardrobe'],
    [/^#\/queue$/, () => renderQueue(), '#/'],
    [/^#\/models$/, () => modelManager(), '#/models'],
    [/^#\/settings$/, () => settingsScreen(), '#/settings'],
  ];
  for (const [re, fn, tab] of table) {
    const m = hash.match(re);
    if (!m) continue;
    setTabs(tab);
    try { const el = await fn(m); view.replaceChildren(...[el].flat()); }
    catch (e) { console.error(e); view.replaceChildren(panel(h('h2', null, 'Something went wrong'), h('p', { class: 'muted' }, String(e?.message || e)), h('a', { class: 'btn', href: '#/' }, 'Back to Studio'))); }
    window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}

// ───────────────────────── 1. Dashboard ─────────────────────────
async function dashboard() {
  setTop('Studio');
  const projects = (await db.all('projects')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const ms = await modelStatus();
  const missing = MODELS.filter(m => m.required && !ms[m.key]);
  const list = h('div', { class: 'stack' });
  if (!projects.length) list.append(h('p', { class: 'muted' }, 'No projects yet. Start with a short clip (5–15 s) where the actor’s face is clearly visible.'));
  for (const p of projects) {
    const status = p.export ? chip('exported', 'ok') : p.analysis ? chip('tracked', 'v') : p.meta ? chip('imported') : chip('empty');
    list.append(h('div', { class: 'item' },
      h('div', { class: 'thumb', style: { backgroundImage: p.thumb ? `url(${p.thumb})` : '' } }),
      h('div', { class: 't' }, h('h3', null, p.name), h('div', { class: 'row small muted' }, MODES.find(m => m.key === p.mode)?.name || p.mode, status, p.meta ? h('span', { class: 'mono' }, `${p.plan?.width}×${p.plan?.height} · ${(p.plan?.end - p.plan?.start).toFixed(1)}s`) : null)),
      h('div', { class: 'row' },
        h('a', { class: 'btn sm primary', href: `#/p/${p.id}/${p.analysis ? 'editor' : 'import'}` }, 'Open'),
        h('button', { class: 'btn sm ghost danger', 'aria-label': 'Delete project', onclick: async () => {
          if (!(await confirmBox(`Delete “${p.name}”?`, 'The source copy, tracking data and exports stored on this device are removed. Your original video in Photos is not touched.'))) return;
          await db.del('projects', p.id); await db.del('renders', 'src:' + p.id); await db.del('renders', 'out:' + p.id);
          if (S.project?.id === p.id) { S.project = null; S.file = null; }
          toast('Project deleted'); route();
        } }, 'Delete'))));
  }
  return [
    h('div', { class: 'hero-slate' }, h('span', { class: 'eyebrow' }, 'Private · on-device · v0.1'), h('h1', null, 'Put yourself in the scene, or on the poster.')),
    h('a', { class: 'create', href: '#/new' }, h('span', { class: 'plus' }, '+ CREATE NEW RECAST'), h('span', { class: 'muted small' }, 'Video scene or photo poster → actor → your photos → export')),
    missing.length ? callout(h('span', null, 'Install the required models first: ', missing.map(m => m.name).join(', '), '. ', h('a', { href: '#/models' }, 'Open Model Manager')), 'warn') : null,
    panel(h('div', { class: 'row between' }, h('h2', null, 'Projects'), h('div', { class: 'row' }, fileButton('Import project', '.json,application/json', importProjectFile, { cls: 'btn sm ghost' }), h('a', { class: 'btn sm ghost', href: '#/queue' }, 'Render queue'))), list),
    h('div', { class: 'grid2' },
      panel(h('h3', null, 'Characters'), h('p', { class: 'muted small' }, `${S.profiles.length} saved locally. Start with “Myself”.`), h('a', { class: 'btn sm', href: '#/library' }, 'Character Library')),
      panel(h('h3', null, 'This device'), h('p', { class: 'muted small' }, 'Check WebGPU, codecs, storage and model start-up before your first render.'), h('a', { class: 'btn sm', href: '#/settings' }, 'Run capability test'))),
  ];
}

async function importProjectFile(f) {
  try {
    const d = JSON.parse(await f.text()); if (d.format !== 'recast-project') throw new Error('Not a RECAST project file');
    const p = deserialize(d.project); p.id = uid('r'); p.name += ' (imported)'; p.updatedAt = Date.now(); p.export = null;
    if (d.source) await db.put('renders', { id: 'src:' + p.id, blob: await b64ToBlob(d.source.b64, d.source.type), at: Date.now() });
    await db.put('projects', p);
    const missingProf = p.cast.filter(e => e.profileId && !S.profiles.some(x => x.id === e.profileId)).length;
    toast(`Imported ${p.name}${missingProf ? ` · ${missingProf} cast character(s) not on this device: import their profiles or recast` : ''}`, false, 6000);
    route();
  } catch (e) { toast('Import failed: ' + e.message, true); }
}

// ───────────────────────── 2. New project ─────────────────────────
function newProject() {
  setTop('New Recast Project', '#/');
  const st = { name: 'Scene ' + new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), mode: 'face', preset: VIDEO_PRESETS.includes(S.settings.preset) ? S.settings.preset : 'preview', hair: false, outfit: false };
  const modes = h('div', { class: 'grid2' });
  const drawModes = () => modes.replaceChildren(...MODES.map(m => h('button', { type: 'button', class: 'panel', style: { textAlign: 'left', cursor: 'pointer', borderColor: st.mode === m.key ? 'var(--violet)' : '' }, 'aria-pressed': String(st.mode === m.key), onclick: () => { st.mode = m.key; drawModes(); } },
    h('div', { class: 'row between' }, h('h3', null, m.name), statusChip(m.status)), h('p', { class: 'muted small' }, m.desc))));
  drawModes();
  const presetNote = h('p', { class: 'muted small' }, PRESETS[st.preset].note);
  return [
    h('h1', null, 'New recast'),
    panel(h('label', { class: 'f' }, 'Project name', h('input', { type: 'text', id: 'np-name', value: st.name, oninput: e => (st.name = e.target.value) }))),
    panel(h('h2', null, 'What to replace'),
      h('p', { class: 'muted small' }, 'Your face always replaces the actor’s face. Choose whether hair and clothes change too. Unchecked = the original actor’s hair or outfit stays exactly as filmed.'),
      check('Change hair to my hairstyle', st.hair, v => (st.hair = v), 'np-hair'),
      check('Change outfit (garment overlay or recolor)', st.outfit, v => (st.outfit = v), 'np-outfit')),
    panel(h('h2', null, 'Recast mode'), modes),
    panel(h('h2', null, 'Video preset'), h('p', { class: 'muted small' }, 'Photos and posters always process at full resolution (up to 3072px).'), seg(VIDEO_PRESETS.map(k => [k, PRESETS[k].label]), st.preset, k => { st.preset = k; presetNote.textContent = PRESETS[k].note; }), presetNote),
    h('button', { class: 'btn primary block', onclick: async () => {
      const id = uid('r');
      const p = { id, name: st.name.trim() || 'Untitled scene', mode: st.mode, preset: st.preset, defaults: { hair: st.hair, outfit: st.outfit }, createdAt: Date.now(), updatedAt: Date.now(), cast: [], selected: [], restore: [], motion: st.mode === 'performance' ? { minCutoff: 3.5, beta: 0.05, maxGap: 3 } : { minCutoff: 1.2, beta: 0.02, maxGap: 6 } };
      await db.put('projects', p);
      S.project = p; S.file = null; S.grabber = null; dropRuntime();
      location.hash = `#/p/${id}/import`;
    } }, 'Create project'),
  ];
}

// ───────────────────────── project router ─────────────────────────
async function projectScreen(pid, step) {
  const p = await openProject(pid);
  const need = { actors: 'meta', cast: 'analysis', motion: 'analysis', editor: 'analysis', render: 'analysis', export: null };
  if (step !== 'import' && step !== 'export' && !p.meta) { location.hash = `#/p/${pid}/import`; return []; }
  if (need[step] === 'analysis' && !p.analysis) return [steps(pid, step), callout('Run actor detection first.', 'warn'), h('a', { class: 'btn primary', href: `#/p/${pid}/actors` }, 'Go to Actor Detection')];
  const fn = { import: importScreen, actors: actorsScreen, cast: castScreen, motion: motionScreen, editor: editorScreen, render: renderScreen, export: exportScreen }[step];
  if (!fn) throw new Error('Unknown step ' + step);
  setTop(p.name, '#/');
  return [steps(pid, step), ...[await fn(p)].flat()];
}

// ───────────────────────── 3. Source import ─────────────────────────
async function importScreen(p) {
  const wrap = h('div', { class: 'stack' });
  const draw = async () => {
    const parts = [];
    const pick = async (file) => {
      if (!file) return;
      const photo = isImageFile(file);
      if (!photo && !/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) { toast('Choose a video (MP4/MOV) or a photo (JPEG/PNG/HEIC).', true); return; }
      wrap.replaceChildren(panel(h('p', null, 'Reading ', h('b', null, file.name), '…')));
      try {
        const meta = await probe(file);
        if (!meta.width || !meta.duration) throw new Error('This browser could not read the file. Try H.264 MP4 for video or JPEG for photos.');
        if (meta.kind === 'photo') p.preset = 'photo'; else if (p.preset === 'photo') p.preset = 'preview';
        await db.put('renders', { id: 'src:' + p.id, blob: file, at: Date.now() });
        Object.assign(p, { meta, sourceName: file.name, trim: { start: 0, end: meta.duration }, analysis: null, export: null, selected: [] });
        p.plan = makePlan(meta, p.trim, p.preset);
        S.file = file; S.grabber?.dispose(); S.grabber = null; dropRuntime(); S.results.delete(p.id);
        await saveProject(true);
        try { const g = await grabber(); const c = await g.get(0); const t = document.createElement('canvas'); t.width = 120; t.height = Math.round(120 * c.height / c.width); t.getContext('2d').drawImage(c, 0, 0, t.width, t.height); p.thumb = t.toDataURL('image/jpeg', 0.7); saveProject(); } catch {}
        draw();
      } catch (e) { toast(e.message, true); draw(); }
    };
    const drop = h('label', { class: 'drop', style: { position: 'relative' }, ondragover: e => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'), ondrop: e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); } },
      h('h2', null, p.meta ? 'Replace source' : 'Import a scene or a poster'),
      h('p', { class: 'muted small' }, 'A video (MP4, MOV) to recast a scene, or a photo (JPEG, PNG, HEIC) to make a poster. From Photos, Files or the camera; drag and drop on desktop.'),
      h('span', { class: 'btn primary' }, 'Choose video or photo'),
      h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/*,image/*', 'aria-label': 'Choose video or photo', style: { position: 'absolute', inset: '0', opacity: '0', width: '100%', cursor: 'pointer' }, onchange: e => pick(e.target.files[0]) }));
    parts.push(drop);
    parts.push(h('p', { class: 'muted small' }, 'Only recast footage you have the right to edit, and only with the consent of anyone whose likeness you add.'));
    if (p.meta && S.file && p.meta.kind === 'photo') {
      const m = p.meta, url = URL.createObjectURL(S.file); S.cleanup.push(() => URL.revokeObjectURL(url));
      p.plan = makePlan(m, null, 'photo');
      parts.push(
        h('div', { class: 'monitor' }, h('img', { src: url, alt: 'Source photo', style: { maxHeight: '62vh', objectFit: 'contain' } }), h('div', { class: 'tag' }, 'POSTER')),
        panel(h('h2', null, 'Source photo'),
          h('dl', { class: 'kv' }, h('dt', null, 'File'), h('dd', null, `${m.name} · ${fmtBytes(m.size)}`), h('dt', null, 'Resolution'), h('dd', null, `${m.width}×${m.height} (${m.orientation})`), h('dt', null, 'Format'), h('dd', null, m.codec), h('dt', null, 'Processing'), h('dd', null, `${p.plan.width}×${p.plan.height}`)),
          ...p.plan.notes.map(n => callout(n, 'warn'))),
        h('a', { class: 'btn primary block', href: `#/p/${p.id}/actors` }, 'Next: detect actors'));
    } else if (p.meta && S.file) {
      const m = p.meta, url = URL.createObjectURL(S.file); S.cleanup.push(() => URL.revokeObjectURL(url));
      const video = h('video', { src: url, controls: true, playsInline: true, muted: false, preload: 'metadata' });
      const planBox = h('div', { class: 'stack' });
      const drawPlan = () => {
        p.plan = makePlan(m, p.trim, p.preset);
        planBox.replaceChildren(
          h('dl', { class: 'kv' }, h('dt', null, 'Processing'), h('dd', null, `${p.plan.width}×${p.plan.height} @ ${p.plan.fps.toFixed(2)} fps · ${p.plan.frames} frames`), h('dt', null, 'Range'), h('dd', null, `${p.plan.start.toFixed(2)}s → ${p.plan.end.toFixed(2)}s`)),
          ...p.plan.notes.map(n => callout(n, 'warn')));
      };
      const inLbl = h('output', { class: 'mono' }), outLbl = h('output', { class: 'mono' });
      const fmtT = t => `${t.toFixed(2)}s`;
      const trimIn = h('input', { type: 'range', min: 0, max: m.duration, step: 0.01, value: p.trim.start, 'aria-label': 'Trim start', oninput: e => { p.trim.start = Math.min(+e.target.value, p.trim.end - 0.2); inLbl.textContent = fmtT(p.trim.start); video.currentTime = p.trim.start; drawPlan(); invalidate(); } });
      const trimOut = h('input', { type: 'range', min: 0, max: m.duration, step: 0.01, value: p.trim.end, 'aria-label': 'Trim end', oninput: e => { p.trim.end = Math.max(+e.target.value, p.trim.start + 0.2); outLbl.textContent = fmtT(p.trim.end); video.currentTime = p.trim.end; drawPlan(); invalidate(); } });
      inLbl.textContent = fmtT(p.trim.start); outLbl.textContent = fmtT(p.trim.end);
      const invalidate = () => { if (p.analysis) { p.analysis = null; toast('Trim changed: tracking will need to run again.'); } S.grabber?.dispose(); S.grabber = null; dropRuntime(); saveProject(); };
      const thumbs = h('div', { class: 'thumbs' });
      (async () => { // real thumbnails decoded from the file
        const g = await new FrameGrabber(S.file, m, { ...makePlan(m, null, 'preview'), start: 0, end: m.duration, fps: 8 / m.duration, frames: 8, width: 160, height: Math.round(160 * m.height / m.width / 2) * 2 }).init();
        for (let i = 0; i < 8; i++) { const c = await g.get(i); const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; t.getContext('2d').drawImage(c, 0, 0); thumbs.append(t); }
        g.dispose();
      })().catch(() => {});
      drawPlan();
      parts.push(
        h('div', { class: 'monitor' }, video),
        thumbs,
        panel(h('h2', null, 'Trim'),
          h('div', { class: 'slider' }, h('span', null, 'In'), trimIn, inLbl),
          h('div', { class: 'slider' }, h('span', null, 'Out'), trimOut, outLbl),
          h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { trimIn.value = video.currentTime; trimIn.dispatchEvent(new Event('input')); } }, 'Set In at playhead'), h('button', { class: 'btn sm', onclick: () => { trimOut.value = video.currentTime; trimOut.dispatchEvent(new Event('input')); } }, 'Set Out at playhead'))),
        panel(h('h2', null, 'Source'),
          h('dl', { class: 'kv' },
            h('dt', null, 'File'), h('dd', null, `${m.name} · ${fmtBytes(m.size)}`),
            h('dt', null, 'Resolution'), h('dd', null, `${m.width}×${m.height} (${m.orientation})${m.rotation ? ` · rotated ${m.rotation}°` : ''}`),
            h('dt', null, 'Frame rate'), h('dd', null, `${m.fps.toFixed(3)} fps${m.fpsGuessed ? ' (assumed: file did not report it)' : ''}`),
            h('dt', null, 'Duration'), h('dd', null, `${m.duration.toFixed(3)} s`),
            h('dt', null, 'Video codec'), h('dd', null, m.codec),
            h('dt', null, 'Audio tracks'), h('dd', null, m.audio.length ? m.audio.map(a => `${a.codec} ${a.channels}ch ${a.sampleRate} Hz`).join(', ') : 'none'),
            h('dt', null, 'Decoder'), h('dd', null, m.engine === 'mediabunny' ? 'WebCodecs (Mediabunny)' : '<video> element seeking (slower)')),
          m.mbError ? callout('WebCodecs path unavailable: ' + m.mbError, 'warn') : null),
        panel(h('h2', null, 'Processing preset'), seg(VIDEO_PRESETS.map(k => [k, PRESETS[k].label]), p.preset, k => { p.preset = k; drawPlan(); invalidate(); }), planBox),
        h('a', { class: 'btn primary block', href: `#/p/${p.id}/actors` }, 'Next: detect actors'));
    }
    wrap.replaceChildren(...parts);
  };
  await draw();
  return wrap;
}

// ───────────────────────── 4. Actor detection ─────────────────────────
async function actorsScreen(p) {
  const ms = await modelStatus();
  const need = ['pose_lite', 'face'].filter(k => !ms[k]);
  const wrap = h('div', { class: 'stack' });
  if (need.length) return [callout(h('span', null, 'Actor detection needs: ', need.map(k => MODELS.find(m => m.key === k).name).join(' and '), '. ', h('a', { href: '#/models' }, 'Install in Model Manager')), 'warn')];
  const prog = progressBar(), progTxt = h('p', { class: 'muted small mono' });
  let ctrl = null;
  const runBtn = h('button', { class: 'btn primary', onclick: async () => {
    ctrl = new AbortController(); runBtn.disabled = true; cancelBtn.hidden = false;
    try {
      const res = await analyzeVideo(S.file, p.meta, p.plan, { signal: ctrl.signal, hands: S.settings.hands, poseModel: PRESETS[p.preset].pose, onProgress: (d, t, info) => { prog.set(d / t); progTxt.textContent = `Frame ${d} / ${t} · ${info.people} people · ${info.fps.toFixed(1)} frames/s`; } });
      if (res.cancelled) { toast('Detection cancelled. Nothing was saved.'); }
      else {
        p.analysis = res; const sum = trackSummary(res.frames);
        if (!p.selected?.length && sum[0]) p.selected = [sum[0].id];
        dropRuntime(); await saveProject(true);
        toast(`Tracked ${sum.length} actor${sum.length === 1 ? '' : 's'} across ${res.completed} frames`);
      }
    } catch (e) { console.error(e); toast('Detection failed: ' + e.message, true); }
    runBtn.disabled = false; cancelBtn.hidden = true; draw();
  } }, p.analysis ? 'Run detection again' : 'Detect actors');
  const cancelBtn = h('button', { class: 'btn', hidden: true, onclick: () => ctrl?.abort() }, 'Cancel');
  const draw = async () => {
    const parts = [panel(h('h2', null, 'Actor detection'),
      h('p', { class: 'muted small' }, `Runs ${MODELS.find(m => m.key === (p.analysis?.poseModel || PRESETS[p.preset].pose))?.name || 'Pose'} + Face Landmarker on all ${p.plan.frames} frames on this device.`),
      check('Also track hands (Gesture MotionLock overlay, slower)', S.settings.hands, v => { S.settings.hands = v; saveSettings(); }),
      h('div', { class: 'row' }, runBtn, cancelBtn), prog, progTxt)];
    if (p.analysis) {
      const g = await grabber();
      let k = 0;
      const cv = h('canvas', { width: p.plan.width, height: p.plan.height, 'aria-label': 'Tracking preview. Tap a person to select or deselect them.' });
      const tc = h('div', { class: 'tc' });
      const paint = async () => {
        const src = await g.get(k); const ctx = cv.getContext('2d'); ctx.drawImage(src, 0, 0);
        drawTracking(ctx, p.analysis.frames[k], p.plan.width, p.plan.height, { selected: p.selected, colors: colorFor });
        tc.textContent = `${timecode(k, p.plan.fps)} · F${k}`;
      };
      cv.addEventListener('click', e => {
        const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        const hit = p.analysis.frames[k].people.filter(q => x >= q.bbox[0] && x <= q.bbox[2] && y >= q.bbox[1] && y <= q.bbox[3]).sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0];
        if (!hit) return;
        p.selected = p.selected.includes(hit.id) ? p.selected.filter(i => i !== hit.id) : [...p.selected, hit.id];
        saveProject(); paint(); drawList();
      });
      const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: p.plan.frames - 1, value: 0, 'aria-label': 'Frame', oninput: e => { k = +e.target.value; paint(); } });
      const list = h('div', { class: 'stack' });
      const drawList = () => {
        const sum = trackSummary(p.analysis.frames);
        const ids = sum.map(s => s.id);
        list.replaceChildren(...sum.map(s => {
          const cov = h('canvas', { class: 'coverage', width: 600, height: 26 });
          const c = cov.getContext('2d'); const N = p.analysis.frames.length;
          p.analysis.frames.forEach((fr, i) => { const q = fr.people.find(x => x.id === s.id); if (!q) return; c.fillStyle = colorFor(s.id); c.fillRect(i / N * 600, q.face ? 0 : 13, Math.max(1, 600 / N), q.face ? 26 : 13); });
          const sel = p.selected.includes(s.id);
          const other = ids.filter(i => i !== s.id);
          return h('div', { class: 'panel', style: { borderColor: sel ? colorFor(s.id) : '' } },
            h('div', { class: 'row between' }, h('h3', { style: { color: colorFor(s.id) } }, `Actor ${s.id}`),
              h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(sel), onclick: () => { p.selected = sel ? p.selected.filter(i => i !== s.id) : [...p.selected, s.id]; saveProject(); drawList(); paint(); } }, sel ? 'Selected for recast' : 'Select')),
            h('p', { class: 'small muted mono' }, `${s.count}/${N} frames (${Math.round(s.count / N * 100)}%) · face on ${s.faces} · F${s.first}–F${s.last}`),
            cov,
            other.length ? h('div', { class: 'row small' },
              h('span', { class: 'muted' }, 'Fix identity:'),
              h('select', { 'aria-label': 'Swap with', style: { width: 'auto' }, onchange: e => { if (!e.target.value) return; swapTracksFrom(p.analysis.frames, s.id, +e.target.value, k); p.analysis.at = Date.now(); saveProject(); toast(`Swapped Actor ${s.id} ⇄ ${e.target.value} from F${k}`); drawList(); paint(); } }, h('option', { value: '' }, `Swap from F${k} with…`), other.map(o => h('option', { value: o }, `Actor ${o}`))),
              h('select', { 'aria-label': 'Merge into', style: { width: 'auto' }, onchange: e => { if (!e.target.value) return; mergeTracks(p.analysis.frames, s.id, +e.target.value); p.selected = p.selected.filter(i => i !== s.id); p.analysis.at = Date.now(); saveProject(); toast(`Merged Actor ${s.id} into ${e.target.value}`); drawList(); paint(); } }, h('option', { value: '' }, 'Merge into…'), other.map(o => h('option', { value: o }, `Actor ${o}`)))) : null);
        }));
        if (!sum.length) list.append(callout('No people were detected. Try a clip where the actor is larger in frame, or the Mobile Quality preset.', 'warn'));
      };
      drawList(); await paint();
      parts.push(
        h('div', { class: 'monitor' }, cv, tc, h('div', { class: 'tag' }, 'TRACKING')),
        h('div', { class: 'transport' }, h('button', { class: 'btn sm', 'aria-label': 'Previous frame', onclick: () => { k = Math.max(0, k - 1); scrub.value = k; paint(); } }, '‹'), h('button', { class: 'btn sm', 'aria-label': 'Next frame', onclick: () => { k = Math.min(p.plan.frames - 1, k + 1); scrub.value = k; paint(); } }, '›'), h('span'), scrub, h('span')),
        h('p', { class: 'muted small' }, 'Tap a person to select them. Dashed boxes are not selected. Coverage bars: full height = face found, half = body only, gap = not detected (long gaps are never invented).'),
        list,
        h('a', { class: 'btn primary block', href: `#/p/${p.id}/cast` }, `Next: cast ${p.selected.length || 0} selected actor${p.selected.length === 1 ? '' : 's'}`));
    }
    wrap.replaceChildren(...parts);
  };
  await draw();
  S.cleanup.push(() => ctrl?.abort());
  return wrap;
}

// ───────────────────────── Cast Director ─────────────────────────
function applyModeDefaults(e, mode, prof, defaults) {
  const pre = prof?.wardrobePresets || {};
  e.face.on = mode !== 'wardrobe';
  e.hair.on = defaults ? !!defaults.hair : ['hairface', 'full', 'group'].includes(mode) && !!prof?.hair;
  e.outfit = { on: defaults ? !!defaults.outfit : ['wardrobe', 'full', 'group'].includes(mode) };
  if (['wardrobe', 'full', 'group'].includes(mode)) { e.top.garmentId = pre.top || null; e.bottom.garmentId = pre.bottom || null; }
  if (mode === 'wardrobe' && !e.top.garmentId && !e.bottom.garmentId) e.recolor.on = true;
  if (mode === 'performance') { e.face.motion = 1; e.face.light = 0.4; }
}
function ensureEntries(p) {
  for (const id of p.selected) if (!p.cast.some(e => e.trackId === id)) {
    const e = DEFAULT_ENTRY(); e.trackId = id;
    const prof = S.profiles.find(x => x.self) || S.profiles[0];
    e.profileId = p.cast.length === 0 ? prof?.id || null : null;
    applyModeDefaults(e, p.mode, S.profiles.find(x => x.id === e.profileId), p.defaults);
    p.cast.push(e);
  }
}
async function castScreen(p) {
  ensureEntries(p); saveProject();
  const g = await grabber();
  const wrap = h('div', { class: 'stack' });
  const draw = async () => {
    const rows = [];
    for (const e of p.cast.filter(x => p.selected.includes(x.trackId))) {
      // actor thumbnail: crop of the frame with the best face
      const fi = p.analysis.frames.findIndex(fr => fr.people.some(q => q.id === e.trackId && q.face)) ;
      const k = fi >= 0 ? fi : p.analysis.frames.findIndex(fr => fr.people.some(q => q.id === e.trackId));
      const th = h('canvas', { width: 128, height: 128, style: { width: '64px', height: '64px', borderRadius: '10px', border: '1px solid var(--line)' } });
      if (k >= 0) g.get(k).then(src => { const q = p.analysis.frames[k].people.find(x => x.id === e.trackId); const [x0, y0, x1, y1] = q.bbox; const W = p.plan.width, H = p.plan.height; const s = Math.max((x1 - x0) * W, (y1 - y0) * H * 0.5); th.getContext('2d').drawImage(src, (x0 + x1) / 2 * W - s / 2, y0 * H, s, s, 0, 0, 128, 128); });
      const prof = S.profiles.find(x => x.id === e.profileId);
      const consentOk = prof && (prof.self || prof.consent);
      const garmentSel = (part) => h('select', { 'aria-label': part, onchange: ev => { e[part].garmentId = ev.target.value || null; saveProject(); } }, h('option', { value: '' }, part === 'top' ? 'No top overlay' : 'No bottom overlay'), S.wardrobe.filter(w => w.kind === part).map(w => h('option', { value: w.id, selected: e[part].garmentId === w.id }, w.name)));
      rows.push(h('div', { class: 'panel', style: { borderColor: colorFor(e.trackId) } },
        h('div', { class: 'row' }, th, h('div', { class: 'stack', style: { flex: 1, gap: '4px' } }, h('h3', { style: { color: colorFor(e.trackId) } }, `Actor ${e.trackId} →`, ' ', prof ? prof.name : 'not cast'), h('div', { class: 'row' }, prof ? (consentOk ? chip(prof.self ? 'self' : 'consent recorded', 'ok') : chip('consent missing', 'bad')) : chip('choose a character', 'warn'), check('Enabled', e.enabled, v => { e.enabled = v; saveProject(); })))),
        h('label', { class: 'f' }, 'Character', h('select', { onchange: ev => { if (ev.target.value === '__new') { location.hash = '#/character/new'; return; } e.profileId = ev.target.value || null; applyModeDefaults(e, p.mode, S.profiles.find(x => x.id === e.profileId), { hair: e.hair.on, outfit: outfitOn(e) }); saveProject(); draw(); } },
          h('option', { value: '' }, '— Keep original actor —'), S.profiles.map(pr => h('option', { value: pr.id, selected: pr.id === e.profileId }, pr.name + (pr.self ? ' (me)' : ''))), h('option', { value: '__new' }, '+ New character…'))),
        prof && !prof.refs?.front?.analysis?.ok ? callout(h('span', null, `${prof.name} has no analyzed front face photo yet. `, h('a', { href: `#/character/${prof.id}` }, 'Add references')), 'warn') : null,
        prof && !consentOk ? callout(h('span', null, 'Consent is required before this likeness can be used. ', h('a', { href: `#/character/${prof.id}` }, 'Confirm consent')), 'bad') : null,
        h('div', { class: 'stack', style: { gap: '8px' } },
          check('Replace face', e.face.on, v => { e.face.on = v; saveProject(); }),
          check('Change hair (use my hairstyle)', e.hair.on, v => { e.hair.on = v; saveProject(); draw(); }),
          h('p', { class: 'muted small', style: { marginLeft: '30px' } }, e.hair.on ? 'Your hair layer is placed over the actor’s head.' : 'Keeping the original actor’s hair.'),
          check('Change outfit', outfitOn(e), v => { e.outfit = { on: v }; saveProject(); draw(); }),
          h('p', { class: 'muted small', style: { marginLeft: '30px' } }, outfitOn(e) ? 'Pick a garment and/or recolor below.' : 'Keeping the original actor’s outfit exactly as filmed.')),
        e.hair.on && !prof?.hair ? callout(h('span', null, 'Hair is on, but this character has no hair layer yet. ', prof ? h('a', { href: `#/character/${prof.id}` }, 'Extract it in the Character Builder') : null), 'warn') : null,
        outfitOn(e) ? h('div', { class: 'stack' }, h('div', { class: 'grid2' }, garmentSel('top'), garmentSel('bottom')), check('Recolor the actor’s clothes', e.recolor.on, v => { e.recolor.on = v; saveProject(); })) : null));
    }
    if (!rows.length) rows.push(callout('No actors selected. Go back to Actor Detection and tap the people you want to recast.', 'warn'));
    wrap.replaceChildren(
      h('div', { class: 'row between' }, h('h2', null, 'Cast Director'), statusChip(MODES.find(m => m.key === p.mode)?.status || 'functional')),
      h('p', { class: 'muted small' }, `${MODES.find(m => m.key === p.mode)?.name}: ${MODES.find(m => m.key === p.mode)?.desc}`),
      ...rows,
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/library' }, 'Character Library'), h('a', { class: 'btn', href: '#/wardrobe' }, 'Wardrobe Studio')),
      h('a', { class: 'btn primary block', href: `#/p/${p.id}/${p.plan.photo ? 'editor' : 'motion'}` }, p.plan.photo ? 'Next: Recast Editor' : 'Next: MotionLock'));
  };
  await draw();
  return wrap;
}

// ───────────────────────── 8. MotionLock analysis ─────────────────────────
async function motionScreen(p) {
  if (p.plan.photo) return [callout('Photos have a single frame, so there is no motion to smooth. Go straight to the editor.'), h('a', { class: 'btn primary block', href: `#/p/${p.id}/editor` }, 'Open Recast Editor')];
  const mp = p.motion = p.motion || { minCutoff: 1.2, beta: 0.02, maxGap: 6 };
  const body = h('div', { class: 'stack' });
  const draw = () => {
    const cards = [];
    for (const e of p.cast.filter(x => p.selected.includes(x.trackId))) {
      const m = buildMotion(p.analysis.frames, e.trackId, p.plan.fps, mp);
      const N = m.face.length;
      const rawJ = jitter(m.rawFace, 1, 3), smJ = jitter(m.face, 1, 3);
      const faceN = m.rawFace.filter(Boolean).length, interpN = m.faceInterp.reduce((a, b) => a + b, 0);
      const W = 640, Hh = 150, cv = h('canvas', { width: W, height: Hh, class: 'timeline' }), c = cv.getContext('2d');
      c.fillStyle = '#0b0a0f'; c.fillRect(0, 0, W, Hh);
      c.strokeStyle = '#2b2735'; for (let y = 0; y <= 4; y++) { c.beginPath(); c.moveTo(0, 10 + y * 30); c.lineTo(W, 10 + y * 30); c.stroke(); }
      for (let i = 0; i < N; i++) { const x = i / N * W; c.fillStyle = m.rawFace[i] ? 'rgba(141,92,255,.25)' : m.faceInterp[i] ? 'rgba(167,162,180,.35)' : 'rgba(255,107,122,.25)'; c.fillRect(x, Hh - 8, Math.max(1, W / N), 8); }
      const line = (series, col, w) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); let started = false; series.forEach((v, i) => { if (!v) { started = false; return; } const x = i / N * W, y = 10 + v[3] * 120; started ? c.lineTo(x, y) : c.moveTo(x, y); started = true; }); c.stroke(); };
      line(m.rawFace, 'rgba(242,184,75,.8)', 1); line(m.face, '#b597ff', 2);
      cards.push(panel(
        h('div', { class: 'row between' }, h('h3', { style: { color: colorFor(e.trackId) } }, `Actor ${e.trackId} · head position (x) over time`), chip(`${Math.round(faceN / N * 100)}% face coverage`, faceN / N > 0.8 ? 'ok' : 'warn')),
        cv,
        h('div', { class: 'row small muted' }, h('span', { style: { color: 'var(--warn)' } }, '— raw'), h('span', { style: { color: 'var(--violet-hi)' } }, '— MotionLock'), h('span', null, 'bar: violet detected · silver interpolated · red missing')),
        h('dl', { class: 'kv' }, h('dt', null, 'Jitter (raw)'), h('dd', null, (rawJ * 1000).toFixed(3) + ' ‰ frame'), h('dt', null, 'Jitter (smoothed)'), h('dd', null, (smJ * 1000).toFixed(3) + ` ‰ frame ${rawJ ? `(−${Math.max(0, Math.round((1 - smJ / rawJ) * 100))}%)` : ''}`), h('dt', null, 'Gap frames filled'), h('dd', null, String(interpN)), h('dt', null, 'Unrecoverable'), h('dd', null, `${N - faceN - interpN} frames (face left untouched there)`)),
        slider('Expression follow', e.face.motion, { min: 0, max: 1, step: 0.05, fmt: v => Math.round(v * 100) + '%', oninput: v => { e.face.motion = v; saveProject(); } }),
        h('p', { class: 'muted small' }, '100% = the face mesh follows every source landmark (mouth, eyes, brows). Lower = more rigid paste that only follows head position, scale and roll.')));
    }
    body.replaceChildren(...cards);
  };
  const t = { id: null };
  const later = () => { clearTimeout(t.id); t.id = setTimeout(() => { saveProject(); dropRuntime(); draw(); }, 120); };
  draw();
  return [
    panel(h('h2', null, 'RECAST MotionLock'),
      h('p', { class: 'muted small' }, 'The source performance drives everything: landmarks are taken from the original frames, filtered with a One Euro filter, and short dropouts are bridged. Timing, duration and camera motion are never changed because the recast is composited back into the original frames.'),
      slider('Smoothing', 6 - mp.minCutoff, { min: 0.5, max: 5.7, step: 0.1, fmt: v => (+v).toFixed(1), oninput: v => { mp.minCutoff = +(6 - v).toFixed(2); later(); } }),
      slider('Fast-motion response', mp.beta, { min: 0, max: 0.3, step: 0.005, fmt: v => (+v).toFixed(3), oninput: v => { mp.beta = v; later(); } }),
      slider('Bridge gaps up to', mp.maxGap, { min: 0, max: 30, step: 1, fmt: v => `${v} f`, oninput: v => { mp.maxGap = v; later(); } })),
    body,
    h('a', { class: 'btn primary block', href: `#/p/${p.id}/editor` }, 'Next: Recast Editor'),
  ];
}

// ───────────────────────── 9. Recast editor ─────────────────────────
async function editorScreen(p) {
  ensureEntries(p);
  const entries = () => p.cast.filter(e => p.selected.includes(e.trackId));
  if (!entries().some(e => e.profileId || e.top.garmentId || e.bottom.garmentId || e.recolor.on)) {
    return [callout('Nothing is cast yet. Choose a character (or a garment) for at least one actor.', 'warn'), h('a', { class: 'btn primary', href: `#/p/${p.id}/cast` }, 'Open Cast Director')];
  }
  const g = await grabber();
  const W = p.plan.width, H = p.plan.height, N = p.plan.frames;
  const st = { k: 0, view: 'recast', split: 0.5, ov: { track: false, mesh: false, mask: false }, sel: entries()[0]?.id, tab: 'face', brush: false, brushSize: 0.05, brushSpan: 0, playing: false };
  const cv = h('canvas', { width: W, height: H }), cv2 = h('canvas', { width: W, height: H });
  const tc = h('div', { class: 'tc' }), tag = h('div', { class: 'tag' }, 'RECAST');
  const mon = h('div', { class: 'monitor compare' }, cv, tc, tag);
  const sbs = h('div', { class: 'sbs', hidden: true }, h('figure', null, cv2, h('figcaption', null, 'ORIGINAL')), h('figure', null, h('canvas', { width: W, height: H, id: 'sbs-r' }), h('figcaption', null, 'RECAST')));
  const info = h('p', { class: 'muted small mono' });
  let token = 0, warnShown = false;
  const paint = async () => {
    const my = ++token;
    const src = await g.get(st.k);
    let rt;
    try { rt = await getRuntime(); } catch (e) { info.textContent = 'Runtime error: ' + e.message; return; }
    if (my !== token) return;
    if (!warnShown && rt.warnings.length) { warnShown = true; rt.warnings.forEach(w => toast(w, true, 6000)); }
    const restoreAll = (p.restore || []).some(([a, b]) => st.k >= a && st.k <= b);
    const t0 = performance.now();
    const res = composeFrame(rt, src, st.k, { overlays: st.ov, restoreAll });
    const ms = performance.now() - t0;
    const ctx = cv.getContext('2d');
    if (st.view === 'original') ctx.drawImage(src, 0, 0);
    else if (st.view === 'compare') { ctx.drawImage(res.canvas, 0, 0); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * st.split, H); ctx.clip(); ctx.drawImage(src, 0, 0); ctx.restore(); ctx.fillStyle = '#b597ff'; ctx.fillRect(W * st.split - 1, 0, 2, H); }
    else ctx.drawImage(res.canvas, 0, 0);
    if (st.ov.track) drawTracking(ctx, p.analysis.frames[st.k], W, H, { selected: p.selected, colors: colorFor });
    if (st.view === 'sbs') { cv2.getContext('2d').drawImage(src, 0, 0); $('#sbs-r', sbs).getContext('2d').drawImage(res.canvas, 0, 0); }
    tc.textContent = `${timecode(st.k, p.plan.fps)} · F${st.k}/${N - 1}`;
    cv.style.touchAction = st.brush || st.view === 'compare' ? 'none' : 'pan-y';
    tag.textContent = st.view === 'original' ? 'ORIGINAL' : st.view === 'compare' ? 'ORIGINAL | RECAST' : restoreAll ? 'RESTORED' : 'RECAST';
    const fd = [...res.faces.values()][0];
    info.textContent = `${ms.toFixed(0)} ms/frame · faces ${res.stats.faces} · garments ${res.stats.garments} · hair ${res.stats.hair}${fd ? ` · ref view ${fd.view} · yaw ${fd.yaw.toFixed(2)}` : ''}`;
    drawTimeline();
  };
  const seek = k => { st.k = clamp(k | 0, 0, N - 1); scrub.value = st.k; paint(); drawInspector(); };
  // pointer: compare split + restore brush
  let stroke = null;
  const norm = ev => { const r = cv.getBoundingClientRect(); return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)]; };
  cv.addEventListener('pointerdown', ev => {
    if (st.brush) { const e = cur(); if (!e) return; stroke = { from: st.k, to: Math.min(N - 1, st.k + st.brushSpan), size: st.brushSize, pts: [norm(ev)] }; cv.setPointerCapture(ev.pointerId); }
    else if (st.view === 'compare') { st.split = norm(ev)[0]; cv.setPointerCapture(ev.pointerId); paint(); }
  });
  cv.addEventListener('pointermove', ev => {
    if (stroke) { stroke.pts.push(norm(ev)); const ctx = cv.getContext('2d'); ctx.strokeStyle = 'rgba(79,209,161,.6)'; ctx.lineCap = 'round'; ctx.lineWidth = stroke.size * W; const a = stroke.pts[stroke.pts.length - 2], b = stroke.pts[stroke.pts.length - 1]; ctx.beginPath(); ctx.moveTo(a[0] * W, a[1] * H); ctx.lineTo(b[0] * W, b[1] * H); ctx.stroke(); }
    else if (st.view === 'compare' && ev.buttons) { st.split = norm(ev)[0]; paint(); }
  });
  cv.addEventListener('pointerup', () => { if (stroke) { cur().strokes.push(stroke); stroke = null; saveProject(); paint(); drawInspector(); } });

  const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: N - 1, value: 0, 'aria-label': 'Frame', oninput: e => seek(+e.target.value) });
  const playBtn = h('button', { class: 'btn sm', 'aria-label': 'Play', onclick: async () => {
    st.playing = !st.playing; playBtn.textContent = st.playing ? '❚❚' : '▶';
    while (st.playing && st.k < N - 1) { st.k++; scrub.value = st.k; await paint(); }
    st.playing = false; playBtn.textContent = '▶'; drawInspector();
  } }, '▶');
  S.cleanup.push(() => { st.playing = false; });
  const transport = h('div', { class: 'transport' },
    h('button', { class: 'btn sm', 'aria-label': 'Previous frame', onclick: () => seek(st.k - 1) }, '‹'), playBtn,
    h('button', { class: 'btn sm', 'aria-label': 'Next frame', onclick: () => seek(st.k + 1) }, '›'), scrub, h('span', { class: 'tcbig' }));
  const viewSeg = seg([['recast', 'Recast'], ['compare', 'Compare'], ['sbs', 'Side by side'], ['original', 'Original']], st.view, v => { st.view = v; sbs.hidden = v !== 'sbs'; mon.hidden = v === 'sbs'; paint(); });
  const ovChips = h('div', { class: 'row' }, [['track', 'Tracking'], ['mesh', 'Face mesh'], ['mask', 'Masks']].map(([k, l]) => h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': 'false', onclick: ev => { st.ov[k] = !st.ov[k]; ev.currentTarget.setAttribute('aria-pressed', String(st.ov[k])); paint(); } }, l)),
    h('button', { class: 'btn sm ghost', onclick: () => { const el = mon; if (el.requestFullscreen && document.fullscreenEnabled) el.requestFullscreen().catch(() => el.classList.toggle('fs')); else el.classList.toggle('fs'); } }, 'Fullscreen'));
  mon.addEventListener('dblclick', () => mon.classList.remove('fs'));

  // timeline
  const tl = h('canvas', { class: 'timeline', width: 900, height: 10 });
  const drawTimeline = () => {
    const rows = [['Source', 'src'], ['Background plate', 'bg'], ...entries().map(e => [`A${e.trackId} ${S.profiles.find(x => x.id === e.profileId)?.name || ''}`, e]), ['Audio', 'audio']];
    const RH = 22, LW = 150, TW = 900; tl.height = rows.length * RH + 6;
    const c = tl.getContext('2d'); c.clearRect(0, 0, TW, tl.height); c.font = '600 11px "IBM Plex Mono", monospace'; c.textBaseline = 'middle';
    rows.forEach(([label, r], i) => {
      const y = 3 + i * RH; c.fillStyle = '#a7a2b4'; c.fillText(label.slice(0, 20), 8, y + RH / 2);
      const X = f => LW + (f / N) * (TW - LW - 6), bw = Math.max(1, (TW - LW - 6) / N);
      if (r === 'src') { c.fillStyle = '#2b2735'; c.fillRect(LW, y + 5, TW - LW - 6, RH - 10); }
      else if (r === 'bg') { c.fillStyle = '#6f6980'; c.fillText('V0.2 · clean plate not supported', LW, y + RH / 2); }
      else if (r === 'audio') { if (p.meta.audio.length) { c.fillStyle = 'rgba(79,209,161,.35)'; c.fillRect(LW, y + 7, TW - LW - 6, RH - 14); } else { c.fillStyle = '#6f6980'; c.fillText('no audio track', LW, y + RH / 2); } }
      else {
        const e = r, col = colorFor(e.trackId);
        p.analysis.frames.forEach((fr, f) => { const q = fr.people.find(x => x.id === e.trackId); if (q?.face) { c.fillStyle = e.id === st.sel ? col : col + '88'; c.fillRect(X(f), y + 5, bw, RH - 10); } else if (q) { c.fillStyle = '#3a3448'; c.fillRect(X(f), y + 9, bw, RH - 18); } });
        c.fillStyle = 'rgba(255,107,122,.7)'; (e.skip || []).forEach(([a, b]) => c.fillRect(X(a), y + 2, X(b + 1) - X(a), 3));
        c.fillStyle = 'rgba(79,209,161,.9)'; (e.strokes || []).forEach(s => c.fillRect(X(s.from), y + RH - 5, Math.max(2, X(s.to + 1) - X(s.from)), 3));
        c.fillStyle = '#fff'; (e.keys || []).forEach(kf => { const x = X(kf.f) + bw / 2; c.beginPath(); c.moveTo(x, y + 4); c.lineTo(x + 4, y + RH / 2); c.lineTo(x, y + RH - 4); c.lineTo(x - 4, y + RH / 2); c.fill(); });
      }
    });
    c.fillStyle = 'rgba(255,107,122,.25)'; (p.restore || []).forEach(([a, b]) => c.fillRect(LW + a / N * (TW - LW - 6), 0, (b - a + 1) / N * (TW - LW - 6), tl.height));
    const px = LW + (st.k / N) * (TW - LW - 6); c.fillStyle = '#b597ff'; c.fillRect(px, 0, 2, tl.height);
  };
  tl.addEventListener('pointerdown', ev => { const r = tl.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * 900; if (x > 150) seek(Math.round((x - 150) / (900 - 156) * N)); });

  // layers + inspector
  const cur = () => p.cast.find(e => e.id === st.sel);
  const layerBar = h('div', { class: 'layers' });
  const drawLayers = () => layerBar.replaceChildren(...entries().map(e => h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(e.id === st.sel), style: { borderColor: colorFor(e.trackId) }, onclick: () => { st.sel = e.id; drawLayers(); drawInspector(); drawTimeline(); } }, `Actor ${e.trackId} → ${S.profiles.find(x => x.id === e.profileId)?.name || 'original'}`)));
  const insp = h('div', { class: 'stack' });
  const change = (fn) => (v) => { fn(v); saveProject(); paint(); };
  const drawInspector = () => {
    const e = cur(); if (!e) { insp.replaceChildren(h('p', { class: 'muted' }, 'No layer.')); return; }
    const tabs = seg([['transform', 'Transform'], ['face', 'Face'], ['hair', 'Hair'], ['ward', 'Wardrobe'], ['repair', 'Repair']], st.tab, t => { st.tab = t; drawInspector(); });
    const body = [];
    const prof = S.profiles.find(x => x.id === e.profileId);
    if (st.tab === 'transform') {
      const tr = interpKeys(e.keys, st.k, e.transform, KEY_PROPS), keyHere = e.keys.find(kf => kf.f === st.k);
      const setProp = (prop) => (v) => {
        if (e.keys.length) { const kf = e.keys.find(x => x.f === st.k) || (e.keys.push({ f: st.k, ...interpKeys(e.keys, st.k, e.transform, KEY_PROPS) }), e.keys[e.keys.length - 1]); kf[prop] = v; }
        else e.transform[prop] = v;
        saveProject(); paint();
      };
      body.push(
        slider('Position X', tr.x, { min: -0.6, max: 0.6, step: 0.005, oninput: setProp('x') }),
        slider('Position Y', tr.y, { min: -0.6, max: 0.6, step: 0.005, oninput: setProp('y') }),
        slider('Scale', tr.scale, { min: 0.7, max: 1.4, step: 0.005, oninput: setProp('scale') }),
        slider('Rotation', tr.rot, { min: -25, max: 25, step: 0.5, fmt: v => (+v).toFixed(1) + '°', oninput: setProp('rot') }),
        slider('Opacity', tr.opacity, { min: 0, max: 1, step: 0.01, oninput: setProp('opacity') }),
        h('p', { class: 'muted small' }, 'Offsets are in face widths, applied on top of the tracked position. With keyframes, edits write a key at the playhead.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { if (!keyHere) e.keys.push({ f: st.k, ...tr }); saveProject(); drawInspector(); drawTimeline(); } }, keyHere ? '◆ Key at this frame' : '◇ Add keyframe'),
          keyHere ? h('button', { class: 'btn sm ghost danger', onclick: () => { e.keys = e.keys.filter(x => x !== keyHere); saveProject(); paint(); drawInspector(); } }, 'Delete key') : null,
          h('button', { class: 'btn sm ghost', onclick: () => { const ks = e.keys.map(x => x.f).filter(f => f < st.k); if (ks.length) seek(Math.max(...ks)); } }, '← key'),
          h('button', { class: 'btn sm ghost', onclick: () => { const ks = e.keys.map(x => x.f).filter(f => f > st.k); if (ks.length) seek(Math.min(...ks)); } }, 'key →'),
          e.keys.length ? h('button', { class: 'btn sm ghost danger', onclick: () => { e.keys = []; saveProject(); paint(); drawInspector(); } }, 'Clear all keys') : null));
    } else if (st.tab === 'face') {
      body.push(
        check('Replace face', e.face.on, change(v => (e.face.on = v))),
        slider('Edge feather', e.face.feather, { min: 0.005, max: 0.2, step: 0.005, oninput: change(v => (e.face.feather = v)) }),
        slider('Skin-tone match', e.face.color, { min: 0, max: 1, step: 0.05, oninput: change(v => (e.face.color = v)) }),
        slider('Scene lighting', e.face.light, { min: 0, max: 1, step: 0.05, oninput: change(v => (e.face.light = v)) }),
        slider('Saturation', e.face.sat, { min: 0.5, max: 1.5, step: 0.02, oninput: change(v => (e.face.sat = v)) }),
        slider('Detail match', e.face.soft ?? 0.6, { min: 0, max: 1.5, step: 0.05, oninput: change(v => (e.face.soft = v)) }),
        slider('Film grain', e.face.grain, { min: 0, max: 0.08, step: 0.002, fmt: v => (+v).toFixed(3), oninput: change(v => (e.face.grain = v)) }),
        slider('Expression follow', e.face.motion, { min: 0, max: 1, step: 0.05, oninput: change(v => (e.face.motion = v)) }),
        check('Keep source mouth interior (teeth/tongue when speaking)', e.face.keepMouth, change(v => (e.face.keepMouth = v))),
        check('Keep source eyes (more natural blinks, less identity)', e.face.keepEyes, change(v => (e.face.keepEyes = v))),
        h('p', { class: 'muted small' }, 'Face shape: the reference is warped onto the actor’s mesh, so jaw and proportions follow the actor more than you. Eye, brow, nose and mouth appearance come from your photo; their motion comes from the actor.'));
    } else if (st.tab === 'hair') {
      body.push(check('Change hair (unchecked = original actor’s hair)', e.hair.on, v => { e.hair.on = v; saveProject(); dropRuntime(); paint(); drawInspector(); }),
        prof?.hair ? h('p', { class: 'muted small' }, `Hair layer from ${prof.name}. Color, volume and fringe are edited on the character.`) : callout('This character has no hair layer. Extract one in the Character Builder (needs the Multiclass model).', 'warn'),
        prof ? h('a', { class: 'btn sm', href: `#/character/${prof.id}` }, 'Edit hair on character') : null,
        h('p', { class: 'muted small' }, 'Limitation: the actor’s own hair is not removed, so longer source hair can show around a shorter overlay.'));
    } else if (st.tab === 'ward') {
      body.push(check('Change outfit (unchecked = original actor’s outfit)', outfitOn(e), v => { e.outfit = { on: v }; saveProject(); dropRuntime(); paint(); drawInspector(); }));
      if (outfitOn(e)) for (const part of ['top', 'bottom']) {
        const gm = S.wardrobe.find(w => w.id === e[part].garmentId);
        body.push(h('h3', null, part === 'top' ? 'Top' : 'Bottom'),
          h('select', { onchange: ev => { e[part].garmentId = ev.target.value || null; saveProject(); dropRuntime(); paint(); drawInspector(); } }, h('option', { value: '' }, 'None'), S.wardrobe.filter(w => w.kind === part).map(w => h('option', { value: w.id, selected: w.id === e[part].garmentId }, w.name))));
        if (gm) body.push(
          slider('Width', e[part].width, { min: 0.8, max: 1.8, step: 0.01, oninput: change(v => (e[part].width = v)) }),
          part === 'top' ? slider('Collar lift', e[part].collar, { min: -0.1, max: 0.4, step: 0.01, oninput: change(v => (e[part].collar = v)) }) : null,
          slider('Opacity', e[part].opacity, { min: 0, max: 1, step: 0.01, oninput: change(v => (e[part].opacity = v)) }),
          check('Clip to body silhouette (Selfie Segmenter)', e[part].clip, v => { e[part].clip = v; saveProject(); dropRuntime(); paint(); }));
      }
      if (outfitOn(e)) body.push(h('h3', null, 'Clothing recolor'), check('Recolor the actor’s clothes (Multiclass model)', e.recolor.on, v => { e.recolor.on = v; saveProject(); dropRuntime(); paint(); }),
        h('div', { class: 'row' }, h('input', { type: 'color', value: e.recolor.color, 'aria-label': 'Clothes color', oninput: ev => { e.recolor.color = ev.target.value; saveProject(); paint(); } }), h('div', { style: { flex: 1 } }, slider('Strength', e.recolor.strength, { min: 0, max: 1, step: 0.05, oninput: change(v => (e.recolor.strength = v)) }))),
        h('a', { class: 'btn sm', href: '#/wardrobe' }, 'Wardrobe Studio'));
    } else if (st.tab === 'repair') {
      const skipHere = (e.skip || []).some(([a, b]) => st.k >= a && st.k <= b), restHere = (p.restore || []).some(([a, b]) => st.k >= a && st.k <= b);
      const strokesHere = (e.strokes || []).filter(s => st.k >= s.from && st.k <= s.to);
      body.push(
        h('h3', null, 'Restore brush'),
        h('p', { class: 'muted small' }, 'Paint over places where the original should show through, such as a hand passing in front of the face.'),
        h('div', { class: 'row' }, h('span', { class: 'chip toggle-chip', role: 'button', tabindex: 0, 'aria-pressed': String(st.brush), onclick: () => { st.brush = !st.brush; drawInspector(); } }, st.brush ? 'Brush ON — paint on the monitor' : 'Brush off')),
        slider('Brush size', st.brushSize, { min: 0.01, max: 0.2, step: 0.005, oninput: v => (st.brushSize = v) }),
        slider('Hold stroke for', st.brushSpan, { min: 0, max: Math.min(120, N - 1), step: 1, fmt: v => `+${v} f`, oninput: v => (st.brushSpan = v) }),
        strokesHere.length ? h('button', { class: 'btn sm ghost danger', onclick: () => { e.strokes = e.strokes.filter(s => !strokesHere.includes(s)); saveProject(); paint(); drawInspector(); } }, `Erase ${strokesHere.length} stroke(s) on this frame`) : null,
        h('hr', { class: 'sep' }),
        h('h3', null, 'Frame overrides'),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => { e.skip = toggleRange(e.skip || [], st.k); saveProject(); paint(); drawInspector(); } }, skipHere ? 'Re-enable this layer here' : 'Hide this layer on this frame'),
          h('button', { class: 'btn sm', onclick: () => { p.restore = toggleRange(p.restore || [], st.k); saveProject(); paint(); drawInspector(); } }, restHere ? 'Un-restore frame' : 'Restore original frame')),
        h('hr', { class: 'sep' }),
        h('h3', null, 'Tracking'),
        h('button', { class: 'btn sm', onclick: async ev => { ev.target.disabled = true; try { const n = await redetect(p, st.k - 15, st.k + 15); toast(`Re-detected ${n} frames around F${st.k}`); dropRuntime(); paint(); drawTimeline(); } catch (err) { toast(err.message, true); } ev.target.disabled = false; } }, 'Recalculate tracking ±15 frames'),
        h('a', { class: 'btn sm ghost', href: `#/p/${p.id}/actors` }, 'Reassign identities'));
    }
    insp.replaceChildren(tabs, ...body);
  };
  drawLayers(); drawInspector(); await paint();
  return h('div', { class: 'editor' },
    h('div', { class: 'stack' }, mon, sbs, transport, h('div', { class: 'row between' }, viewSeg, ovChips), info, tl),
    h('div', { class: 'stack side' }, panel(h('h2', null, 'Inspector'), layerBar, insp),
      h('a', { class: 'btn primary block', href: `#/p/${p.id}/render` }, 'Next: Render')));
}
function toggleRange(ranges, k) {
  const i = ranges.findIndex(([a, b]) => k >= a && k <= b);
  if (i < 0) return [...ranges, [k, k]].sort((x, y) => x[0] - y[0]);
  const [a, b] = ranges[i], out = ranges.filter((_, j) => j !== i);
  if (a < k) out.push([a, k - 1]); if (b > k) out.push([k + 1, b]);
  return out.sort((x, y) => x[0] - y[0]);
}
async function redetect(p, k0, k1) {
  k0 = Math.max(0, k0); k1 = Math.min(p.plan.frames - 1, k1);
  const g = await grabber();
  const pose = await getTask(p.analysis.poseModel || 'pose_lite', 'VIDEO', { num: 4 }), face = await getTask('face', 'VIDEO', { num: 4 });
  let maxId = Math.max(0, ...p.analysis.frames.flatMap(f => f.people.map(q => q.id)));
  let prev = k0 > 0 ? p.analysis.frames[k0 - 1].people : [];
  for (let k = k0; k <= k1; k++) {
    const people = detectPeople(pose, face, await g.get(k));
    const old = p.analysis.frames[k].people, ref = old.length ? old : prev, used = new Set();
    for (const q of people) {
      let best = null, bs = 0.15;
      for (const o of ref) { if (used.has(o.id)) continue; const s = iou(o.bbox, q.bbox); if (s > bs) { bs = s; best = o; } }
      if (best) { q.id = best.id; used.add(best.id); } else q.id = ++maxId;
    }
    p.analysis.frames[k] = { ...p.analysis.frames[k], people: people.map(q => ({ id: q.id, pose: q.pose, face: q.face, bbox: q.bbox, faceOnly: !!q.faceOnly })) };
    prev = p.analysis.frames[k].people;
  }
  p.analysis.at = Date.now(); saveProject();
  return k1 - k0 + 1;
}

// ───────────────────────── Render & queue ─────────────────────────
function enqueue(p, opts) {
  const job = { id: uid('j'), projectId: p.id, name: p.name, opts, status: 'queued', progress: 0, created: Date.now() };
  S.queue.push(job); pump(); return job;
}
async function pump() {
  if (S.job) return;
  const job = S.queue.find(j => j.status === 'queued'); if (!job) return;
  S.job = job; job.status = 'running'; job.ctrl = new AbortController(); job.started = performance.now();
  try {
    const p = S.project?.id === job.projectId ? S.project : await openProject(job.projectId);
    const res = await renderProject(p, { file: S.file, meta: p.meta, profiles: S.profiles, wardrobe: S.wardrobe, analysis: p.analysis, motionParams: p.motion || {} }, {
      ...job.opts, signal: job.ctrl.signal,
      onProgress: (d, t, info) => { job.progress = d / t; job.info = info; job.done = d; job.total = t; job.onUpdate?.(); if (S.top && (!job._tt || performance.now() - job._tt > 800)) { job._tt = performance.now(); setTop(...S.top); } },
    });
    if (res.cancelled) { job.status = 'cancelled'; }
    else {
      job.status = 'done'; job.result = res; S.results.set(p.id, res);
      if (res.output) {
        const prof = S.profiles.find(x => x.id === p.cast.find(e => e.enabled && e.profileId)?.profileId);
        const safe = s => (s || '').replace(/[^\w-]+/g, '').slice(0, 30) || 'Scene';
        const name = `RECAST_${safe(prof?.name || 'Cast')}_${safe(p.name)}${p.plan.photo ? '_Poster' : ''}${job.opts.disclosure ? '_AI-edited' : ''}.${res.output.ext}`;
        await db.put('renders', { id: 'out:' + p.id, blob: res.output.blob, at: Date.now() });
        p.export = { name, mime: res.output.mime, codec: res.output.codec, size: res.output.blob.size, at: Date.now(), notes: res.notes, stats: res.stats, seconds: res.seconds, disclosure: job.opts.disclosure, range: res.range, verify: null };
        await saveProject(true);
      }
    }
  } catch (e) { console.error(e); job.status = 'failed'; job.error = String(e?.message || e); toast('Render failed: ' + job.error, true, 7000); }
  job.ended = Date.now(); S.history.unshift(job); S.queue = S.queue.filter(j => j !== job); S.job = null;
  job.onUpdate?.(); if (job.status === 'done') toast(`Render finished: ${job.name}`);
  if (S.top) setTop(...S.top);
  pump();
}

async function renderScreen(p) {
  const opts = { encode: true, disclosure: S.settings.disclosure, includeAudio: true, range: [0, p.plan.frames - 1] };
  const wrap = h('div', { class: 'stack' });
  const live = h('div', { class: 'stack' });
  const drawLive = () => {
    const job = S.job?.projectId === p.id ? S.job : S.queue.find(j => j.projectId === p.id);
    const last = S.history.find(j => j.projectId === p.id);
    const parts = [];
    if (job) {
      const bar = progressBar(); bar.set(job.progress || 0);
      const el = job.started ? (performance.now() - job.started) / 1000 : 0, fps = job.info?.fps;
      const remain = fps && job.total ? (job.total - (job.done || 0)) / fps : null;
      parts.push(panel(h('div', { class: 'row between' }, h('h2', null, job.status === 'queued' ? 'Queued' : job.info?.phase === 'finalizing' ? 'Finalizing MP4…' : job.info?.phase === 'recording' ? 'Recording (real-time fallback)…' : 'Rendering…'), h('span', { class: 'mono' }, `${Math.round((job.progress || 0) * 100)}%`)), bar,
        h('p', { class: 'muted small mono' }, `${job.done || 0}/${job.total || '?'} frames · ${el.toFixed(0)} s elapsed${fps ? ` · ${fps.toFixed(1)} frames/s measured` : ''}${remain != null ? ` · ~${Math.ceil(remain)} s left at this rate` : ''}`),
        h('button', { class: 'btn', onclick: () => { if (job.status === 'queued') { job.status = 'cancelled'; S.queue = S.queue.filter(j => j !== job); drawLive(); } else job.ctrl?.abort(); } }, 'Cancel')));
    } else if (last?.status === 'failed') parts.push(callout('Last render failed: ' + last.error, 'bad'));
    else if (last?.status === 'cancelled') parts.push(callout('Last render was cancelled. Nothing was exported.', 'warn'));
    const res = S.results.get(p.id);
    if (res && !job) parts.push(resultViewer(p, res));
    live.replaceChildren(...parts);
  };
  const tick = setInterval(() => { const j = S.job; if (j?.projectId === p.id) drawLive(); }, 500);
  S.cleanup.push(() => clearInterval(tick));
  const rng = h('div', { class: 'stack', hidden: true });
  const drawRng = () => rng.replaceChildren(
    h('div', { class: 'slider' }, h('span', null, 'From frame'), h('input', { type: 'range', min: 0, max: p.plan.frames - 1, value: opts.range[0], oninput: e => { opts.range[0] = Math.min(+e.target.value, opts.range[1]); e.target.nextSibling.textContent = 'F' + opts.range[0]; } }), h('output', null, 'F' + opts.range[0])),
    h('div', { class: 'slider' }, h('span', null, 'To frame'), h('input', { type: 'range', min: 0, max: p.plan.frames - 1, value: opts.range[1], oninput: e => { opts.range[1] = Math.max(+e.target.value, opts.range[0]); e.target.nextSibling.textContent = 'F' + opts.range[1]; } }), h('output', null, 'F' + opts.range[1])));
  drawRng();
  if (p.plan.photo) {
    opts.imageFormat = 'png';
    wrap.append(panel(h('h2', null, 'Render poster'),
      h('p', { class: 'muted small' }, `One full-resolution image at ${p.plan.width}×${p.plan.height}.`),
      seg([['png', 'PNG (lossless)'], ['jpeg', 'JPEG (smaller)']], 'png', v => (opts.imageFormat = v)),
      check('Add small “AI-edited” label in the corner', opts.disclosure, v => (opts.disclosure = v)),
      h('button', { class: 'btn primary', onclick: () => { const j = enqueue(p, { ...opts, range: [0, 0] }); j.onUpdate = drawLive; drawLive(); } }, 'Render poster')), live);
    const jj = S.job?.projectId === p.id ? S.job : null; if (jj) jj.onUpdate = drawLive;
    drawLive();
    return wrap;
  }
  wrap.append(
    panel(h('h2', null, 'Render'),
      seg([['full', 'Full render + MP4'], ['range', 'Preview frames only']], 'full', v => { opts.encode = v === 'full'; rng.hidden = opts.encode; if (opts.encode) opts.range = [0, p.plan.frames - 1]; drawRng(); }),
      rng,
      check('Burn in “AI-edited” disclosure label', opts.disclosure, v => (opts.disclosure = v)),
      p.meta.audio.length ? check('Keep original audio', opts.includeAudio, v => (opts.includeAudio = v)) : h('p', { class: 'muted small' }, 'Source has no audio track.'),
      h('p', { class: 'muted small' }, `${p.plan.frames} frames at ${p.plan.width}×${p.plan.height}, ${p.plan.fps.toFixed(2)} fps. Progress counts frames actually composited and encoded.`),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { const j = enqueue(p, { ...opts, range: [...opts.range] }); j.onUpdate = drawLive; drawLive(); } }, 'Start render'), h('a', { class: 'btn ghost', href: '#/queue' }, 'Render queue'))),
    live);
  const j = S.job?.projectId === p.id ? S.job : null; if (j) j.onUpdate = drawLive;
  drawLive();
  return wrap;
}

function resultViewer(p, res) {
  const keys = [...res.previews.keys()].sort((a, b) => a - b);
  if (!keys.length) return callout('No frames were rendered.', 'warn');
  let i = 0, split = 0.5, mode = 'compare', playing = false;
  const imgs = new Map(), get = async (map, k) => { const key = map === res.previews ? 'r' + k : 'o' + k; if (!imgs.has(key)) imgs.set(key, await createImageBitmap(map.get(k))); return imgs.get(key); };
  const cv = h('canvas'), tc = h('div', { class: 'tc' });
  const paint = async () => {
    const k = keys[i], r = await get(res.previews, k), o = await get(res.originals, k);
    cv.width = r.width; cv.height = r.height; const c = cv.getContext('2d');
    if (mode === 'recast') c.drawImage(r, 0, 0); else if (mode === 'original') c.drawImage(o, 0, 0);
    else { c.drawImage(r, 0, 0); c.save(); c.beginPath(); c.rect(0, 0, r.width * split, r.height); c.clip(); c.drawImage(o, 0, 0); c.restore(); c.fillStyle = '#b597ff'; c.fillRect(r.width * split - 1, 0, 2, r.height); }
    tc.textContent = `${timecode(k, p.plan.fps)} · F${k}`;
  };
  cv.addEventListener('pointerdown', ev => { cv.setPointerCapture(ev.pointerId); const r = cv.getBoundingClientRect(); split = clamp((ev.clientX - r.left) / r.width, 0, 1); paint(); });
  cv.addEventListener('pointermove', ev => { if (!ev.buttons) return; const r = cv.getBoundingClientRect(); split = clamp((ev.clientX - r.left) / r.width, 0, 1); paint(); });
  const scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: keys.length - 1, value: 0, 'aria-label': 'Rendered frame', oninput: e => { i = +e.target.value; paint(); } });
  const play = h('button', { class: 'btn sm', onclick: async () => { playing = !playing; play.textContent = playing ? '❚❚' : '▶'; const t0 = performance.now(), i0 = i; while (playing && i < keys.length - 1) { await new Promise(r => setTimeout(r, Math.max(0, t0 + (i + 1 - i0) * 1000 / p.plan.fps - performance.now()))); i++; scrub.value = i; await paint(); } playing = false; play.textContent = '▶'; } }, '▶');
  paint();
  const s = res.stats;
  return panel(h('div', { class: 'row between' }, h('h2', null, 'Rendered preview'), res.output ? chip('MP4 ready', 'ok') : chip('preview only', 'v')),
    h('div', { class: 'monitor' }, cv, tc),
    h('div', { class: 'transport' }, h('button', { class: 'btn sm', onclick: () => { i = Math.max(0, i - 1); scrub.value = i; paint(); } }, '‹'), play, h('button', { class: 'btn sm', onclick: () => { i = Math.min(keys.length - 1, i + 1); scrub.value = i; paint(); } }, '›'), scrub, h('span')),
    seg([['compare', 'Compare'], ['recast', 'Recast'], ['original', 'Original']], mode, v => { mode = v; paint(); }),
    h('dl', { class: 'kv' }, h('dt', null, 'Frames'), h('dd', null, String(s.frames)), h('dt', null, 'Faces replaced'), h('dd', null, `${s.faces} (in ${Math.round(s.faces / Math.max(1, s.frames) * 100)}% of frames)`), h('dt', null, 'Garment draws'), h('dd', null, String(s.garments)), h('dt', null, 'Hair draws'), h('dd', null, String(s.hair)), h('dt', null, 'Time'), h('dd', null, res.seconds ? `${res.seconds.toFixed(1)} s` : '—')),
    ...(res.warnings || []).map(w => callout(w, 'warn')), ...(res.notes || []).map(n => callout(n)),
    res.output ? h('a', { class: 'btn primary block', href: `#/p/${p.id}/export` }, 'Go to Export Studio') : h('p', { class: 'muted small' }, 'Preview renders are not encoded. Run a full render to export.'));
}

async function renderQueue() {
  setTop('Render Queue', '#/');
  const wrap = h('div', { class: 'stack' });
  const draw = () => {
    const rows = [...(S.job ? [S.job] : []), ...S.queue.filter(j => j !== S.job), ...S.history];
    wrap.replaceChildren(h('h1', null, 'Render queue'),
      h('p', { class: 'muted small' }, 'Jobs run one at a time to keep memory use low. Keep this tab open while rendering: Safari pauses background tabs.'),
      rows.length ? h('div', { class: 'stack' }, rows.map(j => h('div', { class: 'item', style: { gridTemplateColumns: '1fr auto' } },
        h('div', { class: 't' }, h('h3', null, j.name), h('p', { class: 'small muted mono' }, `${j.opts.encode ? 'Full + MP4' : `Preview F${j.opts.range[0]}–F${j.opts.range[1]}`} · ${j.status}${j.status === 'running' ? ` · ${Math.round(j.progress * 100)}%` : ''}${j.error ? ' · ' + j.error : ''}`)),
        h('div', { class: 'row' }, j.status === 'running' ? h('button', { class: 'btn sm', onclick: () => j.ctrl.abort() }, 'Cancel') : null, h('a', { class: 'btn sm ghost', href: `#/p/${j.projectId}/${j.status === 'done' && j.opts.encode ? 'export' : 'render'}` }, 'Open'))))) : h('p', { class: 'muted' }, 'No renders this session.'));
  };
  draw();
  const t = setInterval(draw, 700); S.cleanup.push(() => clearInterval(t));
  return wrap;
}

// ───────────────────────── 11. Export studio ─────────────────────────
async function exportScreen(p) {
  if (!p.export) return [callout('No export yet. Run a full render first.', 'warn'), h('a', { class: 'btn primary', href: `#/p/${p.id}/render` }, 'Go to Render')];
  const rec = await db.get('renders', 'out:' + p.id);
  if (!rec?.blob) return [callout('The exported file is no longer in storage. Render again.', 'warn')];
  const blob = rec.blob, url = URL.createObjectURL(blob); S.cleanup.push(() => URL.revokeObjectURL(url));
  const x = p.export;
  const verifyBox = h('div', { class: 'stack' });
  const showVerify = (v) => {
    if (!v) return;
    verifyBox.replaceChildren(callout(v.ok ? `Verified: the exported file decodes (${v.size}, ${v.duration?.toFixed(2)} s${v.audio ? ', with audio' : ''}) and the actor region differs from the source.` : 'Verification did not find modified pixels in the sampled actor regions. Check that a character is cast and the face was detected on these frames.', v.ok ? '' : 'warn'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Frame'), h('th', null, 'Δ in actor face'), h('th', null, 'Δ whole frame'))),
        h('tbody', null, v.details.map(d => h('tr', null, h('td', { class: 'mono' }, 'F' + d.frame), h('td', { class: 'mono' }, d.inside == null ? 'no face' : d.inside.toFixed(1)), h('td', { class: 'mono' }, d.whole.toFixed(1))))))),
      h('p', { class: 'muted small' }, 'Δ = mean absolute RGB difference (0–255) between the re-decoded export and the original source at the same frame.'));
  };
  showVerify(x.verify);
  return [
    h('div', { class: 'monitor' }, p.plan.photo ? h('img', { src: url, alt: 'Recast poster', style: { maxHeight: '70vh', objectFit: 'contain' } }) : h('video', { src: url, controls: true, playsInline: true, preload: 'metadata' })),
    panel(h('h2', null, 'Export Studio'),
      h('dl', { class: 'kv' }, h('dt', null, 'File name'), h('dd', null, x.name), h('dt', null, 'Format'), h('dd', null, `${x.mime} · ${x.codec}`), h('dt', null, 'Size'), h('dd', null, fmtBytes(blob.size)), h('dt', null, p.plan.photo ? 'Image' : 'Frames'), h('dd', null, p.plan.photo ? `${p.plan.width}×${p.plan.height}` : `${p.plan.frames} @ ${p.plan.fps.toFixed(2)} fps, ${p.plan.width}×${p.plan.height}`), h('dt', null, 'Rendered'), h('dd', null, new Date(x.at).toLocaleString()), h('dt', null, 'Disclosure'), h('dd', null, x.disclosure ? 'AI-edited label burned in' : 'none')),
      ...(x.notes || []).map(n => callout(n)),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { try { if (!(await shareFile(blob, x.name, blob.type))) { downloadBlob(blob, x.name); toast(p.plan.photo ? 'Downloading… On iPhone, open it from Files and choose Save Image.' : 'Downloading… On iPhone, open it from Files and choose Save Video.'); } } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); } } }, p.plan.photo ? 'Save / Share poster' : 'Save / Share video'),
        h('button', { class: 'btn', onclick: () => downloadBlob(blob, x.name) }, 'Download file'),
        h('button', { class: 'btn', onclick: async ev => {
          ev.target.disabled = true; verifyBox.replaceChildren(h('p', { class: 'muted' }, 'Re-opening the export and comparing frames…'));
          try {
            const samples = [...new Set([0, 0.25, 0.5, 0.75, 1].map(f => Math.min(p.plan.frames - 1, Math.round(f * (p.plan.frames - 1)))))];
            const W = p.plan.width, H = p.plan.height;
            const v = await verifyExport(blob, S.file, p.meta, p.plan, samples, k => {
              for (const e of p.cast.filter(c => c.enabled && p.selected.includes(c.trackId))) { const q = p.analysis.frames[k].people.find(z => z.id === e.trackId && z.face); if (q) { let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (let i = 0; i < q.face.length; i += 3) { x0 = Math.min(x0, q.face[i]); y0 = Math.min(y0, q.face[i + 1]); x1 = Math.max(x1, q.face[i]); y1 = Math.max(y1, q.face[i + 1]); } const mx = (x1 - x0) * 0.2, my = (y1 - y0) * 0.2; return [(x0 + mx) * W, (y0 + my) * H, (x1 - mx) * W, (y1 - my) * H]; } }
              return null;
            });
            x.verify = v; saveProject(); showVerify(v);
          } catch (e) { verifyBox.replaceChildren(callout('Verification failed: ' + e.message, 'bad')); }
          ev.target.disabled = false;
        } }, 'Verify export'))),
    verifyBox,
    panel(h('h3', null, 'Project file'), h('p', { class: 'muted small' }, 'The project (source copy, tracking, cast settings, keyframes) is saved on this device automatically. You can also export it as a file, which includes the source video.'),
      h('button', { class: 'btn sm', onclick: async () => {
        const src = await db.get('renders', 'src:' + p.id);
        const b64 = src?.blob ? await blobToB64(src.blob) : null;
        const data = JSON.stringify({ format: 'recast-project', version: 1, project: serializeProject(p), source: b64 && { type: src.blob.type, b64 } });
        downloadBlob(new Blob([data], { type: 'application/json' }), `${p.name.replace(/[^\w-]+/g, '_')}.recast.json`);
      } }, 'Export project file')),
  ];
}
const blobToB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(b); });
const b64ToBlob = (b64, type) => fetch(`data:${type};base64,${b64}`).then(r => r.blob());
function serializeProject(p) {
  const conv = v => v instanceof Float32Array ? { $f32: Array.from(v) } : v instanceof Uint8ClampedArray ? { $u8c: Array.from(v) } : v instanceof Blob ? null : Array.isArray(v) ? v.map(conv) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])) : v;
  const { export: _x, ...rest } = p; return conv(rest);
}
function deserialize(v) { return v && typeof v === 'object' ? (v.$f32 ? Float32Array.from(v.$f32) : v.$u8c ? Uint8ClampedArray.from(v.$u8c) : Array.isArray(v) ? v.map(deserialize) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deserialize(x)]))) : v; }

// ───────────────────────── 5. Character library ─────────────────────────
async function library() {
  setTop('Character Library');
  await reloadLibrary();
  const list = h('div', { class: 'stack' });
  for (const pr of S.profiles) {
    const front = pr.refs?.front;
    const thumb = h('div', { class: 'thumb' });
    if (front?.blob) { const u = URL.createObjectURL(front.blob); thumb.style.backgroundImage = `url(${u})`; S.cleanup.push(() => URL.revokeObjectURL(u)); }
    const miss = missingViews(pr);
    list.append(h('div', { class: 'item' }, thumb,
      h('div', { class: 't' }, h('h3', null, pr.name), h('div', { class: 'row small' }, pr.self ? chip('me', 'v') : pr.consent ? chip('consent recorded', 'ok') : chip('consent missing', 'bad'), front?.analysis?.ok ? chip(`face ${front.analysis.quality.score}/100`, front.analysis.quality.score > 70 ? 'ok' : 'warn') : chip('no face', 'warn'), miss.length ? h('span', { class: 'muted' }, `missing: ${miss.join(', ')}`) : null)),
      h('a', { class: 'btn sm', href: `#/character/${pr.id}` }, 'Edit')));
  }
  if (!S.profiles.length) list.append(h('p', { class: 'muted' }, 'No characters yet. Create “Myself” with a front face photo to begin.'));
  return [
    h('h1', null, 'Characters'),
    h('div', { class: 'row' },
      h('a', { class: 'btn primary', href: '#/character/new' }, S.profiles.some(x => x.self) ? '+ New character' : '+ Create “Myself”'),
      fileButton('Import profile', '.json,application/json', async f => {
        try {
          const d = JSON.parse(await f.text()); if (d.format !== 'recast-character') throw new Error('Not a RECAST character file');
          const pr = deserialize(d.profile); pr.id = uid('p'); pr.updatedAt = Date.now();
          for (const [k, r] of Object.entries(d.images || {})) { pr.refs[k] = pr.refs[k] || {}; pr.refs[k].blob = await b64ToBlob(r.b64, r.type); if (pr.refs[k].analysis) { if (r.tex) pr.refs[k].analysis.texBlob = await b64ToBlob(r.tex, 'image/jpeg'); else pr.refs[k].analysis = null; } }
          if (d.hair) pr.hair.png = await b64ToBlob(d.hair, 'image/png');
          if (!pr.self && !pr.consent) toast('Imported without consent: confirm consent before use.', true);
          await db.put('profiles', pr); toast(`Imported ${pr.name}`); route();
        } catch (e) { toast('Import failed: ' + e.message, true); }
      }, { cls: 'btn' })),
    list,
    h('p', { class: 'muted small' }, 'Photos and analysis stay in this browser’s storage. Nothing is uploaded.'),
  ];
}

// ───────────────────────── 6. Character builder ─────────────────────────
async function characterBuilder(id) {
  let pr;
  if (id === 'new') { pr = newProfile(S.profiles.some(x => x.self) ? 'New character' : 'Myself', !S.profiles.some(x => x.self)); await db.put('profiles', pr); await reloadLibrary(); history.replaceState(null, '', `#/character/${pr.id}`); }
  else pr = await db.get('profiles', id);
  if (!pr) throw new Error('Character not found.');
  setTop(pr.name, '#/library');
  const save = async () => { pr.updatedAt = Date.now(); await db.put('profiles', pr); await reloadLibrary(); dropRuntime(); };
  const ms = await modelStatus();
  const wrap = h('div', { class: 'stack' });
  const draw = () => {
    const slots = h('div', { class: 'grid3' }, SLOTS.map(s => {
      const r = pr.refs[s.key];
      const ph = h('div', { class: 'ph' + (r ? ' has' : '') }, r ? '' : s.need);
      if (r?.blob) { const u = URL.createObjectURL(r.blob); ph.style.backgroundImage = `url(${u})`; S.cleanup.push(() => URL.revokeObjectURL(u)); }
      const q = r?.analysis?.quality;
      const isFace = ['front', 'left', 'right', 'hair'].includes(s.key);
      return h('div', { class: 'slot' }, h('div', { class: 'row between' }, h('h3', null, s.label)), ph,
        q ? h('div', { class: 'row' }, chip(r.analysis.ok ? `${q.score}/100` : 'no face', r.analysis.ok && q.score > 70 ? 'ok' : 'warn'), r.analysis.ok ? chip(`yaw ${q.yaw}`) : null) : null,
        q?.issues?.length ? h('p', { class: 'small', style: { color: 'var(--warn)' } }, q.issues.join(' · ')) : null,
        h('p', { class: 'muted small' }, s.used),
        h('div', { class: 'row' },
          fileButton(r ? 'Replace' : 'Add photo', 'image/*', async f => {
            pr.refs[s.key] = { blob: f, name: f.name, at: Date.now() };
            if (isFace && ms.face && s.key !== 'hair') { try { toast('Analyzing face…'); pr.refs[s.key].analysis = await analyzeReference(f); } catch (e) { toast('Analysis failed: ' + e.message, true); } }
            await save(); draw();
          }, { cls: 'btn sm' }),
          r ? h('button', { class: 'btn sm ghost danger', onclick: async () => { delete pr.refs[s.key]; await save(); draw(); } }, 'Delete') : null));
    }));
    const needsAnalysis = ['front', 'left', 'right'].filter(k => pr.refs[k] && !pr.refs[k].analysis);
    const miss = missingViews(pr);
    const hairPrev = h('div', { class: 'checker', style: { borderRadius: '12px', minHeight: '120px', display: 'grid', placeItems: 'center' } });
    const drawHairPrev = async () => {
      if (!pr.hair?.png) { hairPrev.replaceChildren(h('span', { class: 'muted small' }, 'No hair layer')); return; }
      const base = await blobToCanvas(pr.hair.png, 400), s = pr.settings;
      const c = recolorCanvas(base, s.hairColor, s.hairTint, s.hairBright); c.style.maxHeight = '220px'; c.style.width = 'auto';
      hairPrev.replaceChildren(c);
    };
    drawHairPrev();
    const hs = pr.settings;
    const hairCtl = (fn) => (v) => { fn(v); clearTimeout(hairCtl.t); hairCtl.t = setTimeout(async () => { await save(); drawHairPrev(); }, 200); };
    wrap.replaceChildren(
      panel(h('label', { class: 'f' }, 'Character name', h('input', { type: 'text', id: 'cb-name', value: pr.name, oninput: e => { pr.name = e.target.value; clearTimeout(save.t); save.t = setTimeout(save, 400); } })),
        seg([['self', 'This is me'], ['other', 'Another person']], pr.self ? 'self' : 'other', async v => { pr.self = v === 'self'; if (pr.self) pr.consent = { by: 'self', at: Date.now() }; else if (pr.consent?.by === 'self') pr.consent = null; await save(); draw(); }),
        !pr.self ? h('div', { class: 'stack' },
          check(`I confirm ${pr.name || 'this person'} has agreed to have their likeness used in RECAST edits, and I will share the results only as they agreed.`, !!pr.consent, async v => { pr.consent = v ? { by: 'user-confirmed', at: Date.now(), name: pr.name } : null; await save(); draw(); }),
          pr.consent ? h('p', { class: 'muted small mono' }, `Consent recorded ${new Date(pr.consent.at).toLocaleString()}`) : callout('Without consent this character cannot be used in renders.', 'bad')) : null),
      !ms.face ? callout(h('span', null, 'Install the Face Landmarker to analyze photos. ', h('a', { href: '#/models' }, 'Model Manager')), 'warn') : null,
      miss.length ? callout(`Missing views that reduce quality: ${miss.join(', ')}. One selfie is enough for frontal shots only; turned heads need side photos.`, 'warn') : null,
      needsAnalysis.length && ms.face ? h('button', { class: 'btn', onclick: async () => { for (const k of needsAnalysis) { try { pr.refs[k].analysis = await analyzeReference(pr.refs[k].blob); } catch (e) { toast(e.message, true); } } await save(); draw(); } }, `Analyze ${needsAnalysis.length} photo(s)`) : null,
      h('h2', null, 'Reference photos'),
      h('p', { class: 'muted small' }, 'Front face: look at the camera, even light, face filling at least a third of the photo, no glasses or hair over the eyes. Profiles: turn about 45° and 90°.'),
      slots,
      panel(h('h2', null, 'Hair'),
        h('p', { class: 'muted small' }, `Cuts the hair out of ${pr.refs.hair ? 'the hairstyle reference' : 'the front face photo'} with the Multiclass segmenter, then aligns it to the actor’s face every frame.`),
        hairPrev,
        h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !ms.multiclass || !(pr.refs.hair || pr.refs.front), onclick: async ev => {
          ev.target.disabled = true;
          try { const src = pr.refs.hair || pr.refs.front; pr.hair = await extractHair(src.blob, src.analysis); await save(); toast(`Hair extracted (${pr.hair.pixels.toLocaleString()} px)`); draw(); } catch (e) { toast('Hair extraction failed: ' + e.message, true); }
          ev.target.disabled = false;
        } }, pr.hair ? 'Re-extract hair' : 'Extract hair'), !ms.multiclass ? h('a', { class: 'small', href: '#/models' }, 'Needs Selfie Multiclass model') : null,
          pr.hair ? h('button', { class: 'btn sm ghost danger', onclick: async () => { pr.hair = null; await save(); draw(); } }, 'Remove') : null),
        pr.hair ? h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Hair color'), h('input', { type: 'color', value: hs.hairColor, oninput: e => hairCtl(v => (hs.hairColor = v))(e.target.value) })),
          slider('Color strength', hs.hairTint, { min: 0, max: 1, step: 0.05, oninput: hairCtl(v => (hs.hairTint = v)) }),
          slider('Brightness', hs.hairBright, { min: -0.3, max: 0.3, step: 0.01, oninput: hairCtl(v => (hs.hairBright = v)) }),
          slider('Volume', hs.hairVolume, { min: 0.8, max: 1.3, step: 0.01, oninput: hairCtl(v => (hs.hairVolume = v)) }),
          slider('Hairline / fringe', hs.hairFringe, { min: -0.2, max: 0.2, step: 0.005, oninput: hairCtl(v => (hs.hairFringe = v)) }),
          slider('Opacity', hs.hairOpacity, { min: 0, max: 1, step: 0.01, oninput: hairCtl(v => (hs.hairOpacity = v)) }),
          h('p', { class: 'muted small' }, 'Hair length and strand movement are not simulated in v0.1; the layer moves rigidly with the head.')) : null),
      panel(h('h2', null, 'Reference videos'), ...VIDEO_SLOTS.map(v => h('div', { class: 'row between' }, h('div', null, h('h3', null, v.label), h('p', { class: 'muted small' }, pr.videos[v.key] ? `${pr.videos[v.key].name} · ${fmtBytes(pr.videos[v.key].blob.size)}` : v.used)),
        h('div', { class: 'row' }, fileButton(pr.videos[v.key] ? 'Replace' : 'Add', 'video/*', async f => { pr.videos[v.key] = { blob: f, name: f.name }; await save(); draw(); }, { cls: 'btn sm' }), pr.videos[v.key] ? h('button', { class: 'btn sm ghost danger', onclick: async () => { delete pr.videos[v.key]; await save(); draw(); } }, 'Delete') : null)))),
      panel(h('h2', null, 'Wardrobe presets'), h('p', { class: 'muted small' }, 'Used by default when this character is cast in Wardrobe, Full or Group mode.'),
        ...['top', 'bottom'].map(part => h('label', { class: 'f' }, part === 'top' ? 'Top' : 'Bottom', h('select', { onchange: async e => { pr.wardrobePresets = { ...(pr.wardrobePresets || {}), [part]: e.target.value || null }; await save(); } }, h('option', { value: '' }, 'None'), S.wardrobe.filter(w => w.kind === part).map(w => h('option', { value: w.id, selected: pr.wardrobePresets?.[part] === w.id }, w.name)))))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => {
          const images = {};
          for (const [k, r] of Object.entries(pr.refs)) if (r.blob) images[k] = { type: r.blob.type, b64: await blobToB64(r.blob), tex: r.analysis?.texBlob ? await blobToB64(r.analysis.texBlob) : null };
          const clean = JSON.parse(JSON.stringify(serializeProject({ ...pr, refs: Object.fromEntries(Object.entries(pr.refs).map(([k, r]) => [k, { ...r, blob: null, analysis: r.analysis ? { ...r.analysis, texBlob: null } : null }])), hair: pr.hair ? { ...pr.hair, png: null } : null, videos: {} })));
          const data = { format: 'recast-character', version: 1, profile: clean, images, hair: pr.hair?.png ? await blobToB64(pr.hair.png) : null };
          downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${pr.name.replace(/[^\w-]+/g, '_')}.recastchar.json`);
        } }, 'Export profile'),
        h('button', { class: 'btn ghost danger', onclick: async () => { if (!(await confirmBox(`Delete ${pr.name}?`, 'All photos, videos and analysis for this character are removed from this device.'))) return; await db.del('profiles', pr.id); await reloadLibrary(); dropRuntime(); location.hash = '#/library'; } }, 'Delete character')));
  };
  draw();
  return [h('h1', null, 'Character Builder'), wrap];
}

// ───────────────────────── 7. Wardrobe studio ─────────────────────────
const DEFAULT_ANCHORS = { top: [[0.2, 0.1], [0.8, 0.1], [0.78, 0.96], [0.22, 0.96]], bottom: [[0.18, 0.04], [0.82, 0.04], [0.85, 0.97], [0.15, 0.97]] };
async function keyBackground(blob, tol) {
  const c = await blobToCanvas(blob, 1600), ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data, W = c.width, H = c.height;
  if ([...Array(Math.min(2000, d.length / 4)).keys()].some(i => d[i * 4 + 3] < 250)) return { blob, keyed: false };
  const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].map(([x, y]) => [d[(y * W + x) * 4], d[(y * W + x) * 4 + 1], d[(y * W + x) * 4 + 2]]);
  const bg = [0, 1, 2].map(i => corners.reduce((s, c2) => s + c2[i], 0) / 4);
  // flood fill from edges for pixels close to the background color
  const seen = new Uint8Array(W * H), stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x); for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  const close = i => Math.hypot(d[i * 4] - bg[0], d[i * 4 + 1] - bg[1], d[i * 4 + 2] - bg[2]) < tol;
  while (stack.length) { const i = stack.pop(); if (seen[i] || !close(i)) continue; seen[i] = 1; d[i * 4 + 3] = 0; const x = i % W, y = (i / W) | 0; if (x > 0) stack.push(i - 1); if (x < W - 1) stack.push(i + 1); if (y > 0) stack.push(i - W); if (y < H - 1) stack.push(i + W); }
  ctx.putImageData(img, 0, 0);
  return { blob: await new Promise(r => c.toBlob(r, 'image/png')), keyed: true };
}
async function wardrobeStudio(id) {
  setTop('Wardrobe Studio', id ? '#/wardrobe' : null);
  await reloadLibrary();
  if (!id) {
    const list = h('div', { class: 'grid3' });
    for (const w of S.wardrobe) {
      const u = URL.createObjectURL(w.blob); S.cleanup.push(() => URL.revokeObjectURL(u));
      list.append(h('a', { class: 'slot', href: `#/wardrobe/${w.id}`, style: { textDecoration: 'none', color: 'inherit' } }, h('div', { class: 'ph has checker', style: { backgroundImage: `url(${u})`, backgroundSize: 'contain' } }), h('h3', null, w.name), chip(w.kind)));
    }
    return [h('h1', null, 'Wardrobe'),
      h('p', { class: 'muted small' }, 'Upload flat-lay or product photos of garments you own or have rights to use. A plain background is removed automatically.'),
      h('div', { class: 'row' }, ...['top', 'bottom'].map(kind => fileButton(kind === 'top' ? '+ Add top / jacket' : '+ Add pants / skirt', 'image/*', async f => {
        const { blob, keyed } = await keyBackground(f, 38);
        const w = { id: uid('w'), name: f.name.replace(/\.\w+$/, ''), kind, blob, original: f, keyed, tol: 38, anchors: DEFAULT_ANCHORS[kind].map(a => [...a]), createdAt: Date.now() };
        await db.put('wardrobe', w); location.hash = `#/wardrobe/${w.id}`;
      }, { cls: 'btn primary' }))),
      S.wardrobe.length ? list : h('p', { class: 'muted' }, 'No garments yet.'),
      panel(h('h3', null, 'Describe a garment'), h('textarea', { disabled: true, placeholder: 'e.g. black leather jacket with silver zips' }), callout('Text-to-garment generation is disabled: no local image-generation model is installed or validated on this device. Upload a photo instead.', 'warn'))];
  }
  const w = await db.get('wardrobe', id); if (!w) throw new Error('Garment not found');
  const save = async () => { w.updatedAt = Date.now(); await db.put('wardrobe', w); await reloadLibrary(); dropRuntime(); };
  const img = await blobToCanvas(w.blob, 900);
  const cv = h('canvas', { width: img.width, height: img.height, class: 'checker', style: { touchAction: 'none', borderRadius: '12px' } });
  const labels = w.kind === 'top' ? ['L shoulder', 'R shoulder', 'R hem', 'L hem'] : ['L waist', 'R waist', 'R ankle', 'L ankle'];
  const paint = () => {
    const c = cv.getContext('2d'); c.clearRect(0, 0, cv.width, cv.height); c.drawImage(img, 0, 0);
    c.strokeStyle = '#b597ff'; c.lineWidth = 2; c.beginPath(); w.anchors.forEach(([x, y], i) => (i ? c.lineTo(x * cv.width, y * cv.height) : c.moveTo(x * cv.width, y * cv.height))); c.closePath(); c.stroke();
    if (w.kind === 'bottom') { c.setLineDash([5, 5]); const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const l = m(w.anchors[0], w.anchors[3]), r = m(w.anchors[1], w.anchors[2]); c.beginPath(); c.moveTo(l[0] * cv.width, l[1] * cv.height); c.lineTo(r[0] * cv.width, r[1] * cv.height); c.stroke(); c.setLineDash([]); }
    c.font = `600 ${Math.max(12, cv.width / 40)}px -apple-system, sans-serif`;
    w.anchors.forEach(([x, y], i) => { c.fillStyle = '#8d5cff'; c.beginPath(); c.arc(x * cv.width, y * cv.height, Math.max(9, cv.width / 45), 0, 7); c.fill(); c.fillStyle = '#fff'; c.fillText(labels[i], x * cv.width + 14, y * cv.height - 10); });
  };
  let drag = -1;
  const pos = ev => { const r = cv.getBoundingClientRect(); return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)]; };
  cv.addEventListener('pointerdown', ev => { const [x, y] = pos(ev); let best = -1, bd = 0.08; w.anchors.forEach(([ax, ay], i) => { const d = Math.hypot(ax - x, (ay - y) * cv.height / cv.width); if (d < bd) { bd = d; best = i; } }); drag = best; if (drag >= 0) cv.setPointerCapture(ev.pointerId); });
  cv.addEventListener('pointermove', ev => { if (drag < 0) return; w.anchors[drag] = pos(ev); paint(); });
  cv.addEventListener('pointerup', () => { if (drag >= 0) { drag = -1; save(); } });
  paint();
  return [h('h1', null, w.name),
    panel(h('label', { class: 'f' }, 'Name', h('input', { type: 'text', value: w.name, oninput: e => { w.name = e.target.value; clearTimeout(save.t); save.t = setTimeout(save, 400); } })),
      seg([['top', 'Top / jacket'], ['bottom', 'Pants / skirt']], w.kind, async v => { w.kind = v; w.anchors = DEFAULT_ANCHORS[v].map(a => [...a]); await save(); route(); })),
    panel(h('h2', null, 'Fit points'), h('p', { class: 'muted small' }, w.kind === 'top' ? 'Drag the four points onto the shoulder seams and the bottom hem. These map to the actor’s shoulders and hips every frame.' : 'Drag the points to the waistband and the hem. The dashed line marks the knee, mapped to the actor’s knees.'), cv),
    w.original ? panel(h('h2', null, 'Background removal'), h('p', { class: 'muted small' }, w.keyed ? 'Plain background removed by edge flood-fill.' : 'Image already had transparency, so it was kept as-is.'),
      slider('Tolerance', w.tol || 38, { min: 5, max: 120, step: 1, fmt: v => String(v | 0), oninput: v => { clearTimeout(save.k); save.k = setTimeout(async () => { const r = await keyBackground(w.original, v); w.blob = r.blob; w.keyed = r.keyed; w.tol = v; await save(); route(); }, 300); } })) : null,
    h('p', { class: 'muted small' }, 'v0.1 limits: the garment is a 2D layer warped by shoulders, hips, knees and ankles. Sleeves do not follow arms, and back views show the front of the garment.'),
    h('button', { class: 'btn ghost danger', onclick: async () => { if (!(await confirmBox(`Delete ${w.name}?`))) return; await db.del('wardrobe', w.id); await reloadLibrary(); location.hash = '#/wardrobe'; } }, 'Delete garment')];
}

// ───────────────────────── 12. Model manager ─────────────────────────
async function modelManager() {
  setTop('Model Manager');
  const wrap = h('div', { class: 'stack' });
  const draw = async () => {
    const ms = await modelStatus(), st = await storageInfo();
    const cards = MODELS.map(m => {
      const inst = ms[m.key], bar = progressBar(), ptxt = h('span', { class: 'small muted mono' });
      bar.hidden = true;
      return panel(
        h('div', { class: 'row between' }, h('h3', null, m.name), h('div', { class: 'row' }, m.required ? chip('required', 'v') : chip('optional'), inst ? chip('installed', 'ok') : chip('not installed', 'warn'))),
        h('p', { class: 'small muted' }, m.feature),
        h('dl', { class: 'kv' }, h('dt', null, 'Size'), h('dd', null, inst ? fmtBytes(inst.size) : m.approx + ' (download)'), h('dt', null, 'License'), h('dd', null, m.license), h('dt', null, 'Source'), h('dd', null, inst?.source?.startsWith('Imported') ? inst.source : new URL(m.url).host), h('dt', null, 'Runtime'), h('dd', null, mpRuntime.delegate[m.key] || (inst ? 'not started yet' : '—'))),
        bar, ptxt,
        h('div', { class: 'row' },
          h('button', { class: 'btn sm ' + (inst ? '' : 'primary'), onclick: async ev => {
            ev.target.disabled = true; bar.hidden = false;
            try { const n = await downloadModel(m.key, (g, t) => { bar.set(t ? g / t : 0); ptxt.textContent = `${fmtBytes(g)}${t ? ' / ' + fmtBytes(t) : ''}`; }); toast(`${m.name} installed (${fmtBytes(n)})`); }
            catch (e) { toast(`${e.message}. You can download the file in Safari and use Import instead.`, true, 7000); }
            draw();
          } }, inst ? 'Re-download' : 'Install'),
          fileButton('Import file', '.task,.tflite,application/octet-stream', async f => { try { await importModel(m.key, f); toast('Imported'); } catch (e) { toast(e.message, true); } draw(); }, { cls: 'btn sm' }),
          inst ? h('button', { class: 'btn sm', onclick: async ev => {
            ev.target.disabled = true;
            try { const t0 = performance.now(); const task = await getTask(m.key, 'IMAGE'); const c = document.createElement('canvas'); c.width = c.height = 256; c.getContext('2d').fillRect(0, 0, 256, 256); const t1 = performance.now(); if (m.key === 'selfie' || m.key === 'multiclass') task.segment(c, () => {}); else task.detect(c); toast(`${m.name}: started in ${(t1 - t0).toFixed(0)} ms, inference ${(performance.now() - t1).toFixed(0)} ms on ${mpRuntime.delegate[m.key]}`); }
            catch (e) { toast(`${m.name} failed to start: ${e.message}`, true, 7000); }
            draw();
          } }, 'Test') : null,
          inst ? h('button', { class: 'btn sm ghost danger', onclick: async () => { await deleteModel(m.key); toast('Removed'); draw(); } }, 'Remove') : null),
        h('p', { class: 'small muted' }, 'Direct file: ', h('a', { href: m.url, target: '_blank', rel: 'noopener' }, m.url.split('/').pop())));
    });
    wrap.replaceChildren(
      h('h1', null, 'Models'),
      h('p', { class: 'muted small' }, 'Models are downloaded only when you tap Install, from Google’s MediaPipe model storage, then kept in this browser for offline use. The MediaPipe WebAssembly runtime loads from jsDelivr and is cached by the app after first use.'),
      h('dl', { class: 'kv' }, h('dt', null, 'Storage'), h('dd', null, st.quota ? `${fmtBytes(st.usage)} used of ${fmtBytes(st.quota)}` : 'unknown'), h('dt', null, 'Persistent'), h('dd', null, st.persisted ? 'yes' : 'no')),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async ev => { ev.target.disabled = true; for (const m of MODELS.filter(x => x.required || x.key === 'selfie')) if (!ms[m.key]) { try { toast(`Downloading ${m.name}…`); await downloadModel(m.key); } catch (e) { toast(`${m.name}: ${e.message}`, true); } } draw(); } }, 'Install required + segmenter'),
        h('button', { class: 'btn', onclick: async () => { try { await loadVision(); toast('MediaPipe runtime loaded'); } catch (e) { toast(e.message, true, 7000); } } }, 'Load runtime now'),
        h('button', { class: 'btn ghost', onclick: () => { disposeAll(); toast('Released all model memory'); draw(); } }, 'Release memory')),
      ...cards,
      panel(h('h2', null, 'Not available in v0.1'), h('div', { class: 'stack' }, UNAVAILABLE_MODELS.map(u => h('div', null, h('div', { class: 'row' }, h('h3', null, u.name), chip('unavailable', 'bad')), h('p', { class: 'small muted' }, u.why))))));
  };
  await draw();
  return wrap;
}

// ───────────────────────── 13. Settings ─────────────────────────
async function settingsScreen() {
  setTop('Settings');
  const capsBox = h('div', { class: 'stack' }), testBox = h('div', { class: 'stack' });
  const showCaps = r => {
    const groups = [...new Set(r.checks.map(c => c.group))];
    capsBox.replaceChildren(...groups.map(g => h('div', { class: 'stack' }, h('h3', null, g), h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('tbody', null, r.checks.filter(c => c.group === g).map(c => h('tr', null, h('td', null, c.name), h('td', null, chip(c.ok ? 'yes' : 'no', c.ok ? 'ok' : 'warn')), h('td', { class: 'small muted' }, c.detail)))))))), h('p', { class: 'small muted mono' }, r.ua));
  };
  if (S.caps) showCaps(S.caps);
  const st = await storageInfo();
  return [
    h('h1', null, 'Settings'),
    panel(h('h2', null, 'Defaults'),
      h('label', { class: 'f' }, 'Default processing preset', seg(VIDEO_PRESETS.map(k => [k, PRESETS[k].label]), S.settings.preset, k => { S.settings.preset = k; saveSettings(); })),
      check('Burn an “AI-edited” label into exports by default', S.settings.disclosure, v => { S.settings.disclosure = v; saveSettings(); }),
      check('Track hands during actor detection', S.settings.hands, v => { S.settings.hands = v; saveSettings(); })),
    panel(h('h2', null, 'Device capability test'), h('p', { class: 'muted small' }, 'Checks what this browser actually exposes: WebGPU, WebGL2, WebCodecs codecs, storage, and whether the MediaPipe runtime and Mediabunny load.'),
      h('button', { class: 'btn primary', onclick: async ev => { ev.target.disabled = true; capsBox.replaceChildren(h('p', { class: 'muted' }, 'Testing…')); try { S.caps = await capabilityTest(); showCaps(S.caps); } catch (e) { capsBox.replaceChildren(callout(e.message, 'bad')); } ev.target.disabled = false; } }, 'Run capability test'), capsBox),
    panel(h('h2', null, 'Pipeline self-tests'), h('p', { class: 'muted small' }, 'Runs real checks in this browser: storage round-trip, MP4 encode, decode and pixel check, WebGL mesh warp, and model start-up for installed models.'),
      h('button', { class: 'btn', onclick: async ev => { ev.target.disabled = true; testBox.replaceChildren(); await runSelfTests(r => testBox.append(h('div', { class: 'row between' }, h('span', null, r.name), h('span', { class: 'row' }, chip(r.ok ? 'pass' : 'fail', r.ok ? 'ok' : 'bad'), h('span', { class: 'small muted' }, r.detail))))); ev.target.disabled = false; } }, 'Run self-tests'), testBox),
    panel(h('h2', null, 'Storage & privacy'),
      h('dl', { class: 'kv' }, h('dt', null, 'Used'), h('dd', null, st.quota ? `${fmtBytes(st.usage)} of ${fmtBytes(st.quota)}` : 'unknown'), h('dt', null, 'Persistent'), h('dd', null, st.persisted ? 'granted' : 'not granted')),
      h('p', { class: 'muted small' }, 'Everything (videos, photos, face analysis, models, exports) lives in this browser’s IndexedDB on this device. The app makes network requests only to load its code libraries (jsDelivr), fonts (Google Fonts) and models you choose to install (Google storage). No personal media is ever sent.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => toast((await requestPersist()) ? 'Persistent storage granted' : 'Safari declined. Adding to Home Screen improves retention.') }, 'Request persistent storage'),
        h('button', { class: 'btn danger', onclick: async () => { if (!(await confirmBox('Delete all RECAST data?', 'Projects, characters, wardrobe, models and exports on this device will be erased.', 'Erase everything'))) return; disposeAll(); await db.wipe(); S.project = null; S.file = null; await reloadLibrary(); toast('All data erased'); location.hash = '#/'; } }, 'Delete all data'))),
    panel(h('h2', null, 'About & licenses'),
      h('p', { class: 'small' }, 'RECAST AI+ v0.1 · private, local, static web app.'),
      h('ul', { class: 'small muted' },
        h('li', null, 'MediaPipe Tasks Vision (Google) — Apache-2.0. Pose, Face, Hand Landmarker and Image Segmenter models: Apache-2.0, see each model card.'),
        h('li', null, 'Mediabunny (Vanilagy) — MPL-2.0. MP4/MOV demuxing, decoding and encoding via WebCodecs.'),
        h('li', null, 'Fonts: Archivo, IBM Plex Sans, IBM Plex Mono — SIL Open Font License.')),
      h('p', { class: 'small muted' }, 'Use this tool only with footage you may edit and with the consent of everyone whose likeness you add. Label shared results as AI-edited.')),
  ];
}

boot();
