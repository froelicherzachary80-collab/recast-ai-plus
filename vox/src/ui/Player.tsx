import { useEffect, useRef, useState } from 'react';
import { play, stopAll, type PlayHandle } from '../audio/playback';
import type { Pcm } from '../audio/pcm';
import { Waveform } from './Waveform';
import { Meter } from './Meter';
import { fmtTime } from './controls';

/** Waveform + transport with real Web Audio playback and meters. */
export function Player(p: { pcm: Pcm | null | undefined; label?: string; height?: number; selectable?: boolean; onSelection?: (s: { start: number; end: number } | null) => void; color?: string; meter?: boolean }) {
  const [h, setH] = useState<PlayHandle | null>(null), [pos, setPos] = useState<number | null>(null), [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const raf = useRef(0);
  useEffect(() => () => { cancelAnimationFrame(raf.current); }, []);
  useEffect(() => { setSel(null); }, [p.pcm]);
  const start = () => {
    if (!p.pcm) return;
    const off = sel ? sel.start : 0;
    let src = p.pcm;
    if (sel) { const a = Math.floor(sel.start * src.sampleRate), b = Math.floor(sel.end * src.sampleRate); src = { sampleRate: src.sampleRate, channels: src.channels.map((c) => c.subarray(a, b)) }; }
    const hd = play(src, 0, () => { setH(null); setPos(null); });
    setH(hd);
    const tick = () => { setPos(off + hd.position()); raf.current = requestAnimationFrame(tick); };
    cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(tick);
    hd.ended.then(() => cancelAnimationFrame(raf.current));
  };
  const stop = () => { stopAll(); setH(null); setPos(null); cancelAnimationFrame(raf.current); };
  const dur = p.pcm ? p.pcm.channels[0].length / p.pcm.sampleRate : 0;
  return (
    <div className="col">
      {p.label && <div className="row between"><b style={{ fontSize: 14 }}>{p.label}</b><span className="pill">{fmtTime(dur)}</span></div>}
      <div className="row" style={{ alignItems: 'stretch', flexWrap: 'nowrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}><Waveform pcm={p.pcm} height={p.height} playhead={pos} color={p.color} selection={sel} onSelect={p.selectable ? (s) => { setSel(s); p.onSelection?.(s); } : undefined} /></div>
        {p.meter !== false && <Meter handle={h} />}
      </div>
      <div className="row">
        {h ? <button className="btn sm" onClick={stop}>■ Stop</button> : <button className="btn sm pri" disabled={!p.pcm} onClick={start}>▶ Play{sel ? ' selection' : ''}</button>}
        {pos != null && <span className="pill">{fmtTime(pos)}</span>}
        {sel && <><span className="pill vio">{fmtTime(sel.start)} – {fmtTime(sel.end)}</span><button className="btn sm" onClick={() => { setSel(null); p.onSelection?.(null); }}>Clear</button></>}
        {p.selectable && !sel && <span style={{ fontSize: 12, color: 'var(--mute)' }}>Drag to select · pinch / wheel to zoom</span>}
      </div>
    </div>
  );
}
