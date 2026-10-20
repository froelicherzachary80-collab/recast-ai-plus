import { useEffect, useState } from 'react';
import { useApp, toast } from '../state';
import { runJob, refreshModels, maxLoaded } from '../actions';
import { importModelBytes, fetchWithProgress } from '../ml/importModel';
import { removeModel, verifyModel, saveModelRecord, type ModelKind } from '../ml/modelStore';
import { storageEstimate } from '../store/db';
import { engine } from '../ml/engine';
import { fmtBytes, Toggle } from '../ui/controls';

const KIND_LABEL: Record<ModelKind, string> = { rvc: 'RVC voice model', content: 'Content encoder (ContentVec/HuBERT)', mdx: 'MDX-Net separation', unknown: 'Unknown / unsupported' };

export function ModelManager() {
  const models = useApp((s) => s.models), caps = useApp((s) => s.caps), settings = useApp((s) => s.settings);
  const [est, setEst] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  const [url, setUrl] = useState(''), [license, setLicense] = useState(''), [perm, setPerm] = useState(false), [, force] = useState(0);
  useEffect(() => { storageEstimate().then(setEst); const l = () => force((x) => x + 1); engine.listeners.add(l); return () => { engine.listeners.delete(l); }; }, [models.length]);

  const doImport = (getBytes: (p: (f: number, s: string) => void) => Promise<ArrayBuffer>, name: string, source: string) => runJob(`Import model ${name}`, async (prog) => {
    if (!perm) throw new Error('Confirm that you have the right to use this model (licence / voice owner permission) first');
    const buf = await getBytes((f, s) => prog(f * 0.5, s));
    const rec = await importModelBytes(buf, name, source, license || 'unspecified', perm, (f, s) => prog(0.5 + f * 0.5, s));
    await refreshModels();
    toast(`${name}: detected ${KIND_LABEL[rec.kind]}`, rec.kind === 'unknown' ? 'err' : 'ok');
  });

  return (<>
    <h1>Model Manager</h1>
    <p className="sub">Neural models run locally with ONNX Runtime Web. No weights are bundled; you import models you are licensed/authorised to use. Files are stored on this device ({caps?.opfs ? 'OPFS' : 'IndexedDB'}) and verified by SHA-256.</p>
    <div className="grid">
      <div className="card">
        <h2>Import a model</h2>
        <label className="col" style={{ fontSize: 13 }}>Licence / permission note<input type="text" placeholder="e.g. MIT — ContentVec; voice: my own recordings" value={license} onChange={(e) => setLicense(e.target.value)} /></label>
        <div style={{ margin: '8px 0' }}><Toggle checked={perm} onChange={setPerm} label="I own this model or have the licence / voice owner's permission to use it. No unauthorised celebrity or third-party voices." /></div>
        <div className="row">
          <label className="btn pri">Import .onnx file<input type="file" accept=".onnx,application/octet-stream" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doImport(async () => f.arrayBuffer(), f.name.replace(/\.onnx$/i, ''), `Local file ${f.name}`); }} /></label>
        </div>
        <h3>Download once from a URL</h3>
        <div className="row"><input type="url" placeholder="https://…/model.onnx (must allow CORS)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" disabled={!url} onClick={() => void doImport((p) => fetchWithProgress(url, p), url.split('/').pop()!.replace(/\?.*$/, '').replace(/\.onnx$/i, ''), url)}>Download &amp; cache</button></div>
        <p className="note" style={{ fontSize: 12 }}>This is the only network request that carries model data, and it is a download. Audio is never sent anywhere. The app does not ship a pre-approved URL list because no model URL could be verified from the build environment — see MODELS.md for what is compatible.</p>
      </div>
      <div className="card">
        <h2>Runtime</h2>
        <dl className="kv">
          <dt>Preferred backend</dt><dd>{settings.backend.toUpperCase()} {caps && !caps.webgpu && <span className="pill warn">WebGPU unavailable</span>}</dd>
          <dt>WASM threads</dt><dd>{caps?.wasmThreads ? 'multi-thread' : 'single-thread'}</dd>
          <dt>Max loaded models</dt><dd>{maxLoaded()} (memory-based{settings.memorySaving ? ', memory-saving on' : ''})</dd>
          <dt>Storage</dt><dd>{est ? `${fmtBytes(est.usage)} used of ${fmtBytes(est.quota)}${est.persisted ? ' · persistent' : ' · may be evicted'}` : 'unknown'}</dd>
        </dl>
        <h3>Loaded sessions</h3>
        {engine.loaded.size === 0 ? <p style={{ fontSize: 13, color: 'var(--mute)' }}>None (models load on demand)</p> :
          <div className="list">{[...engine.loaded.entries()].map(([k, v]) => <div className="item" key={k}><span>{models.find((m) => m.id === k)?.name ?? k} <span className="pill">{v.kind}</span></span><span className="row"><span className="pill vio">{v.backend}</span><button className="btn sm" onClick={() => void engine.unload(k)}>Unload</button></span></div>)}</div>}
        {engine.logs.length > 0 && <><h3>Runtime log</h3><pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--warn)' }}>{engine.logs.slice(-8).join('\n')}</pre></>}
        <div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => void engine.unloadAll()}>Release all model memory</button></div>
      </div>
    </div>
    <div className="card">
      <h2>Installed models</h2>
      {models.length === 0 && <p style={{ color: 'var(--mute)' }}>No models installed.</p>}
      <div className="list">{models.map((m) => (
        <div className="item" key={m.id}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>{m.name}</b> <span className={`pill ${m.kind === 'unknown' ? 'err' : 'vio'}`}>{KIND_LABEL[m.kind]}</span>
            {m.kind === 'rvc' && <span className="pill">{(m.details as any)?.usesF0 ? 'pitch-guided (f0)' : 'no f0 input — singing pitch not controllable'}{(m.details as any)?.featureDim ? ` · ${(m.details as any).featureDim}-d` : ''}</span>}
            <div style={{ fontSize: 12, color: 'var(--mute)', wordBreak: 'break-all' }}>{fmtBytes(m.size)} · {m.storage.toUpperCase()} · sha256 {m.sha256.slice(0, 16)}… · {m.verifiedAt ? `verified ${new Date(m.verifiedAt).toLocaleString()}` : 'not verified'}<br />inputs [{m.inputs.join(', ')}] → outputs [{m.outputs.join(', ')}]<br />licence: {m.license} · source: {m.source}</div>
          </div>
          <div className="row">
            <select value={m.kind} onChange={async (e) => { await saveModelRecord({ ...m, kind: e.target.value as ModelKind }); await refreshModels(); }} style={{ width: 'auto' }}>{(Object.keys(KIND_LABEL) as ModelKind[]).map((k) => <option key={k} value={k}>{k}</option>)}</select>
            <button className="btn sm" onClick={() => void runJob('Verify model', async () => { const ok = await verifyModel(m); await refreshModels(); toast(ok ? `${m.name}: integrity OK` : `${m.name}: HASH MISMATCH — re-import`, ok ? 'ok' : 'err'); })}>Verify</button>
            <button className="btn sm danger" onClick={async () => { if (!confirm(`Remove ${m.name}?`)) return; if (engine.loaded.has(m.id)) await engine.unload(m.id); await removeModel(m); await refreshModels(); }}>Remove</button>
          </div>
        </div>))}</div>
    </div>
    <div className="card">
      <h2>Compatibility</h2>
      <table><tbody>
        <tr><th>Model type</th><th>Expected ONNX signature</th><th>Status in this build</th></tr>
        <tr><td>RVC v2 voice (40k/48k/32k)</td><td>phone[1,T,768], phone_lengths[1], pitch[1,T] i64, pitchf[1,T], ds[1], rnd[1,192,T] → audio</td><td>Adapter implemented &amp; tested with a synthetic graph. Real-model quality not yet verified on iPhone.</td></tr>
        <tr><td>RVC v1 voice</td><td>same, phone dim 256</td><td>Needs a 256-d content encoder (HuBERT layer 9 + final_proj)</td></tr>
        <tr><td>ContentVec / HuBERT</td><td>source[1,N] or [1,1,N] @16 kHz → [1,T,768|256] @50 fps</td><td>Implemented</td></tr>
        <tr><td>MDX-Net (UVR)</td><td>[1,4,dim_f,dim_t] spectrogram → same</td><td>Implemented; STFT/iSTFT tested</td></tr>
        <tr><td>Demucs / HTDemucs</td><td>waveform+spectral hybrid</td><td>Not implemented (ONNX export & browser memory unproven)</td></tr>
        <tr><td>RMVPE F0</td><td>mel → f0 salience</td><td>Not implemented; built-in YIN tracker used</td></tr>
        <tr><td>Faiss .index</td><td>—</td><td>Not supported in browser</td></tr>
      </tbody></table>
    </div>
  </>);
}
