// RECAST AI+ v0.6 — one photo → every reference view, each labelled by how it was made:
//   captured (cut straight from your photo) · synthesized (re-rendered from your photo with geometry) ·
//   estimated (a guess for parts the photo never showed; check it before keeping).
import { analyzeReference, extractHair, blobToCanvas, tinyCrop, faceBox } from './profile.js';
import { analyzeBody, pushPullFill } from './plate.js';
import { makeTPoseModel } from './tpose.js';
import { FaceRenderer } from './facerender.js';
import { faceYaw, FACE_OVAL, STABLE, N_FACE } from './facemesh.js';
import { triAffine, triSign, pointInPolygon, delaunay } from './geometry.js';

/** Rotate MediaPipe face landmarks (x,y normalized; z ≈ x scale) about the vertical axis. Pure. */
export function rotateFace3D(lm3, w, h, theta) {
  let cx = 0, cz = 0; for (const i of STABLE) { cx += lm3[i * 3] * w; cz += lm3[i * 3 + 2] * w; } cx /= STABLE.length; cz /= STABLE.length;
  const n = lm3.length / 3, xy = new Float32Array(n * 2), lm = new Float32Array(n * 3), depth = new Float32Array(n), c = Math.cos(theta), s = Math.sin(theta);
  for (let i = 0; i < n; i++) {
    const X = lm3[i * 3] * w - cx, Y = lm3[i * 3 + 1] * h, Z = lm3[i * 3 + 2] * w - cz;
    const X2 = X * c + Z * s, Z2 = -X * s + Z * c;
    xy[i * 2] = cx + X2; xy[i * 2 + 1] = Y; depth[i] = Z2;
    lm[i * 3] = (cx + X2) / w; lm[i * 3 + 1] = Y / h; lm[i * 3 + 2] = (Z2 + cz) / w;
  }
  return { xy, lm3: lm, depth };
}

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));

/** Fill a polygon region of a canvas from its surroundings (push-pull). */
function fillRegion(canvas, poly, pad = 4) {
  const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d', { willReadFrequently: true });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = (x1 - x0) * 0.25; x0 = Math.max(0, Math.floor(x0 - m)); y0 = Math.max(0, Math.floor(y0 - m)); x1 = Math.min(W, Math.ceil(x1 + m)); y1 = Math.min(H, Math.ceil(y1 + m));
  const w = x1 - x0, h = y1 - y0; if (w < 4 || h < 4) return;
  const img = ctx.getImageData(x0, y0, w, h), d = img.data, rgb = new Float32Array(w * h * 3), known = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
    known[i] = pointInPolygon(x + x0, y + y0, poly) ? 0 : 1;
  }
  const f = pushPullFill(rgb, known, w, h);
  for (let i = 0; i < w * h; i++) if (!known[i]) { d[i * 4] = f[i * 3]; d[i * 4 + 1] = f[i * 3 + 1]; d[i * 4 + 2] = f[i * 3 + 2]; }
  ctx.putImageData(img, x0, y0);
}

/** Pure: rotate head points about a vertical axis behind the face. pts: [{x,y,z,move}] → [{x,y,z}]. */
export function rotateHeadPoints(pts, cx, pivotZ, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return pts.map(p => {
    if (!p.move) return { x: p.x, y: p.y, z: p.z };
    const dx = p.x - cx, dz = p.z - pivotZ, nx = cx + dx * c + dz * s, nz = pivotZ - dx * s + dz * c;
    return { x: p.x + (nx - p.x) * p.move, y: p.y, z: p.z + (nz - p.z) * p.move };
  });
}

/** 2.5D head model: the 478 face points plus rings for hair, ears and the sides of the head (they turn with the
 *  face, fading out toward the shoulders) and fixed image-border points so the background stays put. */
