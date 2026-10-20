// RECAST AI+ — character reference analysis: landmarks, quality, mesh, low-frequency color, hair extraction.
import { getTask, segment } from './models.js';
import { buildFaceMesh, edgeDistances, faceYaw, N_FACE } from './facemesh.js';
import { laplacianVariance, rgbToHsl, hslToRgb, hexToRgb, clamp } from './geometry.js';

export const SLOTS = [
  { key: 'front', label: 'Front face', need: 'required', used: 'Face texture (frontal shots)' },
  { key: 'left', label: 'Left profile', need: 'recommended', used: 'Face texture when the actor turns' },
  { key: 'right', label: 'Right profile', need: 'recommended', used: 'Face texture when the actor turns' },
  { key: 'hair', label: 'Hairstyle reference', need: 'optional', used: 'Hair overlay (front face photo is used if empty)' },
  { key: 'tpose', label: 'T-pose photo', need: 'optional', used: 'Best Pose Studio model: arms straight out to the sides, facing the camera, head to feet, plain background.' },
  { key: 'body', label: 'Full body', need: 'recommended', used: 'Whole-body Animate: stand facing the camera, head to feet in frame, arms slightly away from the body, plain background.' },
  { key: 'side', label: 'Side body', need: 'optional', used: 'Stored for V0.2. Not used by v0.1 rendering.' },
  { key: 'rear', label: 'Rear body', need: 'optional', used: 'Stored for V0.2. Not used by v0.1 rendering.' },
];
export const VIDEO_SLOTS = [
  { key: 'expr', label: 'Expression video', used: 'Stored for V0.2 expression library. Not used by v0.1.' },
  { key: 'motion', label: 'Walk / turn video', used: 'Stored for V0.2 body appearance. Not used by v0.1.' },
];

export async function blobToCanvas(blob, maxSide = 1280) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return c;
}

/** Downsample a face-region crop to a tiny blurred RGBA map (low-frequency color/lighting). */
export function tinyCrop(src, box, size = 16) {
  let [x0, y0, x1, y1] = box;
  const w = Math.max(2, x1 - x0), h = Math.max(2, y1 - y0);
  let cur = document.createElement('canvas'); cur.width = 128; cur.height = 128;
  cur.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, 128, 128);
  for (let s = 64; s >= size; s /= 2) {
    const n = document.createElement('canvas'); n.width = n.height = s;
    const ctx = n.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cur, 0, 0, s, s); cur = n;
  }
  return { data: cur.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data, size, box: [x0, y0, x0 + w, y0 + h] };
}
export function faceBox(xy, margin = 0.15) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xy.length; i += 2) { x0 = Math.min(x0, xy[i]); y0 = Math.min(y0, xy[i + 1]); x1 = Math.max(x1, xy[i]); y1 = Math.max(y1, xy[i + 1]); }
  const mw = (x1 - x0) * margin, mh = (y1 - y0) * margin;
  return [x0 - mw, y0 - mh, x1 + mw, y1 + mh];
}

/** Analyze one reference photo. Returns serializable analysis. */
export async function analyzeReference(blob, { refine = true } = {}) {
  let canvas = await blobToCanvas(blob);
  const task = await getTask('face', 'IMAGE', { num: 2 });
  const r = task.detect(canvas);
  const faces = r.faceLandmarks || [];
  const q = { faces: faces.length, width: canvas.width, height: canvas.height, issues: [] };
  if (!faces.length) { q.issues.push('No face detected'); return { ok: false, quality: q }; }
  if (faces.length > 1) q.issues.push('More than one face: the largest is used');
  // largest face
  let best = faces[0], bw = 0;
  for (const f of faces) { const xs = f.map(p => p.x); const w = Math.max(...xs) - Math.min(...xs); if (w > bw) { bw = w; best = f; } }
  // One full-body or group photo: the face is small. Re-crop it from the full-resolution image and detect again,
  // so the face texture keeps all the detail the photo has.
  if (refine) {
    const xs = best.map(p => p.x), ys = best.map(p => p.y), fwN = Math.max(...xs) - Math.min(...xs);
    if (fwN * canvas.width < 420) {
      const full = await blobToCanvas(blob, 6000);
      if (full.width > canvas.width * 1.2) {
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2 * full.width, cy = (Math.max(...ys) + Math.min(...ys)) / 2 * full.height, side = Math.min(full.width, full.height, fwN * full.width * 2.6);
        const x0 = Math.max(0, Math.min(full.width - side, cx - side / 2)), y0 = Math.max(0, Math.min(full.height - side, cy - side * 0.55));
        const crop = document.createElement('canvas'), out = Math.min(1280, Math.round(side)); crop.width = crop.height = out;
        const cctx0 = crop.getContext('2d'); cctx0.imageSmoothingQuality = 'high'; cctx0.drawImage(full, x0, y0, side, side, 0, 0, out, out);
        const r2 = task.detect(crop);
        if (r2.faceLandmarks?.length) { canvas = crop; best = r2.faceLandmarks.reduce((a, f) => (Math.max(...f.map(p => p.x)) - Math.min(...f.map(p => p.x)) > Math.max(...a.map(p => p.x)) - Math.min(...a.map(p => p.x)) ? f : a)); q.refined = true; q.width = canvas.width; q.height = canvas.height; }
      }
    }
  }
  const xy = new Float32Array(N_FACE * 2), lm3 = new Float32Array(N_FACE * 3);
  for (let i = 0; i < N_FACE; i++) { const p = best[i] || best[best.length - 1]; xy[i * 2] = p.x * canvas.width; xy[i * 2 + 1] = p.y * canvas.height; lm3[i * 3] = p.x; lm3[i * 3 + 1] = p.y; lm3[i * 3 + 2] = p.z; }
  const box = faceBox(xy, 0.05);
  const faceW = box[2] - box[0];
  q.facePx = Math.round(faceW);
  q.yaw = +faceYaw(lm3).toFixed(2);
  if (faceW < 160) q.issues.push(`Face is small (${Math.round(faceW)}px wide). Use a closer photo (≥ 250px face).`);
  // brightness + sharpness on face crop
  const cw = 96, ch = 96, cc = document.createElement('canvas'); cc.width = cw; cc.height = ch;
  const cctx = cc.getContext('2d', { willReadFrequently: true }); cctx.drawImage(canvas, box[0], box[1], faceW, box[3] - box[1], 0, 0, cw, ch);
  const d = cctx.getImageData(0, 0, cw, ch).data, gray = new Float32Array(cw * ch); let sum = 0;
  for (let i = 0; i < gray.length; i++) { gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += gray[i]; }
  q.brightness = Math.round(sum / gray.length);
  q.sharpness = Math.round(laplacianVariance(gray, cw, ch));
  if (q.brightness < 60) q.issues.push('Too dark'); if (q.brightness > 215) q.issues.push('Overexposed');
  if (q.sharpness < 40) q.issues.push('Looks blurry');
  q.score = clamp(Math.round(100 - q.issues.length * 22 - (faceW < 250 ? 10 : 0)), 5, 100);
  const tiny = tinyCrop(canvas, faceBox(xy, 0.15));
  const texBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
  return { ok: true, quality: q, xy, lm3, yaw: q.yaw, w: canvas.width, h: canvas.height, tiny: { data: new Uint8ClampedArray(tiny.data), size: tiny.size, box: tiny.box }, texBlob };
}

