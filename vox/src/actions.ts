/** Application actions: import, analysis, separation, conversion, save/load, jobs. */
import { getState, setState, toast, updateProject, type Job } from './state';
import { decodeFile } from './audio/playback';
import { resample } from './audio/resample';
import { dbfs, pcmDuration, type Pcm } from './audio/pcm';
import { dsp, cancelDsp } from './dsp/dspClient';
import { all, del, get, loadPcm, put, savePcm } from './store/db';
import { newProject, uid, SYNTH_CHARACTERS } from './project/defaults';
import type { AssetInfo, AssetRole, Project, Singer } from './project/types';
import { listModels } from './ml/modelStore';
import { engine } from './ml/engine';
import { maxLoadedModels } from './ml/caps';
import { convertVocal, type ConversionEvidence } from './pipeline/cover';
import { separateNeural, type SeparationResult } from './pipeline/separate';
import { MDX_PRESETS, type MdxConfig } from './ml/mdx';
import { KEY_NAMES } from './audio/analysis';

let jobSeq = 0;
export async function runJob<T>(name: string, fn: (p: (f: number, stage: string) => void) => Promise<T>, opts: { cancellable?: boolean } = {}): Promise<T | undefined> {
  if (getState().job && !getState().job!.done && !getState().job!.error) { toast('Another job is running — wait or cancel it first', 'err'); return; }
  const job: Job = { id: ++jobSeq, name, stage: 'Starting…', progress: 0, startedAt: performance.now(), cancellable: opts.cancellable ?? true };
  const retry = () => { void runJob(name, fn, opts); };
  setState({ job });
  let last = 0;
  let pendingUpd: any = null;
  const apply = (f: number, stage: string) => setState((s) => (s.job?.id === job.id && !s.job.error ? { job: { ...s.job, progress: f, stage } } : {}));
  const prog = (f: number, stage: string) => { // throttled, but the latest update is always delivered
    const now = performance.now(); clearTimeout(pendingUpd);
    if (now - last >= 80 || f >= 1) { last = now; apply(f, stage); } else pendingUpd = setTimeout(() => { last = performance.now(); apply(f, stage); }, 80);
  };
  try {
    await new Promise((r) => setTimeout(r, 30));
    const r = await fn(prog);
    clearTimeout(pendingUpd);
    setState((s) => ({ job: s.job?.id === job.id ? { ...s.job, progress: 1, stage: `Finished in ${((performance.now() - job.startedAt) / 1000).toFixed(1)} s`, done: true } : s.job }));
    setTimeout(() => setState((s) => (s.job?.id === job.id && s.job.done ? { job: null } : {})), 2500);
    return r;
  } catch (e: any) {
    const msg = e?.cancelled || /cancel/i.test(e?.message) ? 'Cancelled' : explainError(e);
    setState((s) => ({ job: s.job?.id === job.id ? { ...s.job, error: msg, retry } : s.job }));
    if (msg !== 'Cancelled') toast(`${name} failed: ${msg}`, 'err');
    logProject(`${name} failed: ${msg}`);
  }
}

export function explainError(e: any): string {
  const m = String(e?.message ?? e);
  if (/memory|alloc|RangeError|Out of/i.test(m)) return `${m} — the device ran out of memory. Enable Memory-saving mode, choose LIGHT quality, or process a shorter range.`;
  if (/webgpu/i.test(m)) return `${m} — try the WASM backend in Settings.`;
  return m;
}

export function cancelJob() { engine.cancel(); cancelDsp(); setState((s) => ({ job: s.job ? { ...s.job, error: 'Cancelled' } : null })); }
export function dismissJob() { setState({ job: null }); }

export function logProject(msg: string) { updateProject((p) => { p.log = [...p.log.slice(-200), { t: Date.now(), msg }]; }); }

