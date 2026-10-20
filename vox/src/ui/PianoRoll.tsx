import { useEffect, useRef } from 'react';
import type { F0Track } from '../audio/f0';
import { hzToMidi, NOTE_NAMES } from '../audio/f0';
import type { Note } from '../audio/notes';

export type Tool = 'move' | 'split' | 'range';
interface Props {
  tr: F0Track | null; target: Float32Array | null; notes: Note[]; selected: string | null; scale: number[] | null; wave: Float32Array | null; waveSr: number;
  tool: Tool; range: { start: number; end: number } | null; playhead: number | null; height: number;
  onSelect: (id: string | null) => void; onChange: (notes: Note[], commit: boolean) => void; onSplit: (id: string, t: number) => void; onRange: (r: { start: number; end: number } | null) => void;
}

/** Canvas piano roll: real F0 curves, editable note blocks, pinch/wheel zoom, drag to move pitch/timing. */
export function PianoRoll(p: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef({ t0: 0, span: 10, m0: 40, mspan: 36 });
  const props = useRef(p); props.current = p;
  const dur = p.tr ? p.tr.f0.length / (p.tr.sampleRate / p.tr.hop) : 10;
  useEffect(() => {
    if (!p.tr) return;
    const v: number[] = []; for (let i = 0; i < p.tr.f0.length; i++) if (p.tr.voiced[i]) v.push(hzToMidi(p.tr.f0[i]));
    v.sort((a, b) => a - b);
    const lo = v.length ? v[Math.floor(v.length * 0.02)] : 48, hi = v.length ? v[Math.floor(v.length * 0.98)] : 72;
    view.current = { t0: 0, span: Math.min(dur, 12), m0: Math.floor(lo) - 6, mspan: Math.max(18, Math.ceil(hi - lo) + 12) };
  }, [p.tr]);
  useEffect(() => draw());
  function geom() { const c = ref.current!, w = c.clientWidth, h = p.height; const v = view.current; return { w, h, x: (t: number) => ((t - v.t0) / v.span) * w, y: (m: number) => h - ((m - v.m0) / v.mspan) * h, t: (x: number) => v.t0 + (x / w) * v.span, m: (y: number) => v.m0 + ((h - y) / h) * v.mspan }; }
  function draw() {
    const c = ref.current; if (!c) return;
    const P = props.current, dpr = window.devicePixelRatio || 1, { w, h, x, y } = geom();
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = view.current, rowH = h / v.mspan;
    for (let m = Math.floor(v.m0); m <= v.m0 + v.mspan; m++) {
      const pc = ((m % 12) + 12) % 12, black = [1, 3, 6, 8, 10].includes(pc), inScale = !P.scale || P.scale.includes(pc);
      g.fillStyle = inScale ? (black ? '#120e22' : '#17122b') : '#0c0917'; g.fillRect(0, y(m + 0.5), w, rowH);
      if (pc === 0) { g.fillStyle = '#ffffff22'; g.fillRect(0, y(m - 0.5), w, 1); }
      if (rowH > 9) { g.fillStyle = '#6f6795'; g.font = '9px system-ui'; g.fillText(`${NOTE_NAMES[pc]}${Math.floor(m / 12) - 1}`, 2, y(m) + 3); }
    }
    // seconds grid
    g.fillStyle = '#ffffff10'; const step = v.span > 30 ? 5 : v.span > 8 ? 1 : 0.5;
    for (let t = Math.ceil(v.t0 / step) * step; t < v.t0 + v.span; t += step) g.fillRect(x(t), 0, 1, h);
    if (P.wave) { const sr = P.waveSr; g.fillStyle = '#7c4dff30'; for (let px = 0; px < w; px += 2) { const a = Math.floor(geomT(px) * sr), b = Math.floor(geomT(px + 2) * sr); let mx = 0; for (let i = Math.max(0, a); i < Math.min(P.wave.length, b); i += 4) mx = Math.max(mx, Math.abs(P.wave[i])); g.fillRect(px, h - mx * h * 0.25, 2, mx * h * 0.25); } }
    function geomT(px: number) { return v.t0 + (px / w) * v.span; }
    if (P.range) { g.fillStyle = '#5ad1ff22'; g.fillRect(x(P.range.start), 0, x(P.range.end) - x(P.range.start), h); }
    for (const n of P.notes) {
      const sel = n.id === P.selected, m = n.midi + n.shift;
      const nx = x(n.start + n.timeShift), nw = Math.max(3, x(n.end + n.timeShift) - nx);
      g.fillStyle = sel ? '#a46bffcc' : '#7c4dff77'; g.strokeStyle = sel ? '#fff' : '#a46bff';
      g.beginPath(); (g as any).roundRect ? (g as any).roundRect(nx, y(m + 0.45), nw, rowH * 0.9, 4) : g.rect(nx, y(m + 0.45), nw, rowH * 0.9); g.fill(); g.stroke();
      if (n.gainDb !== 0 || n.vibrato !== 1 || n.formant !== 1) { g.fillStyle = '#ffc857'; g.fillRect(nx + 2, y(m + 0.45) + 2, 4, 4); }
    }
    const fps = P.tr ? P.tr.sampleRate / P.tr.hop : 100;
    const curve = (arr: Float32Array, color: string, voicedOnly: Uint8Array | null) => {
      g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath(); let pen = false, prevM = 0;
      const i0 = Math.max(0, Math.floor(v.t0 * fps)), i1 = Math.min(arr.length, Math.ceil((v.t0 + v.span) * fps));
      for (let i = i0; i < i1; i++) { const ok = arr[i] > 0 && (!voicedOnly || voicedOnly[i]); if (!ok) { pen = false; continue; } const mm = hzToMidi(arr[i]), X = x(i / fps), Y = y(mm); if (pen && Math.abs(mm - prevM) > 3) pen = false; pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true; prevM = mm; }
      g.stroke();
    };
    if (P.tr) curve(P.tr.f0, '#ffd98aaa', P.tr.voiced);
    if (P.target) curve(P.target, '#5ad1ff', null);
    if (P.playhead != null) { g.fillStyle = '#fff'; g.fillRect(x(P.playhead), 0, 2, h); }
    g.fillStyle = '#a59cc9'; g.font = '11px system-ui'; g.fillText('— detected F0   — edited target', w - 190, 14);
  }
  useEffect(() => {
    const c = ref.current!; const pts = new Map<number, { x: number; y: number }>();
    let drag: { id: string; m0: number; t0: number; x0: number; y0: number; shift0: number; ts0: number } | null = null;
    let pinch: { d: number; span: number; mspan: number; t0: number; m0: number; cx: number; cy: number } | null = null, rangeA: number | null = null;
    const local = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const hit = (x: number, y: number) => { const G = geom(); return props.current.notes.find((n) => { const m = n.midi + n.shift; return x >= G.x(n.start + n.timeShift) && x <= G.x(n.end + n.timeShift) && Math.abs(G.m(y) - m) < 0.6; }); };
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId); const L = local(e); pts.set(e.pointerId, L);
      if (pts.size === 2) { drag = null; rangeA = null; const [a, b] = [...pts.values()], v = view.current; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), span: v.span, mspan: v.mspan, t0: v.t0, m0: v.m0, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; return; }
      const P = props.current, G = geom();
      if (P.tool === 'range') { rangeA = G.t(L.x); return; }
      const n = hit(L.x, L.y);
      if (!n) { P.onSelect(null); drag = { id: '', m0: 0, t0: G.t(L.x), x0: L.x, y0: L.y, shift0: view.current.m0, ts0: view.current.t0 }; return; }
      P.onSelect(n.id);
      if (P.tool === 'split') { P.onSplit(n.id, G.t(L.x) - n.timeShift); return; }
      drag = { id: n.id, m0: G.m(L.y), t0: G.t(L.x), x0: L.x, y0: L.y, shift0: n.shift, ts0: n.timeShift };
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return; const L = local(e); pts.set(e.pointerId, L);
      const v = view.current, G = geom();
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, k = pinch.d / d;
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        v.span = Math.min(dur + 1, Math.max(0.3, pinch.span * k));
        v.t0 = Math.max(0, pinch.t0 + (pinch.cx / G.w) * pinch.span - (cx / G.w) * v.span);
        v.m0 = pinch.m0 + ((cy - pinch.cy) / G.h) * v.mspan;
        draw(); return;
      }
      if (rangeA != null) { const t = G.t(L.x); props.current.onRange({ start: Math.max(0, Math.min(rangeA, t)), end: Math.min(dur, Math.max(rangeA, t)) }); return; }
      if (!drag) return;
      if (!drag.id) { v.t0 = Math.max(0, drag.ts0 - ((L.x - drag.x0) / G.w) * v.span); v.m0 = drag.shift0 + ((L.y - drag.y0) / G.h) * v.mspan; draw(); return; }
      const dm = G.m(L.y) - drag.m0, dt = G.t(L.x) - drag.t0, fine = e.shiftKey || e.altKey;
      const notes = props.current.notes.map((n) => n.id !== drag!.id ? n : { ...n, shift: fine ? +(drag!.shift0 + dm).toFixed(2) : Math.round(drag!.shift0 + dm), timeShift: Math.abs(L.x - drag!.x0) > 12 ? Math.max(-0.25, Math.min(0.25, drag!.ts0 + dt)) : drag!.ts0 });
      props.current.onChange(notes, false);
    };
    const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (drag?.id) props.current.onChange(props.current.notes, true); drag = null; rangeA = null; if (pts.size < 2) pinch = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); const v = view.current, G = geom(), L = { x: e.clientX - c.getBoundingClientRect().left };
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) { const t = G.t(L.x), ns = Math.min(dur + 1, Math.max(0.3, v.span * Math.exp(e.deltaY * 0.002))); v.t0 = Math.max(0, t - (t - v.t0) * (ns / v.span)); v.span = ns; } else v.t0 = Math.max(0, v.t0 + (e.deltaX / G.w) * v.span); draw(); };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('wheel', wheel, { passive: false });
    return () => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); c.removeEventListener('wheel', wheel); };
  }, [dur]);
  return <canvas ref={ref} className="roll" style={{ height: p.height }} />;
}
