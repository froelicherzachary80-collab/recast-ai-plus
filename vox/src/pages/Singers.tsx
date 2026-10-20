import { useState } from 'react';
import { useApp, toast, updateProject } from '../state';
import { saveSinger, deleteSinger, refreshModels, runJob } from '../actions';
import { newSinger, uid, SYNTH_CHARACTERS } from '../project/defaults';
import { exportSinger, importSingerFile } from '../project/singerFile';
import { downloadBlob } from '../audio/playback';
import { midiName } from '../audio/f0';
import { HV_PRESETS } from '../audio/humanvoice';
import { Slider, FileButton } from '../ui/controls';
import { go } from '../App';
import type { Singer, SingerMode } from '../project/types';

async function avatarFromFile(f: File): Promise<string> {
  const img = await createImageBitmap(f), c = document.createElement('canvas'), s = 256; c.width = c.height = s;
  const g = c.getContext('2d')!, k = Math.max(s / img.width, s / img.height);
  g.drawImage(img, (s - img.width * k) / 2, (s - img.height * k) / 2, img.width * k, img.height * k);
  return c.toDataURL('image/jpeg', 0.85);
}

export function Avatar({ s, size = 56 }: { s: Singer; size?: number }) {
  return s.avatar ? <img className="avatar" style={{ width: size, height: size }} src={s.avatar} alt="" /> : <div className="avatar" style={{ width: size, height: size }}>{s.name.slice(0, 1).toUpperCase()}</div>;
}