export async function addAsset(pcm: Pcm, role: AssetRole, name: string, provenance: string): Promise<string> {
  const id = uid('ast');
  const info: AssetInfo = { id, name, role, duration: pcmDuration(pcm), sampleRate: pcm.sampleRate, channels: pcm.channels.length, createdAt: Date.now(), provenance };
  setState((s) => { const m = new Map(s.assets); m.set(id, pcm); return { assets: m }; });
  updateProject((p) => { p.assets[id] = info; });
  await savePcm(id, pcm, name).catch((e) => toast(`Could not persist audio (${e.message}); it stays in memory only`, 'err'));
  await saveProject();
  return id;
}

export async function removeAsset(id: string) {
  setState((s) => { const m = new Map(s.assets); m.delete(id); return { assets: m }; });
  updateProject((p) => { delete p.assets[id]; p.tracks.forEach((t) => { if (t.assetId === id) t.assetId = null; }); });
  await del('assets', id); await saveProject();
}

export function assignTrack(kind: string, assetId: string | null) {
  updateProject((p) => { const t = p.tracks.find((x) => x.kind === kind); if (t) t.assetId = assetId; });
}

export const assetsByRole = (role: AssetRole) => Object.values(getState().project.assets).filter((a) => a.role === role).sort((a, b) => b.createdAt - a.createdAt);
export const latest = (role: AssetRole) => assetsByRole(role)[0] ?? null;

export async function importSong(file: File) {
  return runJob('Import song', async (prog) => {
    prog(0.1, `Decoding ${file.name} locally`);
    let pcm = await decodeFile(file);
    const nativeSr = pcm.sampleRate, nativeCh = pcm.channels.length;
    if (pcm.sampleRate !== 44100) { prog(0.3, `Resampling ${pcm.sampleRate} → 44100 Hz`); pcm = await dsp('resample', { pcm, to: 44100 }); }
    const id = await addAsset(pcm, 'mix', file.name, `Imported file (${nativeSr} Hz, ${nativeCh} ch)`);
    prog(0.5, 'Analysing tempo, key, loudness');
    await analyzeAsset(id, nativeSr, nativeCh);
    updateProject((p) => { if (p.name.startsWith('Untitled')) p.name = file.name.replace(/\.[^.]+$/, ''); });
    logProject(`Imported ${file.name}`);
    toast(`Imported ${file.name}`, 'ok');
    return id;
  }, { cancellable: false });
}

export async function analyzeAsset(id: string, nativeSr?: number, nativeCh?: number) {
  const pcm = getState().assets.get(id); if (!pcm) return;
  const a: any = await dsp('analyze', { pcm });
  updateProject((p) => { p.analysis = { duration: pcmDuration(pcm), sampleRate: nativeSr ?? pcm.sampleRate, channels: nativeCh ?? pcm.channels.length, peakDb: dbfs(a.peak), bpm: a.bpm, bpmConfidence: a.bpmConfidence, key: a.key, keyConfidence: a.keyConfidence, keyAlternatives: a.keyAlternatives, lufs: a.lufs, truePeakDb: dbfs(a.truePeak) }; });
  await saveProject();
}

export function projectKey(): { tonic: number; mode: 'major' | 'minor' } | null {
  const k = getState().project.analysis?.key; if (!k) return null;
  const [n, m] = k.split(' '); const t = KEY_NAMES.indexOf(n);
  return t >= 0 ? { tonic: t, mode: m as 'major' | 'minor' } : null;
}

export async function importStem(file: File, role: 'vocals' | 'instrumental') {
  return runJob(`Import ${role} stem`, async (prog) => {
    prog(0.2, 'Decoding'); let pcm = await decodeFile(file);
    if (pcm.sampleRate !== 44100) pcm = await dsp('resample', { pcm, to: 44100 });
    const id = await addAsset(pcm, role, file.name, 'Manually supplied stem');
    assignTrack(role === 'vocals' ? 'original' : 'instrumental', id);
    await saveProject(); toast(`${role} stem set`, 'ok');
  }, { cancellable: false });
}

