import { useApp } from '../state';
import { go } from '../App';
import { latest } from '../actions';
import { fmtTime } from '../ui/controls';

export function Dashboard() {
  const caps = useApp((s) => s.caps), p = useApp((s) => s.project), models = useApp((s) => s.models), singers = useApp((s) => s.singers), settings = useApp((s) => s.settings);
  useApp((s) => s.assets);
  const hasMix = !!latest('mix'), hasStems = !!p.tracks.find((t) => t.kind === 'original')?.assetId, hasConv = !!latest('converted');
  const rvc = models.filter((m) => m.kind === 'rvc').length, content = models.filter((m) => m.kind === 'content').length, mdx = models.filter((m) => m.kind === 'mdx').length;
  const steps = [
    { l: 'Import a song (MP3/WAV)', done: hasMix, page: 'cover' },
    { l: 'Separate vocals / instrumental (or supply stems)', done: hasStems, page: 'cover' },
    { l: 'Add models: content encoder + RVC voice (+ MDX for separation)', done: rvc > 0 && content > 0, page: 'models' },
    { l: 'Create / pick an AI singer', done: !!p.singerId, page: 'singers' },
    { l: 'Convert a preview, then the full vocal', done: hasConv, page: 'cover' },
    { l: 'Mix, master and export', done: false, page: 'mixer' },
  ];
  return (<>
    <h1>Studio Dashboard</h1>
    <p className="sub">Project <b>{p.name}</b>{p.analysis ? ` · ${fmtTime(p.analysis.duration)} · ${p.analysis.key} · ${p.analysis.bpm} BPM` : ''}</p>
    <div className="grid">
      <div className="card steps">
        <h2>Cover workflow</h2>
        {steps.map((s) => <div key={s.l} className={`step ${s.done ? 'done' : ''}`} style={{ padding: '14px 0 6px 40px' }}><div className="row between"><span>{s.l}</span><button className="btn sm" onClick={() => go(s.page)}>Open</button></div></div>)}
      </div>
      <div className="card">
        <h2>This device</h2>
        {!caps ? <p>Detecting…</p> : <dl className="kv">
          <dt>WebGPU</dt><dd>{caps.webgpu ? <span className="pill ok">available · {caps.gpuAdapter}</span> : <span className="pill warn">not available → WASM</span>}</dd>
          <dt>WASM SIMD</dt><dd>{caps.wasmSimd ? 'yes' : 'no'}</dd>
          <dt>WASM threads</dt><dd>{caps.wasmThreads ? `yes (${caps.cores} cores)` : 'no (single-thread; needs COOP/COEP)'}</dd>
          <dt>OPFS</dt><dd>{caps.opfs ? 'yes' : 'no (IndexedDB fallback)'}</dd>
          <dt>Backend</dt><dd>{settings.backend.toUpperCase()}{settings.memorySaving ? ' · memory-saving' : ''}</dd>
          <dt>Platform</dt><dd>{caps.isIOS ? 'iOS' : 'desktop/other'}{caps.isSafari ? ' Safari' : ''}{caps.standalone ? ' · installed PWA' : ''}</dd>
        </dl>}
      </div>
      <div className="card">
        <h2>Library</h2>
        <div className="stats">
          <div className="stat"><b>{singers.length}</b><span>AI singers</span></div>
          <div className="stat"><b>{rvc}</b><span>RVC voice models</span></div>
          <div className="stat"><b>{content}</b><span>Content encoders</span></div>
          <div className="stat"><b>{mdx}</b><span>Separation models</span></div>
        </div>
        {rvc + content + mdx === 0 && <p className="note warn">No neural models installed yet. ZMF VOX STUDIO+ ships no model weights; import openly licensed / authorised ONNX models in Model Manager. Until then only DSP features (clearly labelled) are available.</p>}
      </div>
    </div>
  </>);
}
