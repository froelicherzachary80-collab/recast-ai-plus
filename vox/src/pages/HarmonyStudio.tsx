import { useApp, updateProject, toast } from '../state';
import { runJob, addAsset, projectKey } from '../actions';
import { uid } from '../project/defaults';
import { makeTrack } from '../audio/mixer';
import { dsp } from '../dsp/dspClient';
import { Slider, Seg } from '../ui/controls';
import { Player } from '../ui/Player';
import type { HarmonyLayer } from '../project/types';
import type { Pcm } from '../audio/pcm';
import { useEffect, useState } from 'react';
import { get, put } from '../store/db';

const PRESETS: Record<string, Omit<HarmonyLayer, 'id' | 'name'>[]> = {
  'Third above (diatonic)': [{ mode: 'diatonic', interval: 2, gainDb: -8, pan: 0.4, delayMs: 12, humanize: 8, formant: 1 }],
  'Thirds + fifths stack': [{ mode: 'diatonic', interval: 2, gainDb: -9, pan: -0.45, delayMs: 10, humanize: 8, formant: 1 }, { mode: 'diatonic', interval: 4, gainDb: -10, pan: 0.45, delayMs: 18, humanize: 10, formant: 1 }],
  'Octave down': [{ mode: 'semitones', interval: -12, gainDb: -10, pan: 0, delayMs: 0, humanize: 4, formant: 1 }],
  'Double (unison)': [{ mode: 'semitones', interval: 0, gainDb: -6, pan: -0.6, delayMs: 22, humanize: 15, formant: 1.01 }, { mode: 'semitones', interval: 0, gainDb: -6, pan: 0.6, delayMs: 30, humanize: 15, formant: 0.99 }],
};

