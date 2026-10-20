import React from 'react';

export function Slider(p: { label: React.ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string; disabled?: boolean; tag?: 'nn' | 'dsp' | 'na' }) {
  return (
    <label className="ctl" style={{ opacity: p.disabled ? 0.5 : 1 }}>
      <span>{p.label}{p.tag && <span className={`tag ${p.tag}`}>{p.tag === 'nn' ? 'neural' : p.tag === 'dsp' ? 'DSP' : 'n/a'}</span>}</span>
      <span className="v">{p.fmt ? p.fmt(p.value) : p.value.toFixed(2)}</span>
      <input type="range" min={p.min} max={p.max} step={p.step ?? 0.01} value={p.value} disabled={p.disabled} onChange={(e) => p.onChange(parseFloat(e.target.value))} />
    </label>
  );
}

export function Toggle(p: { label: React.ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="row" style={{ fontSize: 14, cursor: 'pointer' }}><input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} /> {p.label}</label>;
}

export function Seg<T extends string>(p: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return <div className="seg">{p.options.map((o) => <button key={o.v} className={o.v === p.value ? 'on' : ''} onClick={() => p.onChange(o.v)}>{o.l}</button>)}</div>;
}

export function FileButton(p: { label: string; accept: string; onFile: (f: File) => void; multiple?: boolean; pri?: boolean; disabled?: boolean }) {
  const ref = React.useRef<HTMLInputElement>(null);
  return (<>
    <button className={`btn ${p.pri ? 'pri' : ''}`} disabled={p.disabled} onClick={() => ref.current?.click()}>{p.label}</button>
    <input ref={ref} type="file" accept={p.accept} multiple={p.multiple} hidden onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) p.onFile(f); e.target.value = ''; }} />
  </>);
}

export const fmtDb = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '−∞ dB');
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
export const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);
