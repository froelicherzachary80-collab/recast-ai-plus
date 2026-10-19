// RECAST AI+ v0.2 — clean background plates, hole filling, and full-body reference analysis.
import { getTask, segment, hasModel } from './models.js';
import { REQUIRED_JOINTS, joint } from './puppet.js';

/** Push-pull hole filling (pure). rgb: Float32Array w*h*3, known: Float32Array w*h (0..1 weight).
 *  Fills unknown pixels with smooth averages of their surroundings. Returns new Float32Array. */
export function pushPullFill(rgb, known, w, h) {
  const levels = [{ c: rgb, k: known, w, h }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const L = levels[levels.length - 1], nw = Math.max(1, Math.ceil(L.w / 2)), nh = Math.max(1, Math.ceil(L.h / 2));
    const c = new Float32Array(nw * nh * 3), k = new Float32Array(nw * nh);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x, o = (y >> 1) * nw + (x >> 1), wt = L.k[i];
      if (!wt) continue;
      k[o] += wt; c[o * 3] += L.c[i * 3] * wt; c[o * 3 + 1] += L.c[i * 3 + 1] * wt; c[o * 3 + 2] += L.c[i * 3 + 2] * wt;
    }
    for (let o = 0; o < nw * nh; o++) if (k[o] > 0) { c[o * 3] /= k[o]; c[o * 3 + 1] /= k[o]; c[o * 3 + 2] /= k[o]; k[o] = Math.min(1, k[o]); }
    levels.push({ c, k, w: nw, h: nh });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], U = levels[l + 1];
    const out = new Float32Array(L.c);
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const i = y * L.w + x, wt = L.k[i];
      if (wt >= 1) continue;
      // bilinear sample of the coarser level
      const fx = Math.min(U.w - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(U.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(U.w - 1, x0 + 1), y1 = Math.min(U.h - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const v = (U.c[(y0 * U.w + x0) * 3 + ch] * (1 - ax) + U.c[(y0 * U.w + x1) * 3 + ch] * ax) * (1 - ay) + (U.c[(y1 * U.w + x0) * 3 + ch] * (1 - ax) + U.c[(y1 * U.w + x1) * 3 + ch] * ax) * ay;
        out[i * 3 + ch] = L.c[i * 3 + ch] * wt + v * (1 - wt);
      }
    }
    L.c = out;
  }
  return levels[0].c;
}

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** Build a clean background plate by averaging every pixel over the sampled frames where no person covers it.
 *  Works for locked-off (static) camera shots. Pixels never uncovered are filled by push-pull (soft). */
export async function buildCleanPlate(grabber, plan, { samples = 24, onProgress, signal } = {}) {
  if (!(await hasModel('selfie'))) throw new Error('Install the Selfie Segmenter model to build a clean plate.');
  const task = await getTask('selfie', 'IMAGE');
  const W = plan.width, H = plan.height, n = Math.min(samples, plan.frames);
  const sum = new Float32Array(W * H * 3), cnt = new Float32Array(W * H);
  for (let s = 0; s < n; s++) {
    if (signal?.aborted) throw new Error('Cancelled');
    const k = n === 1 ? 0 : Math.round((s / (n - 1)) * (plan.frames - 1));
    const c = await grabber.get(k);
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const seg = segment(task, c, 'IMAGE', [-1]), m = seg.masks[0], mw = seg.width, mh = seg.height;
    // dilate the person mask a little (shadows, motion blur)
    const pad = Math.max(2, Math.round(Math.min(mw, mh) * 0.02));
    const person = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (m[y * mw + x] > 0.25) {
      for (let yy = Math.max(0, y - pad); yy <= Math.min(mh - 1, y + pad); yy++) for (let xx = Math.max(0, x - pad); xx <= Math.min(mw - 1, x + pad); xx++) person[yy * mw + xx] = 1;
    }
    for (let y = 0; y < H; y++) {
      const my = Math.min(mh - 1, (y * mh / H) | 0);
      for (let x = 0; x < W; x++) {
        if (person[my * mw + Math.min(mw - 1, (x * mw / W) | 0)]) continue;
        const i = y * W + x; cnt[i]++; sum[i * 3] += d[i * 4]; sum[i * 3 + 1] += d[i * 4 + 1]; sum[i * 3 + 2] += d[i * 4 + 2];
      }
    }
    onProgress?.(s + 1, n);
    await new Promise(r => setTimeout(r, 0));
  }
  const known = new Float32Array(W * H); let holes = 0;
  for (let i = 0; i < W * H; i++) { if (cnt[i]) { sum[i * 3] /= cnt[i]; sum[i * 3 + 1] /= cnt[i]; sum[i * 3 + 2] /= cnt[i]; known[i] = 1; } else holes++; }
  const filled = holes ? pushPullFill(sum, known, W, H) : sum;
  const out = mk(W, H), ctx = out.getContext('2d'), img = ctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { img.data[i * 4] = filled[i * 3]; img.data[i * 4 + 1] = filled[i * 3 + 1]; img.data[i * 4 + 2] = filled[i * 3 + 2]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.92));
  return { blob, holes: holes / (W * H), samples: n };
}