/** Build the profile's shared mesh from the front reference, and edge maps for each view. */
export function buildProfileMesh(profile) {
  const front = profile.refs?.front?.analysis;
  if (!front?.ok) return null;
  const mesh = buildFaceMesh(front.xy);
  const edges = {};
  for (const k of ['front', 'left', 'right']) { const a = profile.refs?.[k]?.analysis; if (a?.ok) edges[k] = k === 'front' ? mesh.edge : edgeDistances(a.xy); }
  return { tris: mesh.tris, flags: mesh.flags, edges };
}

export function missingViews(profile) {
  const out = [];
  for (const s of SLOTS) if (s.need !== 'optional' && !profile.refs?.[s.key]) out.push(s.label);
  return out;
}

/** Extract hair layer (RGBA) from the hair or front reference using the multiclass segmenter. */
export async function extractHair(blob, analysis) {
  const canvas = await blobToCanvas(blob);
  const task = await getTask('multiclass', 'IMAGE');
  const seg = segment(task, canvas, 'IMAGE', [1]);
  if (!seg?.masks?.[0]) throw new Error('Segmenter returned no hair mask.');
  const { width: mw, height: mh } = seg, hair = seg.masks[0];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height); const d = img.data;
  let count = 0;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const mx = Math.min(mw - 1, (x * mw / canvas.width) | 0), my = Math.min(mh - 1, (y * mh / canvas.height) | 0);
    const a = clamp((hair[my * mw + mx] - 0.35) / 0.4, 0, 1);
    d[(y * canvas.width + x) * 4 + 3] = Math.round(a * 255); if (a > 0.5) count++;
  }
  ctx.putImageData(img, 0, 0);
  if (count < 200) throw new Error('Almost no hair found in this photo.');
  // anchor landmarks for alignment — from this photo's own face landmarks
  let xy = analysis?.xy;
  if (!xy || analysis.w !== canvas.width || analysis.quality?.refined) { const a = await analyzeReference(blob, { refine: false }); if (!a.ok) throw new Error('No face found in hair photo for alignment.'); xy = a.xy; }
  const png = await new Promise(res => canvas.toBlob(res, 'image/png'));
  return { png, xy, w: canvas.width, h: canvas.height, pixels: count };
}

/** Apply color/tint to a hair RGBA canvas (CPU, run when settings change). */
export function recolorCanvas(srcCanvas, hex, strength, brightness = 0) {
  const c = document.createElement('canvas'); c.width = srcCanvas.width; c.height = srcCanvas.height;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(srcCanvas, 0, 0);
  if (!strength && !brightness) return c;
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  const [th, ts] = rgbToHsl(...hexToRgb(hex));
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    const l2 = clamp(l + brightness, 0, 1);
    const base = hslToRgb(h, s, l2), tint = hslToRgb(th, s + (ts - s) * 0.8, l2);
    for (let k = 0; k < 3; k++) d[i + k] = base[k] + (tint[k] - base[k]) * strength;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function newProfile(name = 'Myself', self = true) {
  return { id: 'p' + Date.now().toString(36), name, self, consent: self ? { by: 'self', at: Date.now() } : null, refs: {}, videos: {}, hair: null, settings: { hairColor: '#4a3426', hairTint: 0, hairBright: 0, hairVolume: 1, hairFringe: 0, hairOpacity: 0.95 }, createdAt: Date.now() };
}
