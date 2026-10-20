import { useEffect, useState } from 'react';
import { useApp, toast, getState, setState } from '../state';
import { openProject, deleteProject, createProject, saveProject, runJob, singerById } from '../actions';
import { all, put, savePcm } from '../store/db';
import { writeProjectFile, readProjectFile } from '../project/projectFile';
import { downloadBlob } from '../audio/playback';
import { uid } from '../project/defaults';
import { FileButton, Toggle } from '../ui/controls';
import { go } from '../App';
import type { Project } from '../project/types';

export function Library() {
  const cur = useApp((s) => s.project.id);
  const [list, setList] = useState<Project[]>([]), [bundle, setBundle] = useState(true);
  const refresh = () => all<Project>('projects').then((l) => setList(l.sort((a, b) => b.updatedAt - a.updatedAt)));
  useEffect(() => { void refresh(); }, [cur]);
  return (<>
    <h1>Project Library</h1>
    <p className="sub">Projects are saved automatically to this device (IndexedDB) and reopen after reload or offline.</p>
    <div className="card"><div className="row">
      <button className="btn pri" onClick={async () => { await createProject(); await refresh(); go('cover'); }}>New project</button>
      <button className="btn" onClick={async () => { await saveProject(); await refresh(); toast('Saved', 'ok'); }}>Save now</button>
      <button className="btn" onClick={() => void runJob('Export project file', async (prog) => { prog(0.3, bundle ? 'Encoding bundled audio' : 'Writing settings'); const s = getState(); downloadBlob(writeProjectFile(s.project, s.assets, { bundle, singer: singerById(s.project.singerId) ?? null }), `${s.project.name}.zvox`); })}>Export .zvox</button>
      <Toggle label="Bundle audio assets" checked={bundle} onChange={setBundle} />
      <FileButton label="Import .zvox…" accept=".zvox,application/octet-stream" onFile={(f) => void runJob('Import project', async (prog) => {
        prog(0.2, 'Reading'); const r = await readProjectFile(f);
        const p = { ...r.project, id: uid('prj'), name: `${r.project.name} (imported)` };
        for (const [id, pcm] of r.assets) await savePcm(id, pcm, p.assets[id]?.name ?? id);
        for (const id of Object.keys(p.assets)) if (!r.assets.has(id)) delete p.assets[id];
        await put('projects', p.id, p); await openProject(p.id); await refresh();
        toast(`Imported ${p.name}${r.assets.size ? ` with ${r.assets.size} audio assets` : ' (settings only)'}`, 'ok');
      })} />
    </div></div>
    <div className="list">{list.map((p) => <div className="item" key={p.id}>
      <div><b>{p.name}</b> {p.id === cur && <span className="pill vio">open</span>}<div style={{ fontSize: 12, color: 'var(--mute)' }}>{Object.keys(p.assets).length} assets · {p.tracks.length} tracks · updated {new Date(p.updatedAt).toLocaleString()}{p.analysis ? ` · ${p.analysis.key}, ${p.analysis.bpm} BPM` : ''}</div></div>
      <div className="row">
        <button className="btn sm" onClick={async () => { await saveProject(); await openProject(p.id); go('cover'); }}>Open</button>
        <button className="btn sm" onClick={async () => { const c = { ...structuredClone(p), id: uid('prj'), name: `${p.name} (copy)`, updatedAt: Date.now() }; await put('projects', c.id, c); await refresh(); }}>Duplicate</button>
        <button className="btn sm danger" onClick={async () => { if (!confirm(`Delete ${p.name} and its audio?`)) return; await deleteProject(p.id); await refresh(); setState({}); }}>Delete</button>
      </div></div>)}</div>
  </>);
}
