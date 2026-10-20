import { useEffect, useState } from 'react';
import { useApp, setState, updateProject } from '../state';
import { saveSettings } from '../actions';
import { Toggle, Seg, fmtBytes } from '../ui/controls';
import { storageEstimate } from '../store/db';
import { engine } from '../ml/engine';

export function SettingsPage() {
  const s = useApp((x) => x.settings), caps = useApp((x) => x.caps), net = useApp((x) => x.network), label = useApp((x) => x.project.syntheticLabel);
  const [est, setEst] = useState<any>(null);
  useEffect(() => { storageEstimate().then(setEst); }, []);
  const set = (p: Partial<typeof s>) => { setState((st) => ({ settings: { ...st.settings, ...p } })); void saveSettings(); };
  const origin = location.origin;
  const external = net.filter((n) => { try { return new URL(n.url, location.href).origin !== origin; } catch { return false; } });
  const uploads = net.filter((n) => n.bytes > 0 || /POST|PUT/i.test(n.method));
  return (<>
    <h1>Settings</h1>
    <div className="grid">
      <div className="card"><h2>Processing</h2>
        <div className="col">
          <div className="row"><span>Backend</span><Seg value={s.backend} onChange={(v) => { set({ backend: v }); void engine.unloadAll(); }} options={[{ v: 'webgpu', l: 'WebGPU (+WASM fallback)' }, { v: 'wasm', l: 'WASM only' }]} /></div>
          {caps && !caps.webgpu && <p className="note warn">WebGPU is not available in this browser — WASM is used.</p>}
          <Toggle label="Memory-saving mode (1 model loaded at a time, release after each job)" checked={s.memorySaving} onChange={(v) => set({ memorySaving: v })} />
          <div className="row"><span>Default quality</span><Seg value={s.defaultQuality} onChange={(v) => set({ defaultQuality: v })} options={[{ v: 'LIGHT', l: 'LIGHT' }, { v: 'BALANCED', l: 'BALANCED' }, { v: 'HIGH', l: 'HIGH' }]} /></div>
          <Toggle label="Auto-save project" checked={s.autoSave} onChange={(v) => set({ autoSave: v })} />
          <Toggle label="Label exports as AI-generated synthetic vocals" checked={label} onChange={(v) => updateProject((p) => { p.syntheticLabel = v; })} />
          <button className="btn sm" onClick={() => void engine.unloadAll()}>Release GPU / WASM model memory now</button>
        </div>
      </div>
      <div className="card"><h2>Storage</h2>
        <p>{est ? `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)} · ${est.persisted ? 'persistent (won’t be evicted automatically)' : 'not persistent — the browser may evict data under pressure'}` : 'Storage estimate unavailable'}</p>
        <button className="btn sm" onClick={async () => { await navigator.storage?.persist?.(); setEst(await storageEstimate()); }}>Request persistent storage</button>
        <p style={{ fontSize: 12, color: 'var(--mute)' }}>On iOS, install to the Home Screen for more durable storage. Safari may clear site data for websites not used for weeks.</p>
      </div>
    </div>
    <div className="card"><h2>Privacy: network activity this session</h2>
      <p>{net.length} requests recorded · <b>{external.length}</b> to other origins · <b>{uploads.length}</b> with a request body.</p>
      {uploads.length === 0 ? <p className="note">No request with a body has been made — no audio has been uploaded.</p> : <p className="note warn">Requests with a body are listed below. ZMF VOX STUDIO+ itself never uploads audio.</p>}
      <details><summary style={{ cursor: 'pointer', color: 'var(--dim)' }}>Request log</summary><table><tbody>{net.slice(-80).reverse().map((n, i) => <tr key={i}><td>{n.method}</td><td style={{ wordBreak: 'break-all' }}>{n.url}</td><td>{n.bytes ? fmtBytes(n.bytes) : ''}</td></tr>)}</tbody></table></details>
    </div>
    <div className="card"><h2>Device capabilities (measured)</h2>
      {caps && <dl className="kv">
        <dt>User agent</dt><dd style={{ wordBreak: 'break-all', fontSize: 12 }}>{caps.userAgent}</dd>
        <dt>WebGPU adapter</dt><dd>{caps.webgpu ? caps.gpuAdapter : 'none'}</dd>
        <dt>GPU max buffer</dt><dd>{caps.maxBufferMB ? `${caps.maxBufferMB} MB` : '—'}</dd>
        <dt>GPU features</dt><dd style={{ fontSize: 12 }}>{caps.gpuFeatures.join(', ') || '—'}</dd>
        <dt>WebAssembly</dt><dd>{caps.wasm ? 'yes' : 'no'} · SIMD {caps.wasmSimd ? 'yes' : 'no'} · threads {caps.wasmThreads ? 'yes' : 'no'}</dd>
        <dt>Cross-origin isolated</dt><dd>{caps.crossOriginIsolated ? 'yes' : 'no (static host without COOP/COEP → single-thread WASM)'}</dd>
        <dt>OPFS</dt><dd>{caps.opfs ? 'yes' : 'no'}</dd>
        <dt>AudioWorklet / Offline</dt><dd>{caps.audioWorklet ? 'yes' : 'no'} / {caps.offlineAudio ? 'yes' : 'no'}</dd>
        <dt>Microphone / recorder</dt><dd>{caps.getUserMedia ? 'yes' : 'no'} / {caps.mediaRecorder ? 'yes' : 'no'}</dd>
        <dt>Device memory</dt><dd>{caps.deviceMemoryGB ? `${caps.deviceMemoryGB} GB` : 'not exposed (Safari)'}</dd>
        <dt>CPU threads</dt><dd>{caps.cores}</dd>
        <dt>Installed PWA</dt><dd>{caps.standalone ? 'yes' : 'no'} · service worker {caps.serviceWorker ? 'supported' : 'unsupported'}</dd>
      </dl>}
    </div>
  </>);
}
