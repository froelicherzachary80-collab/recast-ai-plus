// RECAST AI+ v0.5 — music beat detection (pure, unit-tested).
// Spectral-flux onsets → tempo by autocorrelation → beat times by dynamic programming (Ellis 2007).

/** In-place radix-2 FFT. re, im: Float32Array of length 2^k. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Onset strength envelope (spectral flux on log magnitudes). Returns { env, hop } with hop in seconds. */
export function onsetEnvelope(mono, sr, { win = 1024, hopN = 512 } = {}) {
  const frames = Math.max(0, Math.floor((mono.length - win) / hopN) + 1), bins = win / 2;
  const w = new Float32Array(win); for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);
  const re = new Float32Array(win), im = new Float32Array(win), prev = new Float32Array(bins), env = new Float32Array(frames);
  const maxBin = Math.min(bins, Math.round(8000 / (sr / win)));
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < win; i++) { re[i] = mono[f * hopN + i] * w[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < maxBin; k++) { const m = Math.log1p(100 * Math.hypot(re[k], im[k])); const d = m - prev[k]; if (d > 0 && f > 0) flux += d; prev[k] = m; }
    env[f] = flux;
  }
  // remove slow trend and normalize
  const out = new Float32Array(frames), half = 8;
  for (let f = 0; f < frames; f++) { let s = 0, n = 0; for (let j = Math.max(0, f - half); j <= Math.min(frames - 1, f + half); j++) { s += env[j]; n++; } out[f] = Math.max(0, env[f] - s / n); }
  let mx = 0; for (const v of out) mx = Math.max(mx, v); if (mx > 0) for (let f = 0; f < frames; f++) out[f] /= mx;
  return { env: out, hop: hopN / sr };
}

/** Tempo in BPM from the onset envelope (autocorrelation with a mild preference around 120 BPM). */
export function estimateTempo(env0, hop, { min = 70, max = 180 } = {}) {
  // light blur so beat periods that fall between whole frames still line up
  let env = env0; for (let r = 0; r < 2; r++) { const o = new Float32Array(env.length); for (let i = 0; i < env.length; i++) o[i] = 0.25 * (env[i - 1] ?? env[i]) + 0.5 * env[i] + 0.25 * (env[i + 1] ?? env[i]); env = o; }
  const lo = Math.max(1, Math.round(60 / max / hop)), hi = Math.round(60 / min / hop);
  let best = lo, bv = -Infinity;
  for (let L = lo; L <= hi; L++) {
    let s = 0; for (let i = L; i < env.length; i++) s += env[i] * env[i - L];
    s /= env.length - L;
    const bpm = 60 / (L * hop), prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * prior > bv) { bv = s * prior; best = L; }
  }
  // parabolic refinement of the lag
  const ac = L => { let s = 0; for (let i = L; i < env.length; i++) s += env[i] * env[i - L]; return s / (env.length - L); };
  const a = ac(best - 1), b = ac(best), c = ac(best + 1), d = (a - 2 * b + c) ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
  return 60 / ((best + Math.max(-0.5, Math.min(0.5, d))) * hop);
}

/** Beat times (s) by dynamic programming over the onset envelope. */
export function trackBeats(env, hop, bpm, { tightness = 100 } = {}) {
  const P = 60 / bpm / hop, n = env.length; if (!n) return [];
  const score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0, bi = -1;
    for (let p = Math.max(0, Math.round(t - 2 * P)); p <= t - Math.round(P / 2); p++) {
      const v = score[p] - tightness * Math.log((t - p) / P) ** 2;
      if (v > best || bi < 0) { best = v; bi = p; }
    }
    score[t] = env[t] + (bi >= 0 ? Math.max(0, best) : 0); back[t] = bi >= 0 && best > 0 ? bi : -1;
  }
  // start from the best-scoring frame in the last beat period
  let t = n - 1, bs = -Infinity; for (let i = Math.max(0, Math.floor(n - P)); i < n; i++) if (score[i] > bs) { bs = score[i]; t = i; }
  const beats = []; while (t >= 0) { beats.push(t * hop); t = back[t]; }
  return beats.reverse();
}

/** Full analysis. Returns { bpm, beats, env, hop, strong } where strong = beats with high onset (for accents). */
export function analyzeBeats(mono, sr) {
  const { env, hop } = onsetEnvelope(mono, sr);
  const bpm = estimateTempo(env, hop), beats = trackBeats(env, hop, bpm);
  const strengths = beats.map(b => { const i = Math.round(b / hop); let m = 0; for (let j = Math.max(0, i - 2); j <= Math.min(env.length - 1, i + 2); j++) m = Math.max(m, env[j]); return m; });
  const sorted = [...strengths].sort((a, b) => b - a), cut = sorted[Math.floor(sorted.length * 0.25)] ?? 1;
  return { bpm, beats, env, hop, strong: beats.filter((_, i) => strengths[i] >= cut) };
}
