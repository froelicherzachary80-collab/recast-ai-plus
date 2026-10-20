import { useEffect, useRef, useState } from 'react';
import { toMono, waveformPeaks, type Pcm } from '../audio/pcm';
import type { Track } from '../audio/mixer';

function RegionWave({ pcm, width }: { pcm: Pcm; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.min(4000, Math.round(width))), h = 40;
    c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d')!; g.scale(dpr, dpr);
    const pk = waveformPeaks(toMono(pcm), w); g.fillStyle = '#ffffffaa';
    for (let i = 0; i < w; i++) { const y0 = h / 2 - pk[i * 2 + 1] * h / 2, y1 = h / 2 - pk[i * 2] * h / 2; g.fillRect(i, y0, 1, Math.max(1, y1 - y0)); }
  }, [pcm, Math.round(width / 50)]);
  return <canvas ref={ref} />;
}

/** Multitrack timeline: draggable regions (track offset), pinch / wheel zoom, playhead. */
export function Timeline(p: { tracks: Track[]; assets: Map<string, Pcm>; playhead: number | null; onOffset: (id: string, offset: number) => void; onSeek?: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pps, setPps] = useState(20); // pixels per second
  const [drag, setDrag] = useState<{ id: string; x0: number; off0: number; off: number } | null>(null);
  const dur = Math.max(10, ...p.tracks.map((t) => (t.assetId && p.assets.get(t.assetId) ? t.offset + p.assets.get(t.assetId)!.channels[0].length / p.assets.get(t.assetId)!.sampleRate : 0))) + 5;
  useEffect(() => {
    const el = ref.current!; const pts = new Map<number, number>(); let d0 = 0, p0 = pps;
    const down = (e: PointerEvent) => { if (e.pointerType !== 'touch') return; pts.set(e.pointerId, e.clientX); if (pts.size === 2) { const [a, b] = [...pts.values()]; d0 = Math.abs(a - b); p0 = pps; } };
    const move = (e: PointerEvent) => { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e.clientX); if (pts.size === 2 && d0) { const [a, b] = [...pts.values()]; setPps(Math.max(2, Math.min(400, p0 * (Math.abs(a - b) / d0)))); } };
    const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) d0 = 0; };
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey) return; e.preventDefault(); setPps((v) => Math.max(2, Math.min(400, v * Math.exp(-e.deltaY * 0.003)))); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.removeEventListener('wheel', wheel); };
  }, [pps]);
  const cls = (t: Track) => (t.kind === 'instrumental' ? 'inst' : t.kind === 'original' ? 'orig' : '');
  return (<div className="col">
    <div className="row"><span style={{ fontSize: 12, color: 'var(--mute)' }}>Zoom</span><input type="range" min={2} max={400} value={pps} onChange={(e) => setPps(+e.target.value)} style={{ maxWidth: 200 }} /><span className="pill">{pps.toFixed(0)} px/s</span><span style={{ fontSize: 12, color: 'var(--mute)' }}>Pinch (touch) or Ctrl+wheel. Drag regions to move them in time.</span></div>
    <div className="timeline" ref={ref} style={{ overflowX: 'auto', touchAction: 'pan-x pan-y' }}>
      <div style={{ width: dur * pps, position: 'relative' }} onClick={(e) => { if ((e.target as HTMLElement).classList.contains('lane')) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); p.onSeek?.((e.clientX - r.left) / pps); } }}>
        {p.tracks.map((t) => {
          const pcm = t.assetId ? p.assets.get(t.assetId) : null, len = pcm ? pcm.channels[0].length / pcm.sampleRate : 0;
          const off = drag?.id === t.id ? drag.off : t.offset;
          return (<div className="lane" key={t.id}><span className="lbl">{t.name}{t.mute ? ' (muted)' : ''}</span>
            {pcm && <div className={`region ${cls(t)}`} style={{ left: off * pps, width: len * pps, opacity: t.mute ? 0.35 : 1, touchAction: 'none' }}
              onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setDrag({ id: t.id, x0: e.clientX, off0: t.offset, off: t.offset }); }}
              onPointerMove={(e) => { if (drag?.id === t.id) setDrag({ ...drag, off: Math.max(0, drag.off0 + (e.clientX - drag.x0) / pps) }); }}
              onPointerUp={() => { if (drag?.id === t.id) { p.onOffset(t.id, Math.round(drag.off * 1000) / 1000); setDrag(null); } }}>
              <RegionWave pcm={pcm} width={len * pps} /></div>}
          </div>);
        })}
        {p.playhead != null && <div className="playhead" style={{ left: p.playhead * pps }} />}
      </div>
    </div>
  </div>);
}