export function HarmonyStudio() {
  const p = useApp((s) => s.project), assets = useApp((s) => s.assets);
  const [srcId, setSrcId] = useState(p.tracks.find((t) => t.kind === 'converted')?.assetId ?? '');
  const [last, setLast] = useState<Pcm | null>(null), [userPresets, setUserPresets] = useState<Record<string, HarmonyLayer[]>>({});
  useEffect(() => { get<Record<string, HarmonyLayer[]>>('presets', 'harmony').then((v) => setUserPresets(v ?? {})); }, []);
  const vocals = Object.values(p.assets).filter((a) => ['vocals', 'converted', 'converted-dry', 'edited'].includes(a.role));
  const setL = (id: string, patch: Partial<HarmonyLayer>) => updateProject((pp) => { const h = pp.harmonies.find((x) => x.id === id); if (h) Object.assign(h, patch); });
  const add = (l: Omit<HarmonyLayer, 'id' | 'name'>) => updateProject((pp) => { pp.harmonies.push({ ...l, id: uid('hm'), name: `Harmony ${pp.harmonies.length + 1}` }); });
  const renderAll = () => runJob('Render harmonies', async (prog) => {
    const src = assets.get(srcId); if (!src) throw new Error('Choose a source vocal');
    const key = projectKey(), list = p.harmonies;
    const srcTrack = p.tracks.find((t) => t.assetId === srcId);
    for (let i = 0; i < list.length; i++) {
      const h = list[i]; prog(i / list.length, `PSOLA harmony ${i + 1}/${list.length}`);
      const out = await dsp<Pcm>('harmony', { vocal: src, layer: h, key });
      const aid = await addAsset(out, 'harmony', `${h.name} (${h.mode === 'diatonic' ? `${h.interval > 0 ? '+' : ''}${h.interval} scale steps` : `${h.interval} st`})`, 'Algorithmic PSOLA harmony (not neural)');
      updateProject((pp) => {
        let t = pp.tracks.find((x) => x.id === h.trackId);
        if (!t) { t = makeTrack('harmony', h.name, aid); t.comp.on = false; pp.tracks.push(t); const hh = pp.harmonies.find((x) => x.id === h.id)!; hh.trackId = t.id; }
        t.assetId = aid; t.gainDb = h.gainDb; t.pan = h.pan; t.offset = srcTrack?.offset ?? 0; t.reverbSend = 0.25;
      });
      setLast(out);
    }
    toast(`Rendered ${list.length} harmony layer(s) into the mixer`, 'ok');
  });
  return (<>
    <h1>Harmony Studio</h1>
    <p className="sub"><span className="tag dsp">algorithmic</span> Harmonies are generated with formant-preserving PSOLA pitch shifting of your vocal — not neural generative singing.</p>
    <div className="card">
      <div className="row"><select style={{ maxWidth: 360 }} value={srcId} onChange={(e) => setSrcId(e.target.value)}><option value="">— source vocal —</option>{vocals.map((a) => <option key={a.id} value={a.id}>{a.role}: {a.name}</option>)}</select>
        <span className="pill">key: {p.analysis?.key ?? 'unknown (C major assumed)'}</span></div>
      <h3>Presets</h3>
      <div className="row">{Object.entries({ ...PRESETS, ...userPresets }).map(([k, v]) => <button key={k} className="btn sm" onClick={() => v.forEach(add)}>{k}</button>)}
        <button className="btn sm" disabled={!p.harmonies.length} onClick={async () => { const n = prompt('Preset name'); if (!n) return; const next = { ...userPresets, [n]: p.harmonies.map(({ trackId, assetId, ...r }) => r as HarmonyLayer) }; await put('presets', 'harmony', next); setUserPresets(next); toast('Harmony preset saved', 'ok'); }}>Save current as preset</button></div>
    </div>
    <div className="grid">{p.harmonies.map((h) => <div key={h.id} className="card">
      <div className="row between"><input type="text" value={h.name} onChange={(e) => setL(h.id, { name: e.target.value })} style={{ maxWidth: 200 }} /><button className="btn sm danger" onClick={() => updateProject((pp) => { pp.harmonies = pp.harmonies.filter((x) => x.id !== h.id); pp.tracks = pp.tracks.filter((t) => t.id !== h.trackId); })}>Remove</button></div>
      <div style={{ margin: '8px 0' }}><Seg value={h.mode} onChange={(v) => setL(h.id, { mode: v })} options={[{ v: 'diatonic', l: 'Scale steps' }, { v: 'semitones', l: 'Semitones' }]} /></div>
      <Slider label="Interval" value={h.interval} min={h.mode === 'diatonic' ? -7 : -24} max={h.mode === 'diatonic' ? 7 : 24} step={1} fmt={(v) => (h.mode === 'diatonic' ? `${v > 0 ? '+' : ''}${v} steps` : `${v} st`)} onChange={(v) => setL(h.id, { interval: v })} />
      <Slider label="Gain" value={h.gainDb} min={-30} max={6} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => setL(h.id, { gainDb: v })} />
      <Slider label="Pan" value={h.pan} min={-1} max={1} onChange={(v) => setL(h.id, { pan: v })} />
      <Slider label="Delay" value={h.delayMs} min={0} max={60} step={1} fmt={(v) => `${v} ms`} onChange={(v) => setL(h.id, { delayMs: v })} />
      <Slider label="Humanize timing" value={h.humanize} min={0} max={30} step={1} fmt={(v) => `±${v} ms`} onChange={(v) => setL(h.id, { humanize: v })} />
      <Slider label="Formant" value={h.formant} min={0.9} max={1.1} step={0.005} fmt={(v) => `${((v - 1) * 100).toFixed(1)}%`} onChange={(v) => setL(h.id, { formant: v })} />
      <p style={{ fontSize: 12, color: 'var(--mute)' }}>Stereo width / chorus / effects per layer: in the Mixer strip.</p>
    </div>)}</div>
    <div className="card"><div className="row"><button className="btn" onClick={() => add({ mode: 'diatonic', interval: 2, gainDb: -8, pan: 0.3, delayMs: 10, humanize: 8, formant: 1 })}>+ Layer</button><button className="btn pri" disabled={!p.harmonies.length || !srcId} onClick={renderAll}>Render harmonies → mixer</button></div>
      {last && <div style={{ marginTop: 10 }}><Player pcm={last} label="Last rendered layer" /></div>}</div>
  </>);
}