export async function runSeparation(method: 'neural' | 'dsp', modelId?: string, cfgName?: string, range?: { start: number; end: number } | null) {
  const mixInfo = latest('mix'); if (!mixInfo) { toast('Import a song first', 'err'); return; }
  let mix = getState().assets.get(mixInfo.id)!;
  if (range) { const a = Math.floor(range.start * mix.sampleRate), b = Math.floor(range.end * mix.sampleRate); mix = { sampleRate: mix.sampleRate, channels: mix.channels.map((c) => c.slice(a, b)) }; }
  return runJob(method === 'neural' ? 'Neural separation' : 'DSP centre extraction', async (prog) => {
    let r: SeparationResult;
    if (method === 'neural') {
      const model = getState().models.find((m) => m.id === modelId);
      if (!model) throw new Error('Choose an imported MDX-Net separation model (Model Manager)');
      const cfg: MdxConfig = { ...MDX_PRESETS[cfgName ?? Object.keys(MDX_PRESETS)[0]] };
      r = await separateNeural(mix, model, cfg, getState().settings.backend, maxLoaded(), prog);
    } else {
      prog(0.2, 'STFT centre-channel extraction (DSP, not AI)');
      const o = await dsp<{ vocals: Pcm; instrumental: Pcm }>('centerExtract', { mix });
      r = { ...o, method: 'DSP centre-channel extraction (NOT AI)', neural: false, ms: 0, backend: 'cpu-dsp' };
    }
    prog(0.97, 'Saving stems');
    const tag = range ? ` [${range.start.toFixed(0)}–${range.end.toFixed(0)} s]` : '';
    const v = await addAsset(r.vocals, 'vocals', `Vocals – ${r.method}${tag}`, r.method);
    const i = await addAsset(r.instrumental, 'instrumental', `Instrumental – ${r.method}${tag}`, r.method);
    assignTrack('original', v); assignTrack('instrumental', i);
    if (range) updateProject((p) => p.tracks.forEach((t) => { if (t.assetId === v || t.assetId === i) t.offset = range.start; }));
    await saveProject();
    logProject(`Separation via ${r.method} (${r.backend})`);
    toast(`Separated with ${r.method}`, 'ok');
  });
}

export const maxLoaded = () => { const s = getState(); return s.caps ? maxLoadedModels(s.caps, s.settings.memorySaving) : 1; };

export function singerById(id: string | null): Singer | undefined { return [...getState().singers, ...SYNTH_CHARACTERS].find((s) => s.id === id); }

export interface ConversionOutcome { evidence: ConversionEvidence; report: string[]; dryId: string; procId: string; }
export async function runConversion(preview: boolean, range?: { start: number; end: number } | null, f0Override?: Float32Array | null): Promise<ConversionOutcome | undefined> {
  const s = getState(), p = s.project;
  const vt = p.tracks.find((t) => t.kind === 'original'), vocal = vt?.assetId ? s.assets.get(vt.assetId) : null;
  if (!vocal) { toast('No vocal stem yet — separate the song or supply the vocal stem', 'err'); return; }
  const singer = singerById(p.singerId); if (!singer) { toast('Select an AI singer first', 'err'); return; }
  const dur = pcmDuration(vocal);
  const rg = range ?? (preview ? { start: 0, end: Math.min(dur, p.cover.previewSec) } : null);
  return runJob(preview ? 'Preview conversion' : 'Full conversion', async (prog) => {
    const models = { voice: s.models.find((m) => m.id === singer.voiceModelId), content: s.models.find((m) => m.id === singer.contentModelId) };
    const r = await convertVocal({ vocal, settings: { ...p.cover, backend: s.settings.backend }, singer, models, key: projectKey(), notes: p.editAssetId === vt!.assetId ? p.notes : [], f0Override, rangeSec: rg, maxLoaded: maxLoaded(), onProgress: prog });
    const tag = rg ? ` [${rg.start.toFixed(1)}–${rg.end.toFixed(1)} s]` : '';
    const dryId = await addAsset(r.dry, 'converted-dry', `Dry ${singer.name}${tag}`, r.evidence.engine);
    const procId = await addAsset(r.processed, 'converted', `${singer.name}${tag}`, `${r.evidence.engine} + HUMANVOICE`);
    updateProject((pp) => {
      const t = pp.tracks.find((x) => x.kind === 'converted'); if (t) { t.assetId = procId; t.offset = rg?.start ?? 0; t.name = `Converted – ${singer.name}`; }
    });
    if (singer.id && !singer.id.startsWith('builtin_')) await saveSinger({ ...singer, recentProjects: [p.id, ...singer.recentProjects.filter((x) => x !== p.id)].slice(0, 10) });
    if (s.settings.memorySaving) await engine.unloadAll();
    logProject(`Conversion ${tag || '(full)'}: ${r.evidence.engine}, NRMS diff ${r.evidence.diffFromSource.toFixed(2)}, melody err ${r.evidence.melodyMedianCentsError?.toFixed(0) ?? 'n/a'} c`);
    await saveProject();
    return { evidence: r.evidence, report: r.report, dryId, procId };
  });
}

