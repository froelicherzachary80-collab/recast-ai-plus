import { useState } from 'react';
import { useApp, updateProject, toast } from '../state';
import { runJob, newRenderedAsset } from '../actions';
import { MASTER_PRESETS, type MasterSettings } from '../audio/mixer';
import { biquad, biquadResponseDb } from '../audio/dsp';
import { dsp } from '../dsp/dspClient';
import { Player } from '../ui/Player';
import { Slider, Toggle, fmtDb } from '../ui/controls';
import { renderProjectMix, projectEnd } from './Mixer';
import { dbfs, type Pcm } from '../audio/pcm';

interface Meas { lufs: number; lra: number; truePeak: number; peak: number; shortTermMax: number; }

function EqCurve({ m }: { m: MasterSettings }) {
  const W = 320, H = 90, pts: string[] = [];
  for (let i = 0; i <= 100; i++) { const f = 20 * Math.pow(1000, i / 100); let db = 0; for (const b of m.eq) if (b.on) db += biquadResponseDb(biquad(b.type, b.freq, 44100, b.q, b.gain), f, 44100); pts.push(`${(i / 100) * W},${H / 2 - db * 3}`); }
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 90, background: '#0b0816', borderRadius: 10 }}><line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#ffffff22" /><polyline fill="none" stroke="#a46bff" strokeWidth={2} points={pts.join(' ')} /></svg>;
}

