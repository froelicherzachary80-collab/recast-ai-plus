import { useApp } from '../state';
import { cancelJob, dismissJob } from '../actions';

export function JobBar() {
  const j = useApp((s) => s.job);
  if (!j) return null;
  const elapsed = (performance.now() - j.startedAt) / 1000;
  const eta = j.progress > 0.03 && !j.done && !j.error ? (elapsed / j.progress) * (1 - j.progress) : null;
  return (
    <div className={`jobbar ${j.error ? "err" : ""} ${j.done ? "done" : ""}`}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <div><b>{j.name}</b> <span style={{ color: j.error ? 'var(--err)' : 'var(--dim)', fontSize: 13 }}>— {j.error ?? j.stage}</span></div>
        <div className="row">
          <span className="pill">{Math.round(j.progress * 100)}%{eta != null ? ` · ~${eta.toFixed(0)} s left` : ''}</span>
          {!j.done && !j.error && j.cancellable && <button className="btn sm danger" onClick={cancelJob}>Cancel</button>}
          {j.error && j.retry && <button className="btn sm" onClick={() => { dismissJob(); j.retry!(); }}>Retry</button>}
          {(j.done || j.error) && <button className="btn sm" onClick={dismissJob}>Close</button>}
        </div>
      </div>
      <div className="prog"><i style={{ width: `${j.progress * 100}%` }} /></div>
      {!j.done && !j.error && <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>Keep this tab in the foreground — iOS may suspend background processing.</div>}
    </div>
  );
}
