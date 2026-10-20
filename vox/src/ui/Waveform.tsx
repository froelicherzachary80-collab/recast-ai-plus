import { useEffect, useRef } from 'react';
import { toMono, waveformPeaks, type Pcm } from '../audio/pcm';

/** Draws real min/max peaks of the PCM. Optional pinch/wheel zoom & drag-to-pan, selection, playhead. */
export function Waveform(p: { pcm: Pcm | null | undefined; height?: number; color?: string; playhead?: number | null; selection?: { start: number; end: number } | null; onSelect?: (s: { start: number; end: number } | null) => void; zoomable?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef({ start: 0, span: 1 }); // fraction of total
  const mono = useRef<Float32Array | null>(null);
  useEffect(() => { mono.current = p.pcm ? toMono(p.pcm) : null; view.current = { start: 0, span: 1 }; draw(); }, [p.pcm]);
  useEffect(() => { draw(); });
  function draw() {
    const c = ref.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = p.height ?? c.clientHeight;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const x = mono.current; if (!x || !p.pcm) { g.fillStyle = '#6f6795'; g.font = '13px system-ui'; g.fillText('No audio', 12, h / 2); return; }
    const dur = x.length / p.pcm.sampleRate, v = view.current;
    const a = Math.floor(v.start * x.length), b = Math.floor((v.start + v.span) * x.length);
    const pk = waveformPeaks(x, Math.max(1, Math.floor(w)), a, b);
    const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, p.color ?? '#c9a8ff'); grad.addColorStop(1, '#7c4dff');
    g.fillStyle = grad;
    for (let i = 0; i < w; i++) { const mn = pk[i * 2], mx = pk[i * 2 + 1]; const y0 = h / 2 - mx * h / 2, y1 = h / 2 - mn * h / 2; g.fillRect(i, y0, 1, Math.max(1, y1 - y0)); }
    g.fillStyle = '#ffffff14'; g.fillRect(0, h / 2, w, 1);
    const tx = (t: number) => ((t / dur - v.start) / v.span) * w;
    if (p.selection) { g.fillStyle = '#a46bff33'; g.fillRect(tx(p.selection.start), 0, tx(p.selection.end) - tx(p.selection.start), h); }
    if (p.playhead != null) { g.fillStyle = '#fff'; g.fillRect(tx(p.playhead), 0, 2, h); }
    g.fillStyle = '#a59cc9'; g.font = '11px system-ui';
    g.fillText(`${(v.start * dur).toFixed(1)}s`, 4, 12); g.fillText(`${((v.start + v.span) * dur).toFixed(1)}s`, w - 40, 12);
  }
  // gestures
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const pts = new Map<number, number>(); let pinch0 = 0, span0 = 1, start0 = 0, selA: number | null = null;
    const tAt = (clientX: number) => { const r = c.getBoundingClientRect(), v = view.current; return (v.start + ((clientX - r.left) / r.width) * v.span); };
    const down = (e: PointerEvent) => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, e.clientX);
      if (pts.size === 2) { const [x1, x2] = [...pts.values()]; pinch0 = Math.abs(x2 - x1); span0 = view.current.span; start0 = view.current.start; selA = null; }
      else if (p.onSelect) selA = tAt(e.clientX); };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e.clientX);
      if (pts.size === 2 && p.zoomable !== false) { const [x1, x2] = [...pts.values()], d = Math.abs(x2 - x1) || 1, ns = Math.min(1, Math.max(0.002, span0 * pinch0 / d)); const mid = start0 + span0 / 2; view.current = { span: ns, start: Math.min(1 - ns, Math.max(0, mid - ns / 2)) }; draw(); }
      else if (selA != null && p.onSelect && p.pcm) { const dur = p.pcm.channels[0].length / p.pcm.sampleRate, b = tAt(e.clientX); p.onSelect({ start: Math.max(0, Math.min(selA, b)) * dur, end: Math.min(1, Math.max(selA, b)) * dur }); }
    };
    const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; selA = null; };
    const wheel = (e: WheelEvent) => { if (p.zoomable === false) return; e.preventDefault(); const v = view.current, f = Math.exp(e.deltaY * 0.002), t = tAt(e.clientX), ns = Math.min(1, Math.max(0.002, v.span * f)); view.current = { span: ns, start: Math.min(1 - ns, Math.max(0, t - (t - v.start) * (ns / v.span))) }; draw(); };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('wheel', wheel, { passive: false });
    return () => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); c.removeEventListener('wheel', wheel); };
  }, [p.pcm, p.onSelect, p.zoomable]);
  return <canvas ref={ref} className="wave" style={p.height ? { height: p.height } : undefined} />;
}