export function headModel(front) {
  const W = front.w, H = front.h, P = [];
  for (let i = 0; i < N_FACE; i++) P.push({ x: front.lm3[i * 3] * W, y: front.lm3[i * 3 + 1] * H, z: front.lm3[i * 3 + 2] * W, move: 1 });
  let cx = 0, cy = 0, cz = 0; for (const i of STABLE) { cx += P[i].x; cz += P[i].z; } cx /= STABLE.length; cz /= STABLE.length;
  for (const i of FACE_OVAL) cy += P[i].y; cy /= FACE_OVAL.length;
  const fw = Math.hypot(P[454].x - P[234].x, P[454].y - P[234].y) || W * 0.3, pivotZ = cz + fw * 0.75;
  for (const [scale, move, zf] of [[1.28, 0.9, 0.55], [1.65, 0.55, 0.9], [2.1, 0.2, 1]]) for (const i of FACE_OVAL) {
    const x = cx + (P[i].x - cx) * scale, y = cy + (P[i].y - cy) * scale;
    if (x < 1 || y < 1 || x > W - 1 || y > H - 1) continue;
    P.push({ x, y, z: P[i].z + (pivotZ - P[i].z) * zf, move });
  }
  for (let k = 0; k <= 8; k++) for (const [x, y] of [[k / 8 * W, 0], [k / 8 * W, H], [0, k / 8 * H], [W, k / 8 * H]]) P.push({ x, y, z: pivotZ + fw, move: 0 });
  return { P, tris: delaunay(P.map(p => [p.x, p.y])), cx, pivotZ };
}

/** Re-render your photo with the head turned by theta radians. Face, hair and ears turn; background stays.
 *  Parts that turn away are hidden (drawn far-to-near); nothing new is invented. Returns {canvas, analysis}. */
export async function synthesizeFaceView(front, theta) {
  const src = await blobToCanvas(front.texBlob, 4096), W = src.width, H = src.height;
  const fr = { ...front, w: W, h: H }, M = headModel(fr), Q = rotateHeadPoints(M.P, M.cx, M.pivotZ, theta);
  const out = mk(W, H), ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const area = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const order = M.tris.map((t, i) => [i, Q[t[0]].z + Q[t[1]].z + Q[t[2]].z]).sort((x, y) => y[1] - x[1]);
  for (const [ti] of order) {
    const [i, j, k] = M.tris[ti], s0 = M.P[i], s1 = M.P[j], s2 = M.P[k], d0 = Q[i], d1 = Q[j], d2 = Q[k];
    const as = area(s0, s1, s2), ad = area(d0, d1, d2);
    if (Math.abs(as) < 1e-6 || Math.sign(as) !== Math.sign(ad) || Math.abs(ad / as) < 0.08) continue;
    const T = triAffine([s0.x, s0.y], [s1.x, s1.y], [s2.x, s2.y], [d0.x, d0.y], [d1.x, d1.y], [d2.x, d2.y]); if (!T) continue;
    const mx = (d0.x + d1.x + d2.x) / 3, my = (d0.y + d1.y + d2.y) / 3, ex = p => { const dx = p.x - mx, dy = p.y - my, l = Math.hypot(dx, dy) || 1; return [p.x + dx / l * 0.7, p.y + dy / l * 0.7]; };
    ctx.save(); ctx.beginPath(); ctx.moveTo(...ex(d0)); ctx.lineTo(...ex(d1)); ctx.lineTo(...ex(d2)); ctx.closePath(); ctx.clip();
    ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]); ctx.drawImage(src, 0, 0); ctx.restore();
  }
  const xy = new Float32Array(N_FACE * 2), lm3 = new Float32Array(N_FACE * 3);
  for (let i = 0; i < N_FACE; i++) { xy[i * 2] = Q[i].x; xy[i * 2 + 1] = Q[i].y; lm3[i * 3] = Q[i].x / W; lm3[i * 3 + 1] = Q[i].y / H; lm3[i * 3 + 2] = Q[i].z / W; }
  const tiny = tinyCrop(out, faceBox(xy, 0.15)), yaw = +faceYaw(lm3).toFixed(2);
  const analysis = { ok: true, generated: true, xy, lm3, yaw, w: W, h: H, tiny: { data: new Uint8ClampedArray(tiny.data), size: tiny.size, box: tiny.box }, texBlob: await toBlob(out, 'image/jpeg', 0.92),
    quality: { score: 60, yaw, generated: true, facePx: Math.round(Math.hypot(xy[454 * 2] - xy[234 * 2], xy[454 * 2 + 1] - xy[234 * 2 + 1])), issues: ['Synthesized from your front photo: the far ear and cheek are not real detail.'] } };
  return { canvas: out, analysis };
}

