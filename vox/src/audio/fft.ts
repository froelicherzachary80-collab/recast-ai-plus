/** In-place radix-2 complex FFT plus Bluestein for arbitrary sizes (MDX-Net uses n_fft=6144/7680). */
const twCache = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();
function plan(n: number) {
  let p = twCache.get(n);
  if (p) return p;
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  p = { cos, sin, rev }; twCache.set(n, p);
  return p;
}
export const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

export function fftPow2(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length, { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
      const wr = cos[k], wi = inverse ? -sin[k] : sin[k];
      const a = i + j, b = a + half;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const bluCache = new Map<number, { m: number; wr: Float64Array; wi: Float64Array; br: Float64Array; bi: Float64Array }>();
function bluPlan(n: number) {
  let p = bluCache.get(n);
  if (p) return p;
  let m = 1; while (m < 2 * n - 1) m <<= 1;
  const wr = new Float64Array(n), wi = new Float64Array(n);
  for (let k = 0; k < n; k++) { const a = (Math.PI * ((k * k) % (2 * n))) / n; wr[k] = Math.cos(a); wi[k] = -Math.sin(a); }
  const br = new Float64Array(m), bi = new Float64Array(m);
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k++) { br[k] = br[m - k] = wr[k]; bi[k] = bi[m - k] = -wi[k]; }
  fftPow2(br, bi);
  p = { m, wr, wi, br, bi }; bluCache.set(n, p);
  return p;
}

export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  if (isPow2(n)) return fftPow2(re, im, inverse);
  if (inverse) { for (let i = 0; i < n; i++) im[i] = -im[i]; }
  const { m, wr, wi, br, bi } = bluPlan(n);
  const ar = new Float64Array(m), ai = new Float64Array(m);
  for (let k = 0; k < n; k++) { ar[k] = re[k] * wr[k] - im[k] * wi[k]; ai[k] = re[k] * wi[k] + im[k] * wr[k]; }
  fftPow2(ar, ai);
  for (let k = 0; k < m; k++) { const r = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; }
  fftPow2(ar, ai, true);
  for (let k = 0; k < n; k++) { re[k] = ar[k] * wr[k] - ai[k] * wi[k]; im[k] = ar[k] * wi[k] + ai[k] * wr[k]; }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

export function hann(n: number, periodic = true): Float64Array {
  const w = new Float64Array(n), d = periodic ? n : n - 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

/** torch.stft(center=True, pad_mode='reflect') compatible. Returns [frames][bins] re/im. */
export function stft(x: Float32Array, nfft: number, hop: number, win = hann(nfft)) {
  const pad = nfft >> 1, L = x.length + 2 * pad;
  const xp = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    let j = i - pad;
    if (x.length > 1) { while (j < 0 || j >= x.length) { if (j < 0) j = -j; if (j >= x.length) j = 2 * (x.length - 1) - j; } }
    else j = 0;
    xp[i] = x[j] ?? 0;
  }
  const frames = 1 + Math.floor((L - nfft) / hop), bins = (nfft >> 1) + 1;
  const re = new Float32Array(frames * bins), im = new Float32Array(frames * bins);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    for (let i = 0; i < nfft; i++) { fr[i] = xp[t * hop + i] * win[i]; fi[i] = 0; }
    fft(fr, fi);
    for (let b = 0; b < bins; b++) { re[t * bins + b] = fr[b]; im[t * bins + b] = fi[b]; }
  }
  return { re, im, frames, bins };
}

/** Inverse of stft() (torch.istft center=True) with window-sum normalisation. */
export function istft(re: Float32Array, im: Float32Array, frames: number, nfft: number, hop: number, length: number, win = hann(nfft)) {
  const bins = (nfft >> 1) + 1, pad = nfft >> 1, L = nfft + hop * (frames - 1);
  const out = new Float64Array(L), wsum = new Float64Array(L);
  const fr = new Float64Array(nfft), fi = new Float64Array(nfft);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) { fr[b] = re[t * bins + b]; fi[b] = im[t * bins + b]; }
    for (let b = bins; b < nfft; b++) { fr[b] = fr[nfft - b]; fi[b] = -fi[nfft - b]; }
    fft(fr, fi, true);
    for (let i = 0; i < nfft; i++) { out[t * hop + i] += fr[i] * win[i]; wsum[t * hop + i] += win[i] * win[i]; }
  }
  const y = new Float32Array(length);
  for (let i = 0; i < length; i++) { const k = i + pad; if (k < L) y[i] = wsum[k] > 1e-10 ? out[k] / wsum[k] : 0; }
  return y;
}

/** Magnitude spectrum of a real frame (power-of-two size). */
export function magSpectrum(frame: Float64Array): Float64Array {
  const n = frame.length, re = frame.slice(), im = new Float64Array(n);
  fftPow2(re, im);
  const m = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) m[i] = Math.hypot(re[i], im[i]);
  return m;
}
