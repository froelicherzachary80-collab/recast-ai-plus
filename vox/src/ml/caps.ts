/** Runtime capability detection — every flag here is measured, never assumed. */
export interface Caps {
  webgpu: boolean; gpuAdapter: string | null; gpuFeatures: string[]; maxBufferMB: number | null;
  wasm: boolean; wasmSimd: boolean; wasmThreads: boolean; crossOriginIsolated: boolean;
  opfs: boolean; audioWorklet: boolean; offlineAudio: boolean; mediaRecorder: boolean; getUserMedia: boolean;
  deviceMemoryGB: number | null; cores: number; userAgent: string; isIOS: boolean; isSafari: boolean; serviceWorker: boolean; standalone: boolean;
}

const simdProbe = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export async function detectCaps(): Promise<Caps> {
  const nav = navigator as any;
  let webgpu = false, gpuAdapter: string | null = null, gpuFeatures: string[] = [], maxBufferMB: number | null = null;
  try {
    const ad = await nav.gpu?.requestAdapter?.();
    if (ad) {
      webgpu = true;
      const info = ad.info ?? (await ad.requestAdapterInfo?.());
      gpuAdapter = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'WebGPU adapter';
      gpuFeatures = Array.from(ad.features ?? []) as string[];
      maxBufferMB = ad.limits?.maxBufferSize ? Math.round(ad.limits.maxBufferSize / 1048576) : null;
    }
  } catch { /* unsupported */ }
  const wasm = typeof WebAssembly === 'object';
  let wasmSimd = false; try { wasmSimd = wasm && WebAssembly.validate(simdProbe); } catch { /* */ }
  let opfs = false; try { opfs = !!(await navigator.storage?.getDirectory?.()); } catch { /* */ }
  const ua = navigator.userAgent, isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    webgpu, gpuAdapter, gpuFeatures, maxBufferMB, wasm, wasmSimd,
    wasmThreads: typeof SharedArrayBuffer !== 'undefined' && (globalThis as any).crossOriginIsolated === true,
    crossOriginIsolated: (globalThis as any).crossOriginIsolated === true,
    opfs, audioWorklet: typeof AudioWorkletNode !== 'undefined', offlineAudio: typeof OfflineAudioContext !== 'undefined',
    mediaRecorder: typeof MediaRecorder !== 'undefined', getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    deviceMemoryGB: nav.deviceMemory ?? null, cores: navigator.hardwareConcurrency || 1, userAgent: ua, isIOS,
    isSafari: /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|Edg/.test(ua), serviceWorker: 'serviceWorker' in navigator,
    standalone: matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
  };
}

/** Conservative limit of simultaneously loaded neural models given measured/assumed memory. */
export function maxLoadedModels(c: Caps, memorySaving: boolean): number {
  if (memorySaving) return 1;
  const mem = c.deviceMemoryGB ?? (c.isIOS ? 4 : 8); // iOS doesn't expose deviceMemory; assume tab budget is limited
  return mem >= 8 ? 4 : mem >= 4 ? 2 : 1;
}