export function SingerForm({ initial, onSaved, onCancel }: { initial: Singer; onSaved?: (s: Singer) => void; onCancel?: () => void }) {
  const models = useApp((st) => st.models);
  const [s, setS] = useState<Singer>(initial);
  const [statement, setStatement] = useState(initial.permission?.statement ?? '');
  const [perm, setPerm] = useState(!!initial.permission?.confirmed);
  const rvc = models.filter((m) => m.kind === 'rvc'), content = models.filter((m) => m.kind === 'content');
  const set = (p: Partial<Singer>) => setS((x) => ({ ...x, ...p }));
  const mode: SingerMode = s.voiceModelId && s.contentModelId ? 'neural-rvc' : s.mode === 'dsp-character' ? 'dsp-character' : 'analysis-only';
  const save = async () => {
    if (!s.name.trim()) return toast('Name required', 'err');
    if (!perm) return toast('Confirm the voice permission statement first', 'err');
    const out: Singer = { ...s, mode, permission: { confirmed: true, statement, at: Date.now() } };
    await saveSinger(out); toast(`Saved ${out.name}`, 'ok'); onSaved?.(out);
  };
  return (<div className="col">
    <div className="row"><Avatar s={s} size={72} /><FileButton label="Avatar image…" accept="image/*" onFile={async (f) => set({ avatar: await avatarFromFile(f) })} />{s.avatar && <button className="btn sm" onClick={() => set({ avatar: null })}>Remove</button>}</div>
    <div className="ctlgrid">
      <label className="col">Name<input type="text" value={s.name} onChange={(e) => set({ name: e.target.value })} /></label>
      <label className="col">Voice type<select value={s.voiceType} onChange={(e) => set({ voiceType: e.target.value })}>{['Soprano', 'Mezzo-soprano', 'Alto', 'Countertenor', 'Tenor', 'Baritone', 'Bass', 'Synthetic', 'Other'].map((v) => <option key={v}>{v}</option>)}</select></label>
      <label className="col">Default style<select value={s.defaultStyle} onChange={(e) => set({ defaultStyle: e.target.value })}>{Object.keys(HV_PRESETS).map((v) => <option key={v}>{v}</option>)}</select></label>
      <label className="col">Vocal presentation (optional)<select value={s.presentation} onChange={(e) => set({ presentation: e.target.value })}>{['Unspecified', 'Feminine', 'Masculine', 'Androgynous'].map((v) => <option key={v}>{v}</option>)}</select></label>
    </div>
    <label className="col">Description<textarea value={s.description} onChange={(e) => set({ description: e.target.value })} /></label>
    <div className="ctlgrid">
      <Slider label="Comfortable range low" value={s.rangeLow} min={28} max={84} step={1} fmt={midiName} onChange={(v) => set({ rangeLow: v })} />
      <Slider label="Comfortable range high" value={s.rangeHigh} min={36} max={96} step={1} fmt={midiName} onChange={(v) => set({ rangeHigh: v })} />
    </div>
    <h3>Voice model association</h3>
    <div className="ctlgrid">
      <label className="col">RVC voice model<select value={s.voiceModelId ?? ''} onChange={(e) => set({ voiceModelId: e.target.value || null })}><option value="">— none (analysis profile only) —</option>{rvc.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label className="col">Content encoder<select value={s.contentModelId ?? ''} onChange={(e) => set({ contentModelId: e.target.value || null })}><option value="">— none —</option>{content.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label className="col">Speaker id (multi-speaker models)<input type="number" min={0} value={s.speakerId} onChange={(e) => set({ speakerId: Math.max(0, +e.target.value || 0) })} /></label>
    </div>
    {!rvc.length && <p className="note warn">No RVC model installed. <a onClick={() => go('models')}>Import one</a> trained on a voice you are authorised to use.</p>}
    <p className="note">Status after save: <b>{mode === 'neural-rvc' ? 'Neural voice (trained RVC model attached)' : mode === 'dsp-character' ? 'DSP character' : 'Analysis profile only — NOT a trained voice, cannot convert'}</b></p>
    <label className="col">Permission statement<textarea placeholder="e.g. This is my own voice, recorded by me on 2026-10-01." value={statement} onChange={(e) => setStatement(e.target.value)} /></label>
    <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={perm} onChange={(e) => setPerm(e.target.checked)} /> I confirm this voice is mine or I have explicit permission from its owner. It is not an unauthorised celebrity/third-party voice. Output will be labelled as synthetic.</label>
    <div className="row"><button className="btn pri" onClick={save}>Save singer</button>{onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}</div>
  </div>);
}

export function Singers() {
  const singers = useApp((s) => s.singers), models = useApp((s) => s.models), current = useApp((s) => s.project.singerId);
  const [edit, setEdit] = useState<Singer | null>(null);
  if (edit) return (<><h1>{singers.some((x) => x.id === edit.id) ? 'Edit singer' : 'New singer'}</h1><div className="card"><SingerForm initial={edit} onSaved={() => setEdit(null)} onCancel={() => setEdit(null)} /></div></>);
  const compat = (s: Singer) => {
    if (s.mode === 'dsp-character') return <span className="pill">DSP character</span>;
    const v = models.find((m) => m.id === s.voiceModelId), c = models.find((m) => m.id === s.contentModelId);
    if (!s.voiceModelId) return <span className="pill warn">analysis only</span>;
    if (!v || !c) return <span className="pill err">model missing on device</span>;
    const vd = (v.details as any)?.featureDim, cd = 768;
    return <span className="pill ok">neural RVC{vd && vd !== cd ? ` · needs ${vd}-d encoder` : ''}</span>;
  };
  return (<>
    <h1>My AI Singers</h1>
    <p className="sub">Voice profiles stored on this device. Unlimited, subject to storage. No celebrity voices are included.</p>
    <div className="row" style={{ marginBottom: 12 }}>
      <button className="btn pri" onClick={() => setEdit(newSinger())}>New singer</button>
      <button className="btn" onClick={() => go('lab')}>Voice Clone Laboratory</button>
      <FileButton label="Import singer file…" accept=".zsinger,application/octet-stream" onFile={(f) => void runJob('Import singer', async () => { const r = await importSingerFile(f, models); await saveSinger(r.singer); await refreshModels(); toast(`Imported ${r.singer.name} (${r.importedModels.length} model files)`, 'ok'); })} />
    </div>
    <div className="list">
      {[...singers, ...SYNTH_CHARACTERS].map((s) => {
        const builtin = s.id.startsWith('builtin_');
        return (<div className="item" key={s.id}>
          <div className="row" style={{ flex: 1, minWidth: 0 }}><Avatar s={s} />
            <div style={{ minWidth: 0 }}><b>{s.name}</b> {compat(s)} {current === s.id && <span className="pill vio">in project</span>}
              <div style={{ fontSize: 12, color: 'var(--mute)' }}>{s.voiceType} · {midiName(s.rangeLow)}–{midiName(s.rangeHigh)} · style {s.defaultStyle}{s.analysis ? ` · ${s.analysis.durationSec.toFixed(0)} s analysed` : ''}{s.recentProjects.length ? ` · ${s.recentProjects.length} recent projects` : ''}</div>
              {s.description && <div style={{ fontSize: 12, color: 'var(--dim)' }}>{s.description}</div>}</div></div>
          <div className="row">
            <button className="btn sm" onClick={() => updateProject((p) => { p.singerId = s.id; p.cover = { ...p.cover, rangeLow: s.rangeLow, rangeHigh: s.rangeHigh, ...s.preset }; })}>Use</button>
            {!builtin && <>
              <button className="btn sm" onClick={() => setEdit(s)}>Edit</button>
              <button className="btn sm" onClick={() => void saveSinger({ ...structuredClone(s), id: uid('sgr'), name: `${s.name} (copy)`, createdAt: Date.now() })}>Duplicate</button>
              <button className="btn sm" onClick={() => void runJob('Export singer', async () => downloadBlob(await exportSinger(s, models, { samples: false, models: false }), `${s.name}.zsinger`))}>Export profile</button>
              <button className="btn sm" onClick={() => void runJob('Backup singer', async () => downloadBlob(await exportSinger(s, models, { samples: true, models: true }), `${s.name}-backup.zsinger`))}>Backup (+samples, models)</button>
              <button className="btn sm danger" onClick={() => { if (confirm(`Delete ${s.name}? Samples are removed; models stay in Model Manager.`)) void deleteSinger(s.id); }}>Delete</button>
            </>}
          </div>
        </div>);
      })}
    </div>
  </>);
}
