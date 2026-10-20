/** Band-limited windowed-sinc (Kaiser) resampler. Quality is adequate for model front-ends (16 kHz) and mixing. */
function bessel0(x: number) { let s = 1, t = 1; for (let k = 1; k < 25; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }

export function resample(x: Float32Array, from: number, to: number, halfTaps = 16): Float32Array {
  if (from === to) return x.slice();
  const ratio = to / from, n = Math.max(0, Math.round(x.length * ratio)), out = new Float32Array(n);
  const cutoff = Math.min(1, ratio) * 0.97, beta = 8.0, i0b = bessel0(beta);
  const width = Math.ceil(halfTaps / Math.min(1, ratio));
  // Precompute a fine kernel table for speed.
  const OS = 512, tab = new Float32Array(width * OS + 1);
  for (let j = 0; j <= width * OS; j++) {
    const t = j / OS, w = t >= width ? 0 : bessel0(beta * Math.sqrt(1 - (t / width) ** 2)) / i0b;
    const a = Math.PI * t * cutoff;
    tab[j] = (t === 0 ? cutoff : (Math.sin(a) / (Math.PI * t))) * w;
  }
  for (let i = 0; i < n; i++) {
    const pos = i / ratio, c = Math.floor(pos);
    let s = 0;
    for (let k = c - width + 1; k <= c + width; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = Math.abs(pos - k) * OS, j = d | 0;
      if (j >= tab.length - 1) continue;
      const f = d - j;
      s += x[k] * (tab[j] + (tab[j + 1] - tab[j]) * f);
    }
    out[i] = s;
  }
  return out;
}