// ---- persistence ----
let saveTimer: any = null;
export async function saveProject() {
  const p = getState().project;
  await put('projects', p.id, p); await put('kv', 'lastProject', p.id);
}
export function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (getState().settings.autoSave) void saveProject(); }, 800); }

export async function openProject(id: string) {
  const p = await get<Project>('projects', id); if (!p) { toast('Project not found', 'err'); return; }
  const assets = new Map<string, Pcm>();
  for (const aid of Object.keys(p.assets)) { const pcm = await loadPcm(aid); if (pcm) assets.set(aid, pcm); }
  await engine.unloadAll().catch(() => {});
  setState({ project: p, assets });
  await put('kv', 'lastProject', id);
  const missing = Object.keys(p.assets).length - assets.size;
  if (missing) toast(`${missing} audio asset(s) missing from local storage`, 'err');
}

export async function createProject() { await saveProject(); setState({ project: newProject(), assets: new Map() }); await saveProject(); }

export async function deleteProject(id: string) {
  const p = await get<Project>('projects', id); if (!p) return;
  for (const aid of Object.keys(p.assets)) await del('assets', aid);
  await del('projects', id);
  if (getState().project.id === id) setState({ project: newProject(), assets: new Map() });
}

export async function loadLibrary() {
  const [singers, models] = await Promise.all([all<Singer>('singers'), listModels()]);
  setState({ singers: singers.sort((a, b) => b.updatedAt - a.updatedAt), models });
  const settings = await get<any>('kv', 'settings'); if (settings) setState((s) => ({ settings: { ...s.settings, ...settings } }));
  const last = await get<string>('kv', 'lastProject'); if (last) await openProject(last).catch(() => {});
}
export async function saveSettings() { await put('kv', 'settings', getState().settings); }

export async function saveSinger(s: Singer) {
  s = { ...s, updatedAt: Date.now() }; await put('singers', s.id, s);
  setState((st) => ({ singers: [s, ...st.singers.filter((x) => x.id !== s.id)] }));
}
export async function deleteSinger(id: string) {
  const s = getState().singers.find((x) => x.id === id);
  for (const a of s?.sampleAssetIds ?? []) await del('assets', a);
  await del('singers', id); setState((st) => ({ singers: st.singers.filter((x) => x.id !== id) }));
}
export async function refreshModels() { setState({ models: await listModels() }); }

export async function newRenderedAsset(pcm: Pcm, name: string, role: AssetRole = 'render') { return addAsset(pcm, role, name, 'Rendered locally'); }

export const resampleTo = (p: Pcm, sr: number): Pcm => (p.sampleRate === sr ? p : { sampleRate: sr, channels: p.channels.map((c) => resample(c, p.sampleRate, sr)) });
