import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, updateProject, toast, getState } from '../state';
import { runJob, addAsset, runConversion, projectKey, singerById } from '../actions';
import { analyzeForEditor } from '../pipeline/editRender';
import { segmentNotes, buildTargetCurve, scalePitchClasses, newNoteId, type Note } from '../audio/notes';
import { midiName, type F0Track } from '../audio/f0';
import { toMono, type Pcm } from '../audio/pcm';
import { dsp } from '../dsp/dspClient';
import { play, stopAll } from '../audio/playback';
import { PianoRoll, type Tool } from '../ui/PianoRoll';
import { Slider, Seg, Toggle } from '../ui/controls';
import { Player } from '../ui/Player';
import { KEY_NAMES } from '../audio/analysis';

export function EditorCore({ mode }: { mode: 'notes' | 'pitch' }) {
  const p = useApp((s) => s.project), assets = useApp((s) => s.assets);
  const editable = Object.values(p.assets).filter((a) => ['vocals', 'converted', 'converted-dry', 'edited', 'harmony'].includes(a.role));
  const [srcId, setSrcId] = useState<string>(p.editAssetId ?? p.tracks.find((t) => t.kind === 'original')?.assetId ?? editable[0]?.id ?? '');
  const [tr, setTr] = useState<F0Track | null>(null), [wave, setWave] = useState<Float32Array | null>(null);
  const [notes, setNotes] = useState<Note[]>(p.editAssetId === srcId ? p.notes : []);
  const [sel, setSel] = useState<string | null>(null), [tool, setTool] = useState<Tool>('move');
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [full, setFull] = useState(false), [rendered, setRendered] = useState<Pcm | null>(null);
  const [correction, setCorrection] = useState(0), [vibrato, setVibrato] = useState(1), [useScale, setUseScale] = useState(true);
  const k = projectKey(); const [tonic, setTonic] = useState(k?.tonic ?? 0), [modeK, setModeK] = useState<'major' | 'minor'>(k?.mode ?? 'major');
  const undo = useRef<Note[][]>([]), redo = useRef<Note[][]>([]);
  const src = assets.get(srcId);
  const scale = useScale ? scalePitchClasses(tonic, modeK) : null;

  useEffect(() => {
    if (!src) { setTr(null); return; }
    const a = analyzeForEditor(src); setTr(a.tr); setWave(toMono(src));
    if (!(p.editAssetId === srcId && p.notes.length)) setNotes(segmentNotes(a.tr));
    undo.current = []; redo.current = [];
  }, [srcId, src]);
  useEffect(() => { updateProject((pp) => { pp.notes = notes; pp.editAssetId = srcId; }); }, [notes]);

  const target = useMemo(() => tr ? buildTargetCurve(tr, { notes, correction, scale, vibratoScale: vibrato }) : null, [tr, notes, correction, vibrato, tonic, modeK, useScale]);
  const commit = (n: Note[]) => { undo.current.push(notes); redo.current = []; setNotes(n); };
  const selNote = notes.find((n) => n.id === sel) ?? null;
  const patchSel = (patch: Partial<Note>) => selNote && commit(notes.map((n) => (n.id === sel ? { ...n, ...patch } : n)));
  const split = (id: string, t: number) => { const n = notes.find((x) => x.id === id)!; if (t <= n.start + 0.03 || t >= n.end - 0.03) return; commit(notes.flatMap((x) => (x.id !== id ? [x] : [{ ...x, end: t }, { ...x, id: newNoteId(), start: t }]))); };
  const merge = () => { if (!selNote) return; const i = notes.findIndex((n) => n.id === sel), nx = notes[i + 1]; if (!nx) return toast('No following note to merge with', 'err'); commit([...notes.slice(0, i), { ...selNote, end: nx.end, midi: (selNote.midi * (selNote.end - selNote.start) + nx.midi * (nx.end - nx.start)) / (nx.end - selNote.start) }, ...notes.slice(i + 2)]); };

  const render = (onlyRange: boolean) => runJob(onlyRange ? 'Render phrase preview' : 'Render edited vocal', async (prog) => {
    if (!src || !tr) throw new Error('No source');
    let pcm = src, ns = notes, t = tr, off = 0;
    if (onlyRange && range) {
      const a = Math.floor(range.start * src.sampleRate), b = Math.floor(range.end * src.sampleRate), fa = Math.floor(range.start * 100), fb = Math.ceil(range.end * 100);
      pcm = { sampleRate: src.sampleRate, channels: src.channels.map((c) => c.slice(a, b)) }; off = range.start;
      t = { ...tr, f0: tr.f0.slice(fa, fb), voiced: tr.voiced.slice(fa, fb), periodicity: tr.periodicity.slice(fa, fb) };
      ns = notes.filter((n) => n.end > range.start && n.start < range.end).map((n) => ({ ...n, start: n.start - off, end: n.end - off }));
    }
    prog(0.2, 'PSOLA rendering (DSP)');
    const out = await dsp<Pcm>('editRender', { pcm, tr: t, notes: ns, opts: { correction, scale, vibrato } });
    setRendered(out);
    if (!onlyRange) { const id = await addAsset(out, 'edited', `Edited – ${p.assets[srcId]?.name}`, 'Pitch editor PSOLA render (DSP)'); toast('Edited vocal saved as new asset (original untouched)', 'ok'); void id; }
    else play(out);
  });

  const reconvert = async () => {
    if (srcId !== p.tracks.find((t) => t.kind === 'original')?.assetId) return toast('Neural re-render uses the original vocal stem — select it as the edit source', 'err');
    const sg = singerById(getState().project.singerId); if (!sg) return toast('Pick a singer in AI Cover Studio', 'err');
    const r = await runConversion(false, range, range ? null : target);
    if (r) toast(`Re-converted with edited pitch (${r.evidence.engine})`, 'ok');
  };

  const height = full ? Math.max(300, window.innerHeight - 260) : 340;
  const body = (<>
    <div className="row">
      <select style={{ maxWidth: 320 }} value={srcId} onChange={(e) => setSrcId(e.target.value)}>{editable.map((a) => <option key={a.id} value={a.id}>{a.role}: {a.name}</option>)}</select>
      <Seg value={tool} onChange={setTool} options={[{ v: 'move', l: 'Move' }, { v: 'split', l: 'Split' }, { v: 'range', l: 'Range' }]} />
      <button className="btn sm" disabled={!selNote} onClick={merge}>Merge →</button>
      <button className="btn sm" disabled={!undo.current.length} onClick={() => { redo.current.push(notes); setNotes(undo.current.pop()!); }}>↶ Undo</button>
      <button className="btn sm" disabled={!redo.current.length} onClick={() => { undo.current.push(notes); setNotes(redo.current.pop()!); }}>↷ Redo</button>
      <button className="btn sm" onClick={() => { if (tr) commit(segmentNotes(tr)); }}>Re-detect notes</button>
      <button className="btn sm" onClick={() => setFull(!full)}>{full ? 'Exit full screen' : 'Full screen'}</button>
    </div>
    {!src ? <p className="note warn">No vocal asset yet. Separate a song or import stems in AI Cover Studio.</p> :
      <PianoRoll tr={tr} target={target} notes={notes} selected={sel} scale={scale} wave={wave} waveSr={src.sampleRate} tool={tool} range={range} playhead={null} height={height}
        onSelect={setSel} onChange={(n, c) => (c ? commit(n) : setNotes(n))} onSplit={split} onRange={setRange} />}
    <div className="row" style={{ fontSize: 12, color: 'var(--mute)' }}>Drag notes up/down (snap to semitone; hold Shift for fine) and sideways (timing ±250 ms) · pinch or wheel to zoom · drag empty area to scroll · Range tool selects a phrase.</div>
  </>);

  return (<>
    {full ? <div className="fullscreen">{body}</div> : <div className="card">{body}</div>}
    <div className="grid">
      {mode === 'notes' && <div className="card">
        <h2>Note inspector</h2>
        {!selNote ? <p style={{ color: 'var(--mute)' }}>Tap a note.</p> : <div className="col">
          <div className="pill vio">{midiName(selNote.midi)} → {midiName(selNote.midi + selNote.shift)} · {(selNote.end - selNote.start).toFixed(2)} s</div>
          <Slider label="Pitch shift" value={selNote.shift} min={-12} max={12} step={0.05} fmt={(v) => `${v.toFixed(2)} st`} onChange={(v) => patchSel({ shift: v })} />
          <Slider label="Note gain" value={selNote.gainDb} min={-18} max={12} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => patchSel({ gainDb: v })} />
          <Slider label="Vibrato depth" value={selNote.vibrato} min={0} max={2.5} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patchSel({ vibrato: v })} />
          <Slider label="Timing" value={selNote.timeShift} min={-0.25} max={0.25} step={0.005} fmt={(v) => `${(v * 1000).toFixed(0)} ms`} onChange={(v) => patchSel({ timeShift: v })} />
          <Slider tag="dsp" label="Formant" value={selNote.formant} min={0.85} max={1.15} step={0.005} fmt={(v) => `${((v - 1) * 100).toFixed(1)}%`} onChange={(v) => patchSel({ formant: v })} />
          <div className="row"><button className="btn sm" onClick={() => patchSel({ shift: Math.round(selNote.midi) - selNote.midi })}>Snap to nearest semitone</button><button className="btn sm" onClick={() => patchSel({ shift: 0, gainDb: 0, vibrato: 1, timeShift: 0, formant: 1 })}>Reset note</button></div>
        </div>}
      </div>}
      <div className="card">
        <h2>{mode === 'pitch' ? 'Melody correction' : 'Global'}</h2>
        <div className="row"><Toggle label="Key / scale overlay & snapping" checked={useScale} onChange={setUseScale} />
          <select style={{ width: 80 }} value={tonic} onChange={(e) => setTonic(+e.target.value)}>{KEY_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}</select>
          <select style={{ width: 100 }} value={modeK} onChange={(e) => setModeK(e.target.value as any)}><option>major</option><option>minor</option></select></div>
        <Slider label="Pitch correction amount (pull to scale notes)" value={correction} min={0} max={1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={setCorrection} />
        <Slider label="Vibrato (global)" value={vibrato} min={0} max={2} fmt={(v) => `${Math.round(v * 100)}%`} onChange={setVibrato} />
        {mode === 'pitch' && <div className="row"><button className="btn sm" onClick={() => commit(notes.map((n) => ({ ...n, shift: n.shift + 12 })))}>All +12</button><button className="btn sm" onClick={() => commit(notes.map((n) => ({ ...n, shift: n.shift - 12 })))}>All −12</button><button className="btn sm" onClick={() => commit(notes.map((n) => ({ ...n, shift: 0 })))}>Reset all shifts</button></div>}
        <p className="note" style={{ fontSize: 12 }}>Correction is partial and preserves vibrato/expression by design — 100% is hard-tuned, lower values keep natural imperfections.</p>
      </div>
      <div className="card">
        <h2>Render</h2>
        <div className="col">
          <button className="btn" disabled={!range || !src} onClick={() => void render(true)}>▶ Preview selected phrase (DSP)</button>
          <button className="btn pri" disabled={!src} onClick={() => void render(false)}>Render edited vocal (DSP PSOLA)</button>
          <button className="btn" disabled={!src} onClick={reconvert}>Re-run neural conversion with edited pitch{range ? ' (range)' : ''}</button>
          <button className="btn sm" onClick={() => stopAll()}>■ Stop</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--mute)' }}>DSP render applies the edits with formant-preserving PSOLA. The neural option feeds the edited F0 curve straight into the RVC model.</p>
      </div>
    </div>
    {rendered && <div className="card"><h2>A / B</h2><div className="grid"><Player pcm={src} label="A · Original" color="#ffd98a" /><Player pcm={rendered} label="B · Processed" /></div></div>}
  </>);
}