/** Horizontal soft blur by down/up-sampling (works in every browser, unlike ctx.filter). */
function softBlur(c, k) { const s = mk(Math.max(2, Math.round(c.width / k)), Math.max(2, Math.round(c.height / k))); s.getContext('2d').drawImage(c, 0, 0, s.width, s.height); const o = mk(c.width, c.height), x = o.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(s, 0, 0, c.width, c.height); return o; }
function alphaOf(c) { const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data, a = new Uint8Array(c.width * c.height); let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < a.length; i++) { a[i] = d[i * 4 + 3]; if (a[i] > 230) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; } } return { alpha: a, mean: n ? [r / n, g / n, b / n] : [128, 128, 128] }; }

/** Estimated side view: the body narrowed as if turned ~65° with shading on the far side. */
export async function estimateSideBody(body) {
  const cut = await blobToCanvas(body.png, 4096), k = 0.48, cx = body.joints.pelvis[0], W = Math.round(body.w * k) + 8, H = body.h;
  const out = mk(W, H), ctx = out.getContext('2d');
  ctx.save(); ctx.translate(W / 2, 0); ctx.scale(k, 1); ctx.translate(-cx, 0); ctx.drawImage(cut, 0, 0); ctx.restore();
  ctx.globalCompositeOperation = 'source-atop'; const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0.38)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const joints = {}; for (const [n, [x, y]] of Object.entries(body.joints)) joints[n] = [W / 2 + (x - cx) * k, y];
  const { alpha, mean } = alphaOf(out);
  return { canvas: out, body: { ok: true, png: await toBlob(out), w: W, h: H, alpha, joints, mean, missing: [], estimated: true, source: 'side-estimate', issues: ['Estimated: a narrowed front view, not a real side profile.'] } };
}

/** Estimated rear view: mirrored body, front details softened, head covered with your hair. */
export async function estimateRearBody(body, hair) {
  const cut = await blobToCanvas(body.png, 4096), W = body.w, H = body.h, out = mk(W, H), ctx = out.getContext('2d');
  ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(cut, 0, 0); ctx.restore();
  // soften front-only details (buttons, logos, face) inside the silhouette
  const soft = softBlur(out, 14); ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = 0.85; ctx.drawImage(soft, 0, 0); ctx.globalAlpha = 1;
  const J = {}; for (const [n, [x, y]] of Object.entries(body.joints)) J[n] = [W - x, y];
  // back of the head: hair texture (or hair colour) over the whole head
  const r = Math.hypot(J.nose[0] - J.neck[0], J.nose[1] - J.neck[1]) * 1.15, hx = J.nose[0], hy = J.nose[1] - r * 0.15;
  ctx.save(); ctx.beginPath(); ctx.ellipse(hx, hy, r * 0.95, r * 1.12, 0, 0, 7); ctx.clip();
  if (hair?.png) { const hc = await blobToCanvas(hair.png, 2048); const sc = (r * 2.4) / hc.width; ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = hairColour(hc); ctx.fillRect(hx - r * 2, hy - r * 2, r * 4, r * 4); ctx.globalAlpha = 0.6; ctx.drawImage(hc, hx - hc.width * sc / 2, hy - r * 1.25, hc.width * sc, hc.height * sc); }
  else { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = '#3a2a20'; ctx.fillRect(hx - r * 2, hy - r * 2, r * 4, r * 4); }
  ctx.restore();
  const { alpha, mean } = alphaOf(out);
  return { canvas: out, body: { ok: true, png: await toBlob(out), w: W, h: H, alpha, joints: J, mean, missing: [], estimated: true, source: 'rear-estimate', issues: ['Estimated: the back of your head and clothes are a guess (mirror + hair colour).'] } };
}
function hairColour(hc) { const s = mk(8, 8), c = s.getContext('2d', { willReadFrequently: true }); c.drawImage(hc, 0, 0, 8, 8); const d = c.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < 64; i++) if (d[i * 4 + 3] > 120) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; } return n ? `rgb(${r / n | 0},${g / n | 0},${b / n | 0})` : '#3a2a20'; }

