import type React from "react";
import { useApp, setState } from './state';
import { Dashboard } from './pages/Dashboard';
import { CoverStudio } from './pages/CoverStudio';
import { VoiceLab } from './pages/VoiceLab';
import { Singers } from './pages/Singers';
import { VocalEditor } from './pages/VocalEditor';
import { PitchEditor } from './pages/PitchEditor';
import { HarmonyStudio } from './pages/HarmonyStudio';
import { Mixer } from './pages/Mixer';
import { Mastering } from './pages/Mastering';
import { ModelManager } from './pages/ModelManager';
import { Library } from './pages/Library';
import { ExportStudio } from './pages/ExportStudio';
import { SettingsPage } from './pages/Settings';
import { JobBar } from './ui/JobBar';

export const PAGES: { id: string; label: string; ico: string; el: () => React.JSX.Element }[] = [
  { id: 'dashboard', label: 'Studio Dashboard', ico: '◈', el: Dashboard },
  { id: 'cover', label: 'AI Cover Studio', ico: '✦', el: CoverStudio },
  { id: 'lab', label: 'Voice Clone Laboratory', ico: '⚗', el: VoiceLab },
  { id: 'singers', label: 'My AI Singers', ico: '☺', el: Singers },
  { id: 'editor', label: 'Vocal Editor', ico: '▤', el: VocalEditor },
  { id: 'pitch', label: 'Pitch & Melody Editor', ico: '♪', el: PitchEditor },
  { id: 'harmony', label: 'Harmony Studio', ico: '♫', el: HarmonyStudio },
  { id: 'mixer', label: 'Audio Mixer', ico: '☰', el: Mixer },
  { id: 'master', label: 'Mastering Suite', ico: '◎', el: Mastering },
  { id: 'models', label: 'Model Manager', ico: '⬢', el: ModelManager },
  { id: 'library', label: 'Project Library', ico: '▣', el: Library },
  { id: 'export', label: 'Export Studio', ico: '⇩', el: ExportStudio },
  { id: 'settings', label: 'Settings', ico: '⚙', el: SettingsPage },
];

export const go = (page: string) => { setState({ page, navOpen: false }); window.scrollTo(0, 0); };

export function App() {
  const page = useApp((s) => s.page), open = useApp((s) => s.navOpen), toasts = useApp((s) => s.toasts), name = useApp((s) => s.project.name);
  const P = PAGES.find((p) => p.id === page) ?? PAGES[0];
  return (
    <div className="app">
      <div className="topbar"><button className="btn sm" aria-label="Menu" onClick={() => setState({ navOpen: true })}>☰</button><span className="t">{P.label}</span><span className="pill" style={{ maxWidth: 120, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{name}</span></div>
      <div className={`scrim ${open ? 'open' : ''}`} onClick={() => setState({ navOpen: false })} />
      <nav className={`nav ${open ? 'open' : ''}`}>
        <div className="brand"><div className="logo" /><div>ZMF VOX STUDIO+<small>v0.1 · on-device AI singing</small></div></div>
        {PAGES.map((p) => <button key={p.id} className={p.id === page ? 'on' : ''} onClick={() => go(p.id)}><span className="ico">{p.ico}</span>{p.label}</button>)}
        <p style={{ fontSize: 11, color: 'var(--mute)', padding: '14px 10px' }}>All audio is processed on this device. Nothing is uploaded.</p>
      </nav>
      <main><P.el /></main>
      <JobBar />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
    </div>
  );
}
