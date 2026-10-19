// RECAST AI+ — device capability test (reports only what the browser actually exposes).
import { codecSupport, mediabunny, mediabunnyError } from './media.js';
import { storageInfo } from './db.js';
import { loadVision } from './models.js';

export async function capabilityTest() {
  const r = { ua: navigator.userAgent, at: Date.now(), checks: [] };
  const add = (group, name, ok, detail = '') => r.checks.push({ group, name, ok, detail });
  // WebGPU
  if (navigator.gpu) {
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (ad) {
        add('GPU', 'WebGPU adapter', true, ad.info?.vendor ? `${ad.info.vendor} ${ad.info.architecture || ''}` : 'available');
        const L = ad.limits;
        add('GPU', 'WebGPU limits', true, `maxTexture2D ${L.maxTextureDimension2D}, maxBuffer ${(L.maxBufferSize / 2 ** 20) | 0} MB, maxStorageBuffer ${(L.maxStorageBufferBindingSize / 2 ** 20) | 0} MB`);
        add('GPU', 'shader-f16 feature', ad.features.has('shader-f16'), ad.features.has('shader-f16') ? 'supported' : 'not exposed');
      } else add('GPU', 'WebGPU adapter', false, 'navigator.gpu exists but no adapter was returned');
    } catch (e) { add('GPU', 'WebGPU adapter', false, e.message); }
  } else add('GPU', 'WebGPU', false, 'navigator.gpu not present (v0.1 does not require it)');
  const gl2 = document.createElement('canvas').getContext('webgl2');
  add('GPU', 'WebGL2 (face renderer, MediaPipe GPU delegate)', !!gl2, gl2 ? `max texture ${gl2.getParameter(gl2.MAX_TEXTURE_SIZE)}` : 'missing: face replacement unavailable');
  gl2?.getExtension('WEBGL_lose_context')?.loseContext();
  add('Compute', 'WebAssembly', typeof WebAssembly === 'object', typeof WebAssembly === 'object' ? 'available' : 'missing');
  add('Compute', 'WASM SIMD', await (async () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } })());
  add('Compute', 'Web Workers', typeof Worker !== 'undefined');
  add('Compute', 'OffscreenCanvas', typeof OffscreenCanvas !== 'undefined');
  // Codecs
  const cs = await codecSupport();
  add('Video', 'WebCodecs VideoDecoder', cs.videoDecoder); add('Video', 'WebCodecs VideoEncoder', cs.videoEncoder); add('Video', 'WebCodecs AudioEncoder', cs.audioEncoder);
  for (const [k, v] of Object.entries(cs.encode)) add('Encode', k, v);
  for (const [k, v] of Object.entries(cs.decode)) add('Decode', k, v);
  add('Encode', 'MediaRecorder types', cs.mediaRecorder.length > 0, cs.mediaRecorder.join(', ') || 'none');
  const mb = await mediabunny();
  add('Libraries', 'Mediabunny (jsDelivr)', !!mb, mb ? 'loaded' : String(mediabunnyError()?.message || 'not loaded'));
  try { await loadVision(); add('Libraries', 'MediaPipe Tasks Vision + WASM', true, 'loaded'); } catch (e) { add('Libraries', 'MediaPipe Tasks Vision + WASM', false, e.message); }
  // Storage & memory
  const st = await storageInfo();
  add('Storage', 'IndexedDB', typeof indexedDB !== 'undefined');
  add('Storage', 'Quota estimate', st.quota != null, st.quota != null ? `${fmtBytes(st.usage)} used of ${fmtBytes(st.quota)}` : 'not reported');
  add('Storage', 'Persistent storage granted', !!st.persisted, st.persisted ? 'yes' : 'not granted (Safari may evict after inactivity; installing to Home Screen helps)');
  add('Storage', 'Origin Private File System', !!navigator.storage?.getDirectory);
  const dm = navigator.deviceMemory;
  add('Memory', 'Device memory hint', !!dm, dm ? `${dm} GB` : 'Safari does not expose memory. Presets cap clip length and resolution instead.');
  if (performance.memory) add('Memory', 'JS heap', true, `${fmtBytes(performance.memory.usedJSHeapSize)} / ${fmtBytes(performance.memory.jsHeapSizeLimit)}`);
  add('App', 'Installed (standalone)', matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
  add('App', 'Web Share with files', !!navigator.canShare?.({ files: [new File([new Uint8Array(1)], 'a.mp4', { type: 'video/mp4' })] }));
  return r;
}
export function fmtBytes(n) { if (n == null) return '?'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; }