/** Generate every view from one photo. ms = installed models. onStep(key, status). Returns list of candidates. */
export async function generateAllViews(photo, ms, onStep) {
  const out = [], add = v => { out.push(v); onStep?.(v.key, v.ok ? 'done' : 'skipped', v); };
  const step = k => onStep?.(k, 'working');
  step('front'); const front = await analyzeReference(photo);
  if (!front.ok) throw new Error('No face found in that photo. Use a photo where your face is clearly visible.');
  add({ key: 'front', label: 'Front face', kind: 'captured', ok: true, canvas: await blobToCanvas(front.texBlob, 900), apply: pr => { pr.refs.front = { blob: photo, name: photo.name, at: Date.now(), analysis: front }; } });
  for (const [key, label, th] of [['left', 'Left profile (¾)', -0.5], ['right', 'Right profile (¾)', 0.5]]) {
    step(key);
    try { const v = await synthesizeFaceView(front, th); add({ key, label, kind: 'synthesized', ok: true, canvas: v.canvas, apply: async pr => { pr.refs[key] = { blob: v.analysis.texBlob, name: `${key}-generated.jpg`, at: Date.now(), generated: true, analysis: v.analysis }; } }); }
    catch (e) { add({ key, label, kind: 'synthesized', ok: false, why: e.message }); }
  }
  let hair = null; step('hair');
  if (ms.multiclass) { try { hair = await extractHair(photo, front); const c = await blobToCanvas(hair.png, 900); add({ key: 'hair', label: 'Hairstyle', kind: 'captured', ok: true, canvas: c, apply: pr => { pr.hair = hair; pr.refs.hair = { blob: hair.png, name: 'hair.png', at: Date.now(), generated: true }; } }); } catch (e) { add({ key: 'hair', label: 'Hairstyle', kind: 'captured', ok: false, why: e.message }); } }
  else add({ key: 'hair', label: 'Hairstyle', kind: 'captured', ok: false, why: 'Install the Selfie Multiclass model' });
  let body = null; step('body');
  if (ms.selfie && (ms.pose_lite || ms.pose_full)) {
    try { body = await analyzeBody(photo, blobToCanvas); if (body.missing.some(k => /An|Kn/.test(k))) throw new Error('Your legs are not fully in the photo'); }
    catch (e) { body = null; add({ key: 'body', label: 'Full body', kind: 'captured', ok: false, why: e.message }); }
  } else add({ key: 'body', label: 'Full body', kind: 'captured', ok: false, why: 'Install the Pose and Selfie Segmenter models' });
  if (body) {
    add({ key: 'body', label: 'Full body', kind: 'captured', ok: true, canvas: await blobToCanvas(body.png, 900), apply: pr => { pr.refs.body = { blob: photo, name: photo.name, at: Date.now() }; pr.bodyPhoto = body; if (!pr.body?.source?.startsWith('tpose')) pr.body = body; } });
    step('tpose');
    try { const t = await makeTPoseModel(body, { toCanvas: blobToCanvas, Renderer: FaceRenderer }); add({ key: 'tpose', label: 'T-pose', kind: 'synthesized', ok: true, canvas: await blobToCanvas(t.png, 900), apply: pr => { pr.body = t; pr.refs.tpose = { blob: t.png, name: 'tpose-generated.png', at: Date.now(), generated: true }; } }); }
    catch (e) { add({ key: 'tpose', label: 'T-pose', kind: 'synthesized', ok: false, why: e.message }); }
    step('side');
    try { const s = await estimateSideBody(body); add({ key: 'side', label: 'Side body', kind: 'estimated', ok: true, canvas: s.canvas, apply: pr => { pr.bodySide = s.body; pr.refs.side = { blob: s.body.png, name: 'side-estimate.png', at: Date.now(), generated: true }; } }); }
    catch (e) { add({ key: 'side', label: 'Side body', kind: 'estimated', ok: false, why: e.message }); }
    step('rear');
    try { const r = await estimateRearBody(body, hair); add({ key: 'rear', label: 'Rear body', kind: 'estimated', ok: true, canvas: r.canvas, apply: pr => { pr.bodyRear = r.body; pr.refs.rear = { blob: r.body.png, name: 'rear-estimate.png', at: Date.now(), generated: true }; } }); }
    catch (e) { add({ key: 'rear', label: 'Rear body', kind: 'estimated', ok: false, why: e.message }); }
  } else for (const [k, l, kind] of [['tpose', 'T-pose', 'synthesized'], ['side', 'Side body', 'estimated'], ['rear', 'Rear body', 'estimated']]) add({ key: k, label: l, kind, ok: false, why: 'Needs a full-body photo (head to feet)' });
  return out;
}
export { N_FACE };
