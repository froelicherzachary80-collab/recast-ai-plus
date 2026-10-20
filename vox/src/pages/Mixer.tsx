import { useRef, useState } from 'react';
import { useApp, updateProject, getState, toast } from '../state';
import { runJob, addAsset, newRenderedAsset } from '../actions';
import { Timeline } from '../ui/Timeline';
import { Meter } from '../ui/Meter';
import { Slider, Toggle, FileButton, fmtTime } from '../ui/controls';
import { play, stopAll, decodeFile, type PlayHandle } from '../audio/playback';
import { dsp } from '../dsp/dspClient';
import { makeTrack, type Track } from '../audio/mixer';
import { pcmDuration, type Pcm } from '../audio/pcm';
import { resample } from '../audio/resample';

export const projectEnd = () => { const s = getState(); return Math.max(1, ...s.project.tracks.filter((t) => t.assetId && s.assets.get(t.assetId)).map((t) => t.offset + pcmDuration(s.assets.get(t.assetId!)!))); };
export async function renderProjectMix(range: { start: number; end: number }, skipMaster = false): Promise<Pcm> {
  const s = getState(), ids = [...new Set(s.project.tracks.filter((t) => t.assetId).map((t) => t.assetId!))];
  return dsp<Pcm>('renderMix', { tracks: s.project.tracks, assets: Object.fromEntries(ids.filter((i) => s.assets.has(i)).map((i) => [i, s.assets.get(i)])), master: s.project.master, range, sr: 44100, opts: { skipMaster } });
}

export function Mixer() {
  const p = useApp((s) => s.project), assets = useApp((s) => s.assets);
  const [h, setH] = useState<PlayHandle | null>(null), [pos, setPos] = useState<number | null>(null), [from, setFrom] = useState(0), [len, setLen] = useState(20);
  const raf = useRef(0);
  const setT = (id: string, patch: Partial<Track>) => updateProject((pp) => { const t = pp.tracks.find((x) => x.id === id); if (t) Object.assign(t, patch); });
  const playMix = async () => {
    const end = Math.min(projectEnd(), from + len);
    const out = await runJob('Render mix for playback', async (prog) => { prog(0.3, `Rendering ${fmtTime(from)}–${fmtTime(end)}`); return renderProjectMix({ start: from, end }); });
    if (!out) return;
    const hd = play(out, 0, () => { setH(null); setPos(null); cancelAnimationFrame(raf.current); }); setH(hd);
    const tick = () => { setPos(from + hd.position()); raf.current = requestAnimationFrame(tick); }; raf.current = requestAnimationFrame(tick);
  };
  const conv = p.tracks.find((t) => t.kind === 'converted'), orig = p.tracks.find((t) => t.kind === 'original');
  const [xfade, setXfade] = useState(1);
  return (<>
    <h1>Audio Mixer</h1>
    <p className="sub">Non-destructive: source audio is never modified; every play/export renders from the settings below.</p>
    <div className="card">
      <Timeline tracks={p.tracks} assets={assets} playhead={pos} onOffset={(id, o) => setT(id, { offset: o })} onSeek={(t) => setFrom(Math.max(0, Math.floor(t)))} />
      <div className="row" style={{ marginTop: 10 }}>
        {h ? <button className="btn" onClick={() => { stopAll(); setH(null); }}>■ Stop</button> : <button className="btn pri" onClick={playMix}>▶ Render &amp; play</button>}
        <label className="row" style={{ fontSize: 13 }}>from <input type="number" min={0} value={from} style={{ width: 70 }} onChange={(e) => setFrom(Math.max(0, +e.target.value))} /> s, length <input type="number" min={2} max={600} value={len} style={{ width: 70 }} onChange={(e) => setLen(Math.max(2, +e.target.value))} /> s</label>
        <Meter handle={h} />
        <button className="btn" onClick={() => void runJob('Render full mix', async (prog) => { prog(0.2, 'Rendering'); const out = await renderProjectMix({ start: 0, end: projectEnd() }); await newRenderedAsset(out, `Mix ${new Date().toLocaleTimeString()}`); toast('Mix saved as asset (see Export Studio)', 'ok'); })}>Bounce full mix</button>
        <FileButton label="+ Audio layer…" accept="audio/*" onFile={(f) => void runJob('Add layer', async () => { let pcm = await decodeFile(f); if (pcm.sampleRate !== 44100) pcm = { sampleRate: 44100, channels: pcm.channels.map((c) => resample(c, pcm.sampleRate, 44100)) }; const id = await addAsset(pcm, 'layer', f.name, 'Imported layer'); updateProject((pp) => { pp.tracks.push(makeTrack('layer', f.name, id)); }); }, { cancellable: false })} />
      </div>
      {conv && orig && <div style={{ maxWidth: 420, marginTop: 8 }}><Slider label="Dry/wet: original voice ↔ converted voice" value={xfade} min={0} max={1} fmt={(v) => `${Math.round(v * 100)}% converted`} onChange={(v) => { setXfade(v); updateProject((pp) => { const c = pp.tracks.find((t) => t.kind === 'converted')!, o = pp.tracks.find((t) => t.kind === 'original')!; c.mute = v <= 0.001; o.mute = v >= 0.999; c.gainDb = v > 0 ? 20 * Math.log10(v) : -60; o.gainDb = v < 1 ? 20 * Math.log10(1 - v) : -60; }); }} /></div>}
    </div>
    <div className="strips">
      {p.tracks.map((t) => <Strip key={t.id} t={t} set={(patch) => setT(t.id, patch)} remove={['harmony', 'layer'].includes(t.kind) ? () => updateProject((pp) => { pp.tracks = pp.tracks.filter((x) => x.id !== t.id); }) : undefined} assetName={t.assetId ? p.assets[t.assetId]?.name : undefined} assets={Object.values(p.assets)} />)}
    </div>
  </>);
}

