import { useEffect, useRef } from 'react';
import { analyserLevels, type PlayHandle } from '../audio/playback';

/** Live peak/RMS meter fed by AnalyserNodes on the actual playback signal. */
export function Meter({ handle }: { handle: PlayHandle | null }) {
  const ref = useRef<HTMLDivElement>(null), hold = useRef([0, 0]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current; if (el) {
        const bars = el.querySelectorAll<HTMLDivElement>('.bar');
        [0, 1].forEach((i) => {
          const lv = handle ? analyserLevels(handle.analysers[i]) : { peak: 0, rms: 0 };
          const toPct = (v: number) => Math.max(0, Math.min(100, ((20 * Math.log10(v + 1e-9) + 60) / 60) * 100));
          hold.current[i] = Math.max(lv.peak, hold.current[i] * 0.97);
          const b = bars[i]; if (!b) return;
          (b.children[0] as HTMLElement).style.height = `${toPct(lv.rms * 1.41)}%`;
          (b.children[1] as HTMLElement).style.bottom = `${toPct(hold.current[i])}%`;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [handle]);
  return <div className="meter" ref={ref} title="Real-time RMS (bar) and peak hold (line), −60…0 dBFS"><div className="bar"><div className="fill" /><div className="pk" /></div><div className="bar"><div className="fill" /><div className="pk" /></div></div>;
}