export function Mastering() {
  const m = useApp((s) => s.project.master);
  const [pre, setPre] = useState<{ pcm: Pcm; meas: Meas } | null>(null), [post, setPost] = useState<{ pcm: Pcm; meas: Meas } | null>(null);
  const set = (patch: Partial<MasterSettings>) => updateProject((p) => { p.master = { ...p.master, ...patch }; });
  const measure = (pcm: Pcm) => dsp<Meas>('analyze', { pcm });
  const run = () => runJob('Master & measure', async (prog) => {
    const end = projectEnd();
    prog(0.1, 'Rendering pre-master mix'); const a = await renderProjectMix({ start: 0, end }, true);
    prog(0.4, 'Measuring pre-master'); const ma = await measure(a);
    prog(0.55, 'Rendering mastered mix'); const b = await renderProjectMix({ start: 0, end });
    prog(0.85, 'Measuring master'); const mb = await measure(b);
    setPre({ pcm: a, meas: ma }); setPost({ pcm: b, meas: mb });
  });
  const M = ({ x, label }: { x: Meas; label: string }) => (<div className="stats"><div className="stat"><b>{Number.isFinite(x.lufs) ? x.lufs.toFixed(1) : '—'}</b><span>{label} integrated LUFS</span></div><div className="stat"><b>{x.shortTermMax.toFixed(1)}</b><span>Max short-term LUFS</span></div><div className="stat"><b>{x.lra.toFixed(1)} LU</b><span>Loudness range</span></div><div className="stat"><b>{fmtDb(dbfs(x.peak))}</b><span>Sample peak</span></div><div className="stat"><b>{fmtDb(dbfs(x.truePeak))}</b><span>True peak (4× oversampled est.)</span></div></div>);
  return (<>
    <h1>Mastering Suite</h1>
    <p className="sub">Master bus processing with measured loudness and peaks. A preset is a starting point — the measurements, not the button, tell you the result.</p>
    <div className="card">
      <h2>Presets</h2>
      <div className="row">{Object.keys(MASTER_PRESETS).map((k) => <button key={k} className="btn sm" onClick={() => { set(MASTER_PRESETS[k](m)); toast(`Applied “${k}” settings`, 'info'); }}>{k}</button>)}</div>
    </div>
    <div className="grid">
      <div className="card"><h2>EQ</h2><EqCurve m={m} />
        {m.eq.map((b, i) => <div key={i}>{b.type !== 'highpass' && b.type !== 'lowpass' ? <Slider label={`${b.type} ${b.freq} Hz`} value={b.gain} min={-12} max={12} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ eq: m.eq.map((x, j) => (j === i ? { ...x, gain: v } : x)) })} /> : <Toggle label={`${b.type} ${b.freq} Hz`} checked={b.on} onChange={(v) => set({ eq: m.eq.map((x, j) => (j === i ? { ...x, on: v } : x)) })} />}</div>)}
      </div>
      <div className="card"><h2>Dynamics &amp; stereo</h2>
        <Toggle label="Bus compressor" checked={m.comp.on} onChange={(v) => set({ comp: { ...m.comp, on: v } })} />
        <Slider label="Threshold" value={m.comp.threshold} min={-40} max={0} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ comp: { ...m.comp, threshold: v } })} />
        <Slider label="Ratio" value={m.comp.ratio} min={1} max={8} step={0.1} fmt={(v) => `${v.toFixed(1)}:1`} onChange={(v) => set({ comp: { ...m.comp, ratio: v } })} />
        <Slider label="Stereo width" value={m.width} min={0} max={1.6} onChange={(v) => set({ width: v })} />
        <Slider label="Output gain (into limiter)" value={m.outputGainDb} min={-12} max={12} step={0.5} fmt={(v) => `${v} dB`} onChange={(v) => set({ outputGainDb: v })} />
        <Toggle label="Look-ahead limiter" checked={m.limiter.on} onChange={(v) => set({ limiter: { ...m.limiter, on: v } })} />
        <Slider label="Ceiling (sample peak)" value={m.limiter.ceiling} min={-6} max={0} step={0.1} fmt={(v) => `${v} dBFS`} onChange={(v) => set({ limiter: { ...m.limiter, ceiling: v } })} />
        <Slider label="Limiter release" value={m.limiter.release} min={10} max={500} step={5} fmt={(v) => `${v} ms`} onChange={(v) => set({ limiter: { ...m.limiter, release: v } })} />
        <h3>Send effects</h3>
        <Slider label="Reverb size" value={m.reverb.size} min={0} max={1} onChange={(v) => set({ reverb: { ...m.reverb, size: v } })} />
        <Slider label="Reverb damping" value={m.reverb.damp} min={0} max={1} onChange={(v) => set({ reverb: { ...m.reverb, damp: v } })} />
        <Slider label="Delay time" value={m.delay.timeMs} min={50} max={1200} step={5} fmt={(v) => `${v} ms`} onChange={(v) => set({ delay: { ...m.delay, timeMs: v } })} />
        <Slider label="Delay feedback" value={m.delay.feedback} min={0} max={0.9} onChange={(v) => set({ delay: { ...m.delay, feedback: v } })} />
      </div>
    </div>
    <div className="card">
      <div className="row"><button className="btn pri" onClick={run}>Render &amp; measure (before / after)</button>{post && <button className="btn" onClick={() => void runJob('Save master', async () => { await newRenderedAsset(post.pcm, `Master ${new Date().toLocaleTimeString()}`); toast('Mastered mix saved — export it in Export Studio', 'ok'); })}>Save mastered mix</button>}</div>
      {pre && post && <div className="grid" style={{ marginTop: 10 }}>
        <div className="col"><Player pcm={pre.pcm} label="Before master bus" /><M x={pre.meas} label="Pre" /></div>
        <div className="col"><Player pcm={post.pcm} label="After master bus" /><M x={post.meas} label="Post" />
          {post.meas.truePeak > Math.pow(10, -1 / 20) && <p className="note warn">True peak above −1 dBTP: streaming encoders may clip. Lower the ceiling.</p>}
          {Number.isFinite(post.meas.lufs) && Math.abs(post.meas.lufs + 14) > 2 && <p className="note">Streaming platforms normalise to about −14 LUFS; this master is {(post.meas.lufs + 14).toFixed(1)} LU away.</p>}</div>
      </div>}
    </div>
  </>);
}