function Strip({ t, set, remove, assetName, assets }: { t: Track; set: (p: Partial<Track>) => void; remove?: () => void; assetName?: string; assets: { id: string; name: string; role: string }[] }) {
  const [open, setOpen] = useState<'eq' | 'dyn' | 'fx' | 'auto' | null>(null);
  return (<div className="strip" style={{ minWidth: 220 }}>
    <div className="row between"><b style={{ fontSize: 13 }}>{t.name}</b>{remove && <button className="btn sm danger" onClick={remove}>✕</button>}</div>
    <select style={{ fontSize: 12, margin: '6px 0' }} value={t.assetId ?? ''} onChange={(e) => set({ assetId: e.target.value || null })}><option value="">— no audio —</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.role}: {a.name}</option>)}</select>
    {!t.assetId && <div style={{ fontSize: 11, color: 'var(--mute)' }}>empty</div>}
    {assetName && <div style={{ fontSize: 11, color: 'var(--mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{assetName}</div>}
    <div className="row"><button className={`btn sm ${t.mute ? 'danger' : ''}`} onClick={() => set({ mute: !t.mute })}>M</button><button className={`btn sm ${t.solo ? 'pri' : ''}`} onClick={() => set({ solo: !t.solo })}>S</button><span className="pill">{t.offset.toFixed(2)} s</span></div>
    <Slider label="Gain" value={t.gainDb} min={-60} max={12} step={0.5} fmt={(v) => `${v.toFixed(1)} dB`} onChange={(v) => set({ gainDb: v })} />
    <Slider label="Pan" value={t.pan} min={-1} max={1} fmt={(v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} onChange={(v) => set({ pan: v })} />
    <div className="row" style={{ marginTop: 4 }}>{(['eq', 'dyn', 'fx', 'auto'] as const).map((k) => <button key={k} className={`btn sm ${open === k ? 'pri' : ''}`} onClick={() => setOpen(open === k ? null : k)}>{k.toUpperCase()}</button>)}</div>
    {open === 'eq' && t.eq.map((b, i) => <div key={i} style={{ borderTop: '1px solid var(--line)', paddingTop: 4 }}>
      <Toggle label={<span style={{ fontSize: 12 }}>{b.type}</span>} checked={b.on} onChange={(v) => set({ eq: t.eq.map((x, j) => (j === i ? { ...x, on: v } : x)) })} />
      <Slider label="Freq" value={Math.log10(b.freq)} min={1.3} max={4.3} fmt={() => `${b.freq.toFixed(0)} Hz`} onChange={(v) => set({ eq: t.eq.map((x, j) => (j === i ? { ...x, freq: Math.round(10 ** v) } : x)) })} />
      {b.type !== 'highpass' && b.type !== 'lowpass' && <Slider label="Gain" value={b.gain} min={-15} max={15} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ eq: t.eq.map((x, j) => (j === i ? { ...x, gain: v } : x)) })} />}
    </div>)}
    {open === 'dyn' && <>
      <Toggle label="Compressor" checked={t.comp.on} onChange={(v) => set({ comp: { ...t.comp, on: v } })} />
      <Slider label="Threshold" value={t.comp.threshold} min={-50} max={0} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ comp: { ...t.comp, threshold: v } })} />
      <Slider label="Ratio" value={t.comp.ratio} min={1} max={20} step={0.1} fmt={(v) => `${v.toFixed(1)}:1`} onChange={(v) => set({ comp: { ...t.comp, ratio: v } })} />
      <Slider label="Attack" value={t.comp.attack * 1000} min={0.5} max={100} step={0.5} fmt={(v) => `${v} ms`} onChange={(v) => set({ comp: { ...t.comp, attack: v / 1000 } })} />
      <Slider label="Release" value={t.comp.release * 1000} min={20} max={1000} step={5} fmt={(v) => `${v} ms`} onChange={(v) => set({ comp: { ...t.comp, release: v / 1000 } })} />
      <Slider label="Makeup" value={t.comp.makeup} min={0} max={18} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ comp: { ...t.comp, makeup: v } })} />
      <Toggle label="De-esser" checked={t.deess.on} onChange={(v) => set({ deess: { ...t.deess, on: v } })} />
      <Slider label="De-ess threshold" value={t.deess.threshold} min={-50} max={-5} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ deess: { ...t.deess, threshold: v } })} />
    </>}
    {open === 'fx' && <>
      <Slider label="Reverb send" value={t.reverbSend} min={0} max={1} onChange={(v) => set({ reverbSend: v })} />
      <Slider label="Delay send" value={t.delaySend} min={0} max={1} onChange={(v) => set({ delaySend: v })} />
      <Slider label="Saturation" value={t.saturation} min={0} max={1} onChange={(v) => set({ saturation: v })} />
      <Slider label="Chorus" value={t.chorus} min={0} max={1} onChange={(v) => set({ chorus: v })} />
      <Slider label="Stereo width" value={t.width} min={0} max={2} onChange={(v) => set({ width: v })} />
    </>}
    {open === 'auto' && <div className="col">
      <div style={{ fontSize: 12, color: 'var(--mute)' }}>Volume automation points (linear in dB)</div>
      {t.automation.map((a, i) => <div className="row" key={i}><input type="number" step={0.1} value={a.t} style={{ width: 70 }} onChange={(e) => set({ automation: t.automation.map((x, j) => (j === i ? { ...x, t: +e.target.value } : x)) })} />s<input type="number" step={0.5} value={a.db} style={{ width: 70 }} onChange={(e) => set({ automation: t.automation.map((x, j) => (j === i ? { ...x, db: +e.target.value } : x)) })} />dB<button className="btn sm" onClick={() => set({ automation: t.automation.filter((_, j) => j !== i) })}>✕</button></div>)}
      <button className="btn sm" onClick={() => set({ automation: [...t.automation, { t: (t.automation.at(-1)?.t ?? t.offset) + 2, db: 0 }] })}>+ point</button>
    </div>}
  </div>);
}
