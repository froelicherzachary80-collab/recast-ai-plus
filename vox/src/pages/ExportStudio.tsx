import { useState } from 'react';
import { useApp, getState, toast } from '../state';
import { runJob } from '../actions';
import { encodeWav, type WavFormat } from '../audio/wav';
import { encodeMp3 } from '../audio/mp3';
import { downloadBlob } from '../audio/playback';
import { Seg } from '../ui/controls';
import { renderProjectMix, projectEnd } from './Mixer';
import type { Pcm } from '../audio/pcm';

export function ExportStudio() {
  const p = useApp((s) => s.project);
  const [fmt, setFmt] = useState<'wav16' | 'wav24' | 'wav32' | 'mp3'>('wav24'), [kbps, setKbps] = useState(256);
  const [segStart, setSegStart] = useState(0), [segEnd, setSegEnd] = useState(0);
  const items = Object.values(p.assets).sort((a, b) => b.createdAt - a.createdAt);
  const exportPcm = (pcm: Pcm, base: string) => runJob(`Export ${base}`, async (prog) => {
    const safe = base.replace(/[^\w\-. ]+/g, '_').slice(0, 80) + (p.syntheticLabel ? ' [AI vocal]' : '');
    if (fmt === 'mp3') { const blob = await encodeMp3(pcm, kbps, (f) => prog(f, 'Encoding MP3 (lamejs, local)')); downloadBlob(blob, `${safe}.mp3`); }
    else { prog(0.3, 'Encoding WAV'); const bits = ({ wav16: 16, wav24: 24, wav32: 32 } as const)[fmt] as WavFormat; downloadBlob(new Blob([encodeWav(pcm, bits)], { type: 'audio/wav' }), `${safe}.wav`); }
    toast(`Exported ${safe}`, 'ok');
  });
  const exportAsset = (id: string) => { const pcm = getState().assets.get(id); if (!pcm) return toast('Audio not loaded', 'err'); void exportPcm(pcm, p.assets[id].name); };
  const exportMix = (master: boolean) => runJob('Render for export', async (prog) => {
    const end = segEnd > segStart ? segEnd : projectEnd();
    prog(0.2, 'Rendering mix'); const pcm = await renderProjectMix({ start: segStart, end }, !master);
    return pcm;
  }).then((pcm) => pcm && exportPcm(pcm, `${p.name} – ${master ? 'mastered mix' : 'mix (no master)'}${segEnd > segStart ? ` ${segStart}-${segEnd}s` : ''}`));
  return (<>
    <h1>Export Studio</h1>
    <p className="sub">Encoded locally. On iPhone the share sheet opens — choose “Save to Files”.</p>
    <div className="card">
      <div className="row"><Seg value={fmt} onChange={setFmt} options={[{ v: 'wav16', l: 'WAV 16-bit' }, { v: 'wav24', l: 'WAV 24-bit' }, { v: 'wav32', l: 'WAV 32f' }, { v: 'mp3', l: 'MP3' }]} />
        {fmt === 'mp3' && <select style={{ width: 110 }} value={kbps} onChange={(e) => setKbps(+e.target.value)}>{[128, 192, 256, 320].map((k) => <option key={k} value={k}>{k} kbps</option>)}</select>}</div>
      <h3>Mix</h3>
      <div className="row"><button className="btn pri" onClick={() => void exportMix(true)}>Mastered mix</button><button className="btn" onClick={() => void exportMix(false)}>Mix without master bus</button>
        <label className="row" style={{ fontSize: 13 }}>Segment <input type="number" min={0} value={segStart} style={{ width: 70 }} onChange={(e) => setSegStart(Math.max(0, +e.target.value))} />–<input type="number" min={0} value={segEnd} style={{ width: 70 }} onChange={(e) => setSegEnd(Math.max(0, +e.target.value))} /> s (0–0 = whole song)</label></div>
      <p style={{ fontSize: 12, color: 'var(--mute)' }}>Exporting shorter segments keeps memory low on iPhone for long songs.</p>
    </div>
    <div className="card"><h3>Stems &amp; renders</h3>
      <div className="list">{items.map((a) => <div className="item" key={a.id}><div><b>{a.name}</b> <span className="pill">{a.role}</span><div style={{ fontSize: 12, color: 'var(--mute)' }}>{a.duration.toFixed(1)} s · {a.channels} ch · {a.provenance}</div></div><button className="btn sm" onClick={() => exportAsset(a.id)}>Export</button></div>)}</div>
      {!items.length && <p style={{ color: 'var(--mute)' }}>Nothing to export yet.</p>}
    </div>
  </>);
}
