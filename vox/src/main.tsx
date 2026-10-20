import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { getState, setState, subscribe } from './state';
import { detectCaps } from './ml/caps';
import { loadLibrary, scheduleSave } from './actions';

// Network audit: records every request this page makes so the user can verify no audio is uploaded.
const origFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = init?.body as any;
  const bytes = body ? (body.byteLength ?? body.size ?? (typeof body === 'string' ? body.length : 0)) : 0;
  setState((s) => ({ network: [...s.network.slice(-300), { url, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), t: Date.now(), bytes }] }));
  return origFetch(input as any, init);
};
try {
  new PerformanceObserver((l) => {
    const e = l.getEntries().map((x: any) => ({ url: x.name, method: x.initiatorType, t: Date.now(), bytes: 0 }));
    setState((s) => ({ network: [...s.network.slice(-300), ...e] }));
  }).observe({ type: 'resource', buffered: true });
} catch { /* not supported */ }

let lastProject = getState().project;
subscribe(() => { const p = getState().project; if (p !== lastProject) { lastProject = p; scheduleSave(); } });

detectCaps().then((caps) => setState((s) => ({ caps, settings: { ...s.settings, backend: caps.webgpu ? s.settings.backend : 'wasm' } })));
loadLibrary().catch((e) => console.error(e));
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));

createRoot(document.getElementById('root')!).render(<App />);
