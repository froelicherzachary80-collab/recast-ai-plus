/**
 * MDX-Net (UVR) ONNX source-separation adapter. Model input/output: spectrogram
 * [1, 4, dim_f, dim_t] = (L.re, L.im, R.re, R.im) over the first dim_f bins of a
 * torch.stft(center=True, hann periodic) with hop 1024. Same chunking as UVR:
 * chunk = hop*(dim_t-1), trim = n_fft/2, generated = chunk - 2*trim.
 */
import { hann, istft, stft } from '../audio/fft';
import type { Pcm } from '../audio/pcm';
import { type OrtLike, type SessionLike, type JobControl, checkCancel, inputShape, disposeAll } from './ortTypes';

export interface MdxConfig { nFft: number; hop: number; dimF: number; dimT: number; compensate: number; primary: 'vocals' | 'instrumental'; }

export const MDX_PRESETS: Record<string, MdxConfig> = {
  'UVR-MDX-NET Inst HQ (n_fft 6144)': { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.0, primary: 'instrumental' },
  'Kim Vocal / Voc_FT (n_fft 7680)': { nFft: 7680, hop: 1024, dimF: 3072, dimT: 256, compensate: 1.0, primary: 'vocals' },
  'UVR-MDX-NET Main (n_fft 4096 / dim_f 2048)': { nFft: 4096, hop: 1024, dimF: 2048, dimT: 256, compensate: 1.0, primary: 'vocals' },
};

export function isMdxModel(s: SessionLike) { const sh = inputShape(s, s.inputNames[0]); return s.inputNames.length === 1 && (!sh || (sh.length === 4 && (sh[1] === 4 || typeof sh[1] === 'string'))); }

/** Fill dim_f / dim_t from model metadata when the model declares fixed sizes. */
export function mdxConfigFromModel(s: SessionLike, base: MdxConfig): MdxConfig {
  const sh = inputShape(s, s.inputNames[0]);
  const c = { ...base };
  if (sh && typeof sh[2] === 'number') c.dimF = sh[2] as number;
  if (sh && typeof sh[3] === 'number') c.dimT = sh[3] as number;
  return c;
}

export async function separateMdx(ort: OrtLike, s: SessionLike, mix: Pcm, cfg: MdxConfig, ctl?: JobControl): Promise<{ vocals: Pcm; instrumental: Pcm; chunks: number }> {
  if (mix.sampleRate !== 44100) throw new Error('MDX expects 44.1 kHz input (resample first)');
  const L = mix.channels[0], R = mix.channels[1] ?? mix.channels[0], n = L.length;
  const { nFft, hop, dimF, dimT } = cfg, chunk = hop * (dimT - 1), trim = nFft >> 1, gen = chunk - 2 * trim;
  if (gen <= 0) throw new Error('Invalid MDX config');
  const pad = gen - (n % gen), total = trim + n + pad + trim;
  const padded = [new Float32Array(total), new Float32Array(total)];
  padded[0].set(L, trim); padded[1].set(R, trim);
  const prim = [new Float32Array(n + pad), new Float32Array(n + pad)];
  const win = hann(nFft), bins = (nFft >> 1) + 1, name = s.inputNames[0];
  const nChunks = Math.ceil((n + pad) / gen);
  for (let k = 0, i = 0; i + chunk <= total; i += gen, k++) {
    checkCancel(ctl);
    const spec = new Float32Array(4 * dimF * dimT);
    for (let c = 0; c < 2; c++) {
      const st = stft(padded[c].subarray(i, i + chunk), nFft, hop, win);
      for (let t = 0; t < dimT && t < st.frames; t++) for (let f = 0; f < dimF; f++) {
        spec[((c * 2) * dimF + f) * dimT + t] = st.re[t * bins + f];
        spec[((c * 2 + 1) * dimF + f) * dimT + t] = st.im[t * bins + f];
      }
    }
    const inp = new ort.Tensor('float32', spec, [1, 4, dimF, dimT]);
    const res = await s.run({ [name]: inp });
    inp.dispose?.();
    const o = res[s.outputNames[0]].data as Float32Array;
    for (let c = 0; c < 2; c++) {
      const re = new Float32Array(dimT * bins), im = new Float32Array(dimT * bins);
      for (let t = 0; t < dimT; t++) for (let f = 0; f < dimF; f++) {
        re[t * bins + f] = o[((c * 2) * dimF + f) * dimT + t];
        im[t * bins + f] = o[((c * 2 + 1) * dimF + f) * dimT + t];
      }
      const y = istft(re, im, dimT, nFft, hop, chunk, win);
      const dst = prim[c], off = i;
      for (let j = 0; j < gen; j++) if (off + j < dst.length) dst[off + j] = y[trim + j] * cfg.compensate;
    }
    disposeAll(res);
    ctl?.onProgress?.(Math.min(1, (k + 1) / nChunks), `Separation chunk ${k + 1}/${nChunks}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  const p = [prim[0].slice(0, n), prim[1].slice(0, n)];
  const other = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) { const src = c === 0 ? L : R; for (let j = 0; j < n; j++) other[c][j] = src[j] - p[c][j]; }
  const A: Pcm = { sampleRate: 44100, channels: p }, B: Pcm = { sampleRate: 44100, channels: other };
  return cfg.primary === 'vocals' ? { vocals: A, instrumental: B, chunks: nChunks } : { vocals: B, instrumental: A, chunks: nChunks };
}
