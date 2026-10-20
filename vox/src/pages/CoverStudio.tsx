import { useState } from 'react';
import { useApp, updateProject, getState, toast } from '../state';
import { importSong, importStem, runSeparation, runConversion, latest, singerById, runJob, newRenderedAsset, type ConversionOutcome } from '../actions';
import { Player } from '../ui/Player';
import { Slider, Toggle, Seg, FileButton, fmtDb, fmtTime } from '../ui/controls';
import { MDX_PRESETS } from '../ml/mdx';
import { SYNTH_CHARACTERS, QUALITY } from '../project/defaults';
import { HV_PRESETS, presetParams } from '../audio/humanvoice';
import { midiName } from '../audio/f0';
import { nrmsDifference, toMono, pcmDuration } from '../audio/pcm';
import { dsp } from '../dsp/dspClient';
import { go } from '../App';
import type { CoverSettings, QualityMode } from '../project/types';

export function CoverStudio() {
  const p = useApp((s) => s.project), assets = useApp((s) => s.assets), models = useApp((s) => s.models), singers = useApp((s) => s.singers), job = useApp((s) => s.job);
  const [sepMethod, setSepMethod] = useState<'neural' | 'dsp' | 'manual'>('neural');
  const [mdxId, setMdxId] = useState<string>(''), [mdxCfg, setMdxCfg] = useState(Object.keys(MDX_PRESETS)[0]);
  const [sepPreview, setSepPreview] = useState(true);
  const [outcome, setOutcome] = useState<ConversionOutcome | null>(null);
  const [mixId, setMixId] = useState<string | null>(null);
  const busy = !!job && !job.done && !job.error;
  const mix = latest('mix'), mixPcm = mix ? assets.get(mix.id) : null;
  const vt = p.tracks.find((t) => t.kind === 'original'), it = p.tracks.find((t) => t.kind === 'instrumental'), ct = p.tracks.find((t) => t.kind === 'converted');
  const vocal = vt?.assetId ? assets.get(vt.assetId) : null, inst = it?.assetId ? assets.get(it.assetId) : null, conv = ct?.assetId ? assets.get(ct.assetId) : null;
  const mdxModels = models.filter((m) => m.kind === 'mdx');
  const singer = singerById(p.singerId);
  const c = p.cover;
  const set = (patch: Partial<CoverSettings>) => updateProject((pp) => { pp.cover = { ...pp.cover, ...patch }; if (!('quality' in patch) && ['chunkSec', 'overlapSec', 'contextSec'].some((k) => k in patch)) pp.cover.quality = 'CUSTOM'; });
  const a = p.analysis;
  const stemDiff = vocal && inst ? nrmsDifference(toMono(vocal), toMono(inst)) : null;
  const singerReady = singer && (singer.mode === 'dsp-character' || (singer.mode === 'neural-rvc' && models.some((m) => m.id === singer.voiceModelId) && models.some((m) => m.id === singer.contentModelId)));

  async function quickMix() {
    const r = await runJob('Recombine (quick mix)', async (prog) => {
      const s = getState(), ids = s.project.tracks.filter((t) => t.kind !== 'original' && t.assetId).map((t) => t.assetId!);
      const end = Math.max(...s.project.tracks.filter((t) => t.assetId && t.kind !== 'original').map((t) => t.offset + pcmDuration(s.assets.get(t.assetId!)!)));
      prog(0.2, 'Rendering converted vocal + instrumental');
      const out = await dsp('renderMix', { tracks: s.project.tracks.map((t) => (t.kind === 'original' ? { ...t, mute: true } : t)), assets: Object.fromEntries(ids.map((i) => [i, s.assets.get(i)])), master: s.project.master, range: { start: 0, end }, sr: 44100 });
      prog(0.9, 'Saving');
      return newRenderedAsset(out, `Cover mix – ${new Date().toLocaleTimeString()}`, 'render');
    });
    if (r) { setMixId(r); toast('Cover mix rendered', 'ok'); }
  }

  return (<>
    <h1>AI Cover Studio</h1>
    <p className="sub">Song → separation → neural voice conversion → recombine → master → export. Every stage runs on this device.</p>

    <div className="card step done-if">
      <h2>1–3 · Song</h2>
      <div className="row"><FileButton pri label={mix ? 'Replace song' : 'Upload MP3 / WAV'} accept="audio/*,.mp3,.wav,.m4a,.aac,.flac" onFile={(f) => void importSong(f)} disabled={busy} /></div>
      {mixPcm && <>
        <div style={{ marginTop: 12 }}><Player pcm={mixPcm} label={mix!.name} selectable /></div>
        {a && <div className="stats" style={{ marginTop: 12 }}>
          <div className="stat"><b>{fmtTime(a.duration)}</b><span>Length</span></div>
          <div className="stat"><b>{a.sampleRate} Hz</b><span>Source sample rate</span></div>
          <div className="stat"><b>{a.channels}</b><span>Channels</span></div>
          <div className="stat"><b>{fmtDb(a.peakDb)}</b><span>Sample peak</span></div>
          <div className="stat"><b>{fmtDb(a.truePeakDb)}</b><span>True peak (4× est.)</span></div>
          <div className="stat"><b>{Number.isFinite(a.lufs) ? a.lufs.toFixed(1) : '—'} LUFS</b><span>Integrated loudness</span></div>
          <div className="stat"><b>{a.bpm || '—'}</b><span>BPM est. · conf {(a.bpmConfidence * 100).toFixed(0)}%</span></div>
          <div className="stat"><b>{a.key}</b><span>Key est. · conf {(a.keyConfidence * 100).toFixed(0)}% · alt {a.keyAlternatives.join(', ')}</span></div>
        </div>}
        {a && (a.keyConfidence < 0.35 || a.bpmConfidence < 0.3) && <p className="note warn">Low-confidence estimate: tempo halving/doubling and relative major/minor confusion are common. Treat as a suggestion.</p>}
      </>}
    </div>

    <div className="card">
      <h2>4 · Separate vocals from instrumental</h2>
      <Seg value={sepMethod} onChange={setSepMethod} options={[{ v: 'neural', l: 'Neural (MDX-Net)' }, { v: 'dsp', l: 'DSP centre (not AI)' }, { v: 'manual', l: 'Supply stems' }]} />
      <div style={{ marginTop: 10 }}>
        {sepMethod === 'neural' && (mdxModels.length === 0 ? <p className="note warn">No separation model installed. Import an MDX-Net ONNX model (e.g. a UVR MDX-Net export you are licensed to use) in <a onClick={() => go('models')}>Model Manager</a>, or supply stems manually.</p> : <div className="ctlgrid">
          <label className="col">Model<select value={mdxId || mdxModels[0].id} onChange={(e) => setMdxId(e.target.value)}>{mdxModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label className="col">Model parameters<select value={mdxCfg} onChange={(e) => setMdxCfg(e.target.value)}>{Object.keys(MDX_PRESETS).map((k) => <option key={k}>{k}</option>)}</select></label>
        </div>)}
        {sepMethod === 'dsp' && <p className="note warn">DSP centre extraction keeps what is identical in left/right. It only works for centre-panned lead vocals over wide mixes and leaves bleed. It is <b>not</b> neural separation.</p>}
        {sepMethod === 'manual' && <div className="row"><FileButton label="Vocal stem…" accept="audio/*" onFile={(f) => void importStem(f, 'vocals')} /><FileButton label="Instrumental stem…" accept="audio/*" onFile={(f) => void importStem(f, 'instrumental')} /></div>}
        {sepMethod !== 'manual' && <div className="row" style={{ marginTop: 10 }}>
          <Toggle label={`Preview first ${c.previewSec} s only`} checked={sepPreview} onChange={setSepPreview} />
          <button className="btn pri" disabled={!mix || busy || (sepMethod === 'neural' && !mdxModels.length)} onClick={() => void runSeparation(sepMethod as 'neural' | 'dsp', mdxId || mdxModels[0]?.id, mdxCfg, sepPreview ? { start: 0, end: Math.min(mix ? mix.duration : 0, c.previewSec) } : null)}>Separate</button>
        </div>}
      </div>
      {(vocal || inst) && <div className="grid" style={{ marginTop: 12 }}>
        <Player pcm={vocal} label={`Vocal stem${vt?.assetId ? ' · ' + p.assets[vt.assetId]?.provenance : ''}`} color="#ffd98a" />
        <Player pcm={inst} label="Instrumental stem" color="#8fe3ff" />
      </div>}
      {stemDiff != null && <p style={{ fontSize: 13, color: 'var(--dim)' }}>Stem difference (NRMS vocal vs instrumental): <b>{stemDiff.toFixed(2)}</b> {stemDiff < 0.2 ? <span className="pill err">stems nearly identical — separation may have failed</span> : <span className="pill ok">stems differ</span>}</p>}
    </div>

    <div className="card">
      <h2>5 · AI singer</h2>
      <div className="row">
        <select style={{ maxWidth: 420 }} value={p.singerId ?? ''} onChange={(e) => updateProject((pp) => { pp.singerId = e.target.value || null; const sg = singerById(pp.singerId); if (sg) { pp.cover = { ...pp.cover, ...sg.preset, rangeLow: sg.rangeLow, rangeHigh: sg.rangeHigh }; } })}>
          <option value="">— choose singer —</option>
          <optgroup label="My AI singers">{singers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.mode === 'neural-rvc' ? 'neural RVC' : s.mode === 'dsp-character' ? 'DSP character' : 'analysis only'}</option>)}</optgroup>
          <optgroup label="Built-in original characters (DSP, not neural)">{SYNTH_CHARACTERS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
        </select>
        <button className="btn sm" onClick={() => go('singers')}>Manage singers</button>
      </div>
      {singer && <div style={{ marginTop: 8 }}>
        {singer.mode === 'neural-rvc' && (singerReady ? <span className="pill ok">Neural RVC model + content encoder installed</span> : <p className="note err">This singer's voice model or content encoder is missing on this device. Re-import it in Model Manager and attach it in My AI Singers.</p>)}
        {singer.mode === 'dsp-character' && <p className="note">DSP voice character: PSOLA pitch + formant processing. This changes timbre algorithmically; it is <b>not</b> a neural voice clone.</p>}
        {singer.mode === 'analysis-only' && <p className="note err">Analysis profile only — no voice model is attached, so this singer cannot convert vocals. Import a trained RVC model you are authorised to use.</p>}
        <p style={{ fontSize: 13, color: 'var(--dim)' }}>Range {midiName(singer.rangeLow)}–{midiName(singer.rangeHigh)} · {singer.voiceType}</p>
      </div>}
    </div>

    <div className="card">
      <h2>6 · Conversion settings</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <Seg value={c.quality} onChange={(q: QualityMode) => set(q === 'CUSTOM' ? { quality: q } : { quality: q, ...QUALITY[q] })} options={[{ v: 'LIGHT', l: 'LIGHT' }, { v: 'BALANCED', l: 'BALANCED' }, { v: 'HIGH', l: 'HIGH' }, { v: 'CUSTOM', l: 'CUSTOM' }]} />
        <span className="pill">chunk {c.chunkSec}s · overlap {c.overlapSec}s · context {c.contextSec}s</span>
      </div>
      <h3>Neural model controls</h3>
      <div className="ctlgrid">
        <Slider tag="nn" label="Pitch transpose" value={c.transpose} min={-24} max={24} step={1} fmt={(v) => `${v > 0 ? '+' : ''}${v} st`} onChange={(v) => set({ transpose: v })} />
        <Slider tag="nn" label="Vocal stability (noise scale)" value={c.stability} min={0} max={1} onChange={(v) => set({ stability: v })} />
        <Slider tag="nn" label="Pitch correction amount" value={c.pitchCorrection} min={0} max={1} onChange={(v) => set({ pitchCorrection: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Slider tag="nn" label="Vibrato amount" value={c.vibrato} min={0} max={2} onChange={(v) => set({ vibrato: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Slider tag="nn" label="Pitch micro-variation" value={c.microVariation} min={0} max={15} step={0.5} onChange={(v) => set({ microVariation: v })} fmt={(v) => `${v} cents`} />
        <Slider tag="na" label="Timbre intensity (feature-index retrieval)" value={1} min={0} max={1} disabled onChange={() => {}} fmt={() => 'unsupported'} />
      </div>
      <p className="note" style={{ fontSize: 12 }}>Timbre intensity in RVC is the faiss <i>index rate</i>. Browser faiss retrieval is not implemented, so conversion runs index-free; the control is shown disabled instead of being faked.</p>
      <div className="row"><Toggle label="Automatic octave correction into target range" checked={c.autoOctave} onChange={(v) => set({ autoOctave: v })} />
        <span className="pill">target {midiName(c.rangeLow)}–{midiName(c.rangeHigh)}</span></div>
      <div className="ctlgrid" style={{ marginTop: 6 }}>
        <Slider label="Target range low" value={c.rangeLow} min={28} max={84} step={1} fmt={midiName} onChange={(v) => set({ rangeLow: v })} />
        <Slider label="Target range high" value={c.rangeHigh} min={36} max={96} step={1} fmt={midiName} onChange={(v) => set({ rangeHigh: v })} />
      </div>
      <h3>Post-conversion (DSP)</h3>
      <div className="ctlgrid">
        <Slider tag="dsp" label="Voice blend (converted ↔ original)" value={c.voiceBlend} min={0} max={1} onChange={(v) => set({ voiceBlend: v })} fmt={(v) => `${Math.round(v * 100)}% AI`} />
        <Slider tag="dsp" label="Original expression preservation" value={c.expression} min={0} max={1} onChange={(v) => set({ expression: v })} />
        <Slider tag="dsp" label="Consonant protection" value={c.consonantProtection} min={0} max={1} onChange={(v) => set({ consonantProtection: v })} />
        <Slider tag="dsp" label="Unvoiced signal preservation" value={c.unvoicedPreservation} min={0} max={1} onChange={(v) => set({ unvoicedPreservation: v })} />
        <Slider tag="dsp" label="Formant shift" value={c.formant} min={0.85} max={1.15} step={0.005} onChange={(v) => set({ formant: v })} fmt={(v) => `${((v - 1) * 100).toFixed(1)}%`} />
      </div>
      <h3>HUMANVOICE engine (DSP)</h3>
      <div className="row"><select style={{ maxWidth: 260 }} value={c.hvPreset} onChange={(e) => set({ hvPreset: e.target.value, hv: presetParams(e.target.value) })}>{Object.keys(HV_PRESETS).map((k) => <option key={k}>{k}</option>)}</select></div>
      <div className="ctlgrid" style={{ marginTop: 8 }}>
        <Slider tag="dsp" label="Dynamics (natural levelling)" value={c.hv.naturalDynamics} min={0} max={1} onChange={(v) => set({ hv: { ...c.hv, naturalDynamics: v } })} />
        <Slider tag="dsp" label="Breathiness / air (12 kHz)" value={c.hv.air} min={-6} max={6} step={0.5} fmt={fmtDb} onChange={(v) => set({ hv: { ...c.hv, air: v } })} />
        <Slider tag="dsp" label="Brightness (8 kHz)" value={c.hv.brightness} min={-6} max={6} step={0.5} fmt={fmtDb} onChange={(v) => set({ hv: { ...c.hv, brightness: v } })} />
        <Slider tag="dsp" label="Warmth (250 Hz)" value={c.hv.warmth} min={-6} max={6} step={0.5} fmt={fmtDb} onChange={(v) => set({ hv: { ...c.hv, warmth: v } })} />
        <Slider tag="dsp" label="Breath preservation" value={c.hv.breathPreservation} min={0} max={1} onChange={(v) => set({ hv: { ...c.hv, breathPreservation: v } })} />
        <Slider tag="dsp" label="Sibilance control" value={c.hv.sibilance} min={0} max={1} onChange={(v) => set({ hv: { ...c.hv, sibilance: v } })} />
        <Slider tag="dsp" label="Consonant clarity (3.5 kHz)" value={c.hv.consonantClarity} min={-3} max={6} step={0.5} fmt={fmtDb} onChange={(v) => set({ hv: { ...c.hv, consonantClarity: v } })} />
        <Slider tag="dsp" label="Transient protection" value={c.hv.transientProtection} min={0} max={1} onChange={(v) => set({ hv: { ...c.hv, transientProtection: v } })} />
        <Slider tag="dsp" label="Harmonic saturation" value={c.hv.saturation} min={0} max={1} onChange={(v) => set({ hv: { ...c.hv, saturation: v } })} />
        <Slider tag="dsp" label="Noise management" value={c.hv.noiseManagement} min={0} max={1} onChange={(v) => set({ hv: { ...c.hv, noiseManagement: v } })} />
      </div>
      <Toggle label="De-clicking" checked={c.hv.declick} onChange={(v) => set({ hv: { ...c.hv, declick: v } })} />
    </div>

    <div className="card">
      <h2>7 · Convert</h2>
      <div className="row">
        <button className="btn pri" disabled={!vocal || !singerReady || busy} onClick={async () => { const r = await runConversion(true); if (r) setOutcome(r); }}>Preview first {c.previewSec} s</button>
        <button className="btn" disabled={!vocal || !singerReady || busy} onClick={async () => { const r = await runConversion(false); if (r) setOutcome(r); }}>Convert full vocal</button>
        <label className="row" style={{ fontSize: 13 }}>Preview length <input type="number" min={5} max={60} value={c.previewSec} style={{ width: 70 }} onChange={(e) => set({ previewSec: Math.max(5, Math.min(60, +e.target.value || 15)) })} /> s</label>
      </div>
      {!vocal && <p className="note warn">Needs a vocal stem (step 4).</p>}
      {outcome && <Evidence o={outcome} />}
      {outcome && <div className="grid" style={{ marginTop: 10 }}>
        <Player pcm={vocal} label="A · Source vocal" color="#ffd98a" />
        <Player pcm={assets.get(outcome.dryId)} label="B · Converted (dry)" />
        <Player pcm={assets.get(outcome.procId)} label="C · Converted + HUMANVOICE" />
      </div>}
    </div>

    <div className="card">
      <h2>8–10 · Recombine, master, export</h2>
      <div className="row">
        <button className="btn pri" disabled={!conv || !inst || busy} onClick={quickMix}>Render cover mix</button>
        <button className="btn" onClick={() => go('mixer')}>Open mixer</button>
        <button className="btn" onClick={() => go('master')}>Mastering</button>
        <button className="btn" onClick={() => go('export')}>Export</button>
      </div>
      {mixId && <div style={{ marginTop: 10 }}><Player pcm={assets.get(mixId)} label="Cover mix (converted vocal + original instrumental, master bus)" /></div>}
      {p.syntheticLabel && <p style={{ fontSize: 12, color: 'var(--mute)' }}>Exports are labelled as AI-generated synthetic vocals.</p>}
    </div>
  </>);
}

function Evidence({ o }: { o: ConversionOutcome }) {
  const e = o.evidence;
  return (<div className="card" style={{ background: '#0f0b1d', marginTop: 12 }}>
    <h3>Measured evidence</h3>
    <div className="stats">
      <div className="stat"><b>{e.neural ? 'Neural' : 'DSP'}</b><span>{e.engine}</span></div>
      <div className="stat"><b>{e.backend}</b><span>Execution backend</span></div>
      <div className="stat"><b>{e.diffFromSource.toFixed(2)}</b><span>NRMS waveform difference vs source</span></div>
      <div className="stat"><b>{e.centroidSourceHz.toFixed(0)} → {e.centroidOutHz.toFixed(0)} Hz</b><span>Spectral centroid source → output</span></div>
      <div className="stat"><b>{e.melodyMedianCentsError != null ? `${e.melodyMedianCentsError.toFixed(0)} c` : 'n/a'}</b><span>Median melody error vs target F0 (octave-agnostic)</span></div>
      <div className="stat"><b>{e.lagMs.toFixed(1)} ms</b><span>Alignment correction</span></div>
      <div className="stat"><b>{e.chunks}</b><span>Chunks · {e.modelSampleRate} Hz model</span></div>
      <div className="stat"><b>{(e.ms / 1000).toFixed(1)} s</b><span>Processing time for {e.seconds.toFixed(1)} s audio</span></div>
    </div>
    {e.melodyMedianCentsError != null && e.melodyMedianCentsError > 80 && <p className="note warn">Melody deviates noticeably from the target — check transpose / octave correction, or the model's F0 handling.</p>}
    {e.diffFromSource < 0.05 && <p className="note err">Output is almost identical to the source — conversion had little effect.</p>}
    <details><summary style={{ cursor: 'pointer', color: 'var(--dim)' }}>Processing report</summary><ul style={{ fontSize: 13 }}>{o.report.map((r, i) => <li key={i}>{r}</li>)}</ul></details>
  </div>);
}