/** Analyze a full-body photo: pose landmarks + person cutout. Returns serializable data for the rig. */
export async function analyzeBody(blob, toCanvas) {
  const canvas = await toCanvas(blob, 1600);
  const poseKey = (await hasModel('pose_full')) ? 'pose_full' : 'pose_lite';
  const pose = await getTask(poseKey, 'IMAGE', { num: 1 });
  const r = pose.detect(canvas);
  const lm = r.landmarks?.[0];
  if (!lm) throw new Error('No body found in the full-body photo.');
  if (!(await hasModel('selfie'))) throw new Error('Install the Selfie Segmenter model to cut out your body.');
  const seg = segment(await getTask('selfie', 'IMAGE'), canvas, 'IMAGE', [-1]);
  const m = seg.masks[0], mw = seg.width, mh = seg.height, W = canvas.width, H = canvas.height;
  // bounding box of the person
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[Math.min(mh - 1, (y * mh / H) | 0) * mw + Math.min(mw - 1, (x * mw / W) | 0)] > 0.4) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) throw new Error('Could not separate you from the background. Use a plain background.');
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const cut = mk(cw, ch), cctx = cut.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
  const img = cctx.getImageData(0, 0, cw, ch), alpha = new Uint8Array(cw * ch);
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = m[Math.min(mh - 1, ((y + y0) * mh / H) | 0) * mw + Math.min(mw - 1, ((x + x0) * mw / W) | 0)];
    const a = Math.max(0, Math.min(1, (v - 0.3) / 0.4)), i = y * cw + x;
    img.data[i * 4 + 3] = alpha[i] = Math.round(a * 255);
    if (a > 0.9) { sr += img.data[i * 4]; sg += img.data[i * 4 + 1]; sb += img.data[i * 4 + 2]; sn++; }
  }
  cctx.putImageData(img, 0, 0);
  const get = i => [lm[i].x * W - x0, lm[i].y * H - y0];
  const joints = {}; for (const k of ['nose', 'lSh', 'rSh', 'lEl', 'rEl', 'lWr', 'rWr', 'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn', 'neck', 'pelvis']) joints[k] = joint(get, k);
  const vis = { lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28 };
  const missing = REQUIRED_JOINTS.filter(k => (lm[vis[k]].visibility ?? 1) < 0.5);
  const png = await new Promise(res => cut.toBlob(res, 'image/png'));
  return { ok: true, png, w: cw, h: ch, alpha, joints, mean: sn ? [sr / sn, sg / sn, sb / sn] : [128, 128, 128], missing, poseModel: poseKey,
    issues: [...(missing.length ? [`Not clearly visible: ${missing.join(', ')}. Stand fully in frame, arms slightly away from the body.`] : []), ...(ch < 600 ? ['Photo is small; use a higher-resolution full-body shot.'] : [])] };
}
