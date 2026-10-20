import { useEffect, useRef, useState } from 'react';
import { useApp, toast, getState } from '../state';
import { runJob, singerById, maxLoaded } from '../actions';
import { decodeFile } from '../audio/playback';
import { analyzeVoice, timbreSimilarity } from '../audio/voiceAnalysis';
import { savePcm, loadPcm } from '../store/db';
import { newSinger, uid, SYNTH_CHARACTERS } from '../project/defaults';
import { midiName } from '../audio/f0';
import { pcmDuration, type Pcm } from '../audio/pcm';
import { resample } from '../audio/resample';
import { convertVocal } from '../pipeline/cover';
import { Player } from '../ui/Player';
import { FileButton } from '../ui/controls';
import { SingerForm } from './Singers';
import type { Singer, VoiceAnalysis } from '../project/types';

interface Sample { id: string; name: string; pcm: Pcm; }

export function VoiceLab() {
  const singers = useApp((s) => s.singers), caps = useApp((s) => s.caps), models = useApp((s) => s.models);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [analysis, setAnalysis] = useState<VoiceAnalysis | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null), [recT, setRecT] = useState(0);
  const [creating, setCreating] = useState<Singer | null>(null);
  const [ab, setAb] = useState<{ src: Pcm; dry: Pcm; proc: Pcm } | null>(null), [abSinger, setAbSinger] = useState('');
  const timer = useRef<any>(null);
  useEffect(() => () => clearInterval(timer.current), []);

  const addSample = async (pcm: Pcm, name: string) => {
    if (pcm.sampleRate !== 44100) pcm = { sampleRate: 44100, channels: pcm.channels.map((c) => resample(c, pcm.sampleRate, 44100)) };
    const id = uid('ast'); await savePcm(id, pcm, name);
    setSamples((s) => [...s, { id, name, pcm }]); setAnalysis(null);
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const mr = new MediaRecorder(stream), chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); clearInterval(timer.current); setRec(null);
        try { await addSample(await decodeFile(new Blob(chunks, { type: mr.mimeType })), `Recording ${new Date().toLocaleTimeString()}`); } catch (e) { toast((e as Error).message, 'err'); } };
      mr.start(); setRec(mr); setRecT(0); const t0 = Date.now(); timer.current = setInterval(() => setRecT((Date.now() - t0) / 1000), 200);
    } catch (e) { toast(`Microphone unavailable: ${(e as Error).message}`, 'err'); }
  };

  const total = samples.reduce((a, s) => a + pcmDuration(s.pcm), 0);
  const similar = analysis ? singers.filter((s) => s.analysis?.mfccMean?.length).map((s) => ({ s, sim: timbreSimilarity(analysis.mfccMean, s.analysis!.mfccMean) })).sort((a, b) => b.sim - a.sim) : [];

  if (creating) return (<><h1>Create AI singer</h1><div className="card"><SingerForm initial={creating} onSaved={() => { setCreating(null); setSamples([]); setAnalysis(null); }} onCancel={() => setCreating(null)} /></div></>);

  return (<>
    <h1>Voice Clone Laboratory</h1>
    <p className="sub">Build a voice profile from recordings you own or have permission to use.</p>
    <div className="grid">
      <div className="card">
        <h2>Recording guidance</h2>
        <ul style={{ fontSize: 14, color: 'var(--dim)', paddingLeft: 18, margin: 0 }}>
          <li>Quiet room, minimal reverb (closets/soft furnishings help)</li><li>No background music</li><li>Several clear sung phrases at different comfortable pitches</li>
          <li>Clear vowels and consonants; avoid clipping (peaks below −3 dBFS)</li><li>For analysis: 30 s+ · For RVC training (off-device): typically 10–30 min of clean singing</li>
        </ul>
      </div>
      <div className="card">
        <h2>Capabilities — what is real</h2>
        <p><b>A. Voice analysis</b> <span className="pill ok">implemented</span><br /><span style={{ fontSize: 13, color: 'var(--dim)' }}>Pitch range (YIN), loudness (BS.1770), spectral centroid, 13-coef MFCC timbre means. Does not clone a voice.</span></p>
        <p><b>B. Zero-shot adaptation</b> <span className="pill err">not available</span><br /><span style={{ fontSize: 13, color: 'var(--dim)' }}>No zero-shot singing voice conversion model has been verified to run in Safari/WebGPU yet. The adapter interface accepts one when it exists.</span></p>
        <p><b>C. Trained voice model</b> <span className="pill warn">import only</span><br /><span style={{ fontSize: 13, color: 'var(--dim)' }}>RVC models must be trained off-device (e.g. RVC WebUI on a PC GPU) and exported to ONNX, then imported here. In-browser training is not implemented: RVC fine-tuning needs a GPU training loop and far more memory/time than an iPhone tab provides, with no proof it works on target hardware.</span></p>
      </div>
    </div>
    <div className="card">
      <h2>Samples ({samples.length} · {total.toFixed(1)} s)</h2>
      <div className="row">
        <FileButton label="Add WAV / MP3…" accept="audio/*" multiple onFile={(f) => void runJob('Load sample', async () => addSample(await decodeFile(f), f.name), { cancellable: false })} />
        {rec ? <button className="btn danger" onClick={() => rec.stop()}>■ Stop recording ({recT.toFixed(1)} s)</button> : <button className="btn" disabled={!caps?.getUserMedia} onClick={startRec}>● Record with microphone</button>}
        <button className="btn pri" disabled={!samples.length} onClick={() => void runJob('Analyse voice', async (prog) => { prog(0.3, 'YIN pitch, loudness, MFCC'); await new Promise((r) => setTimeout(r, 20)); setAnalysis(analyzeVoice(samples.map((s) => s.pcm))); })}>Analyse</button>
      </div>
      <div className="list" style={{ marginTop: 10 }}>{samples.map((s) => <div key={s.id} className="item" style={{ display: 'block' }}><div className="row between"><b style={{ fontSize: 13 }}>{s.name}</b><button className="btn sm danger" onClick={() => setSamples((x) => x.filter((y) => y.id !== s.id))}>Remove</button></div><Player pcm={s.pcm} height={64} meter={false} /></div>)}</div>
    </div>
    {analysis && <div className="card">
      <h2>Voice analysis</h2>
      <div className="stats">
        <div className="stat"><b>{analysis.durationSec.toFixed(1)} s</b><span>Material</span></div>
        <div className="stat"><b>{analysis.rangeLowMidi != null ? `${midiName(analysis.rangeLowMidi)}–${midiName(analysis.rangeHighMidi!)}` : '—'}</b><span>Sung range (5–95 %)</span></div>
        <div className="stat"><b>{analysis.medianMidi != null ? midiName(analysis.medianMidi) : '—'}</b><span>Median pitch</span></div>
        <div className="stat"><b>{(analysis.voicedRatio * 100).toFixed(0)}%</b><span>Voiced frames</span></div>
        <div className="stat"><b>{analysis.centroidHz.toFixed(0)} Hz</b><span>Spectral centroid</span></div>
        <div className="stat"><b>{Number.isFinite(analysis.lufs) ? analysis.lufs.toFixed(1) : '—'} LUFS</b><span>Loudness</span></div>
      </div>
      {analysis.durationSec < 30 && <p className="note warn">Under 30 s of material: the analysis is coarse.</p>}
      {similar.length > 0 && <p style={{ fontSize: 13, color: 'var(--dim)' }}>Closest saved profile by MFCC timbre (coarse indicator, not identity verification): {similar.slice(0, 3).map((x) => `${x.s.name} ${(x.sim * 100).toFixed(0)}%`).join(' · ')}</p>}
      <button className="btn pri" onClick={() => { const s = newSinger('My voice'); s.analysis = analysis; s.sampleAssetIds = samples.map((x) => x.id); if (analysis.rangeLowMidi != null) { s.rangeLow = Math.round(analysis.rangeLowMidi); s.rangeHigh = Math.round(analysis.rangeHighMidi!); } setCreating(s); }}>Create singer from this analysis</button>
    </div>}
    <div className="card">
      <h2>A/B test a singer</h2>
      <p style={{ fontSize: 13, color: 'var(--dim)' }}>Converts the first sample (max 15 s) with the chosen singer and current cover settings: source vs dry converted vs processed.</p>
      <div className="row">
        <select style={{ maxWidth: 360 }} value={abSinger} onChange={(e) => setAbSinger(e.target.value)}><option value="">— singer —</option>{[...singers, ...SYNTH_CHARACTERS].filter((s) => s.mode !== 'analysis-only').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button className="btn" disabled={!samples.length || !abSinger} onClick={() => void runJob('A/B conversion', async (prog) => {
          const sg = singerById(abSinger)!, src = samples[0].pcm, st = getState();
          const r = await convertVocal({ vocal: src, settings: { ...st.project.cover, backend: st.settings.backend }, singer: sg, models: { voice: models.find((m) => m.id === sg.voiceModelId), content: models.find((m) => m.id === sg.contentModelId) }, rangeSec: { start: 0, end: Math.min(15, pcmDuration(src)) }, maxLoaded: maxLoaded(), onProgress: prog });
          setAb({ src: { sampleRate: 44100, channels: [src.channels[0].slice(0, r.dry.channels[0].length)] }, dry: r.dry, proc: r.processed });
        })}>Run A/B</button>
      </div>
      {ab && <div className="grid" style={{ marginTop: 10 }}><Player pcm={ab.src} label="Source voice" color="#ffd98a" /><Player pcm={ab.dry} label="Dry converted" /><Player pcm={ab.proc} label="Processed converted" /></div>}
    </div>
    {singers.some((s) => s.sampleAssetIds.length) && <div className="card"><h2>Re-open saved samples</h2><div className="row">{singers.filter((s) => s.sampleAssetIds.length).map((s) => <button key={s.id} className="btn sm" onClick={async () => { const out: Sample[] = []; for (const id of s.sampleAssetIds) { const p = await loadPcm(id); if (p) out.push({ id, name: `${s.name} sample`, pcm: p }); } setSamples(out); setAnalysis(s.analysis); }}>{s.name}</button>)}</div></div>}
  </>);
}
