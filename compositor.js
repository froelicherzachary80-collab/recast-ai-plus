// RECAST AI+ — per-frame recast compositor (RECAST Lite / MotionLock / SceneBlend).
import { FaceRenderer } from './facerender.js';
import { STABLE, POSE, faceYaw, faceWidth } from './facemesh.js';
import { fitSimilarity, applySim, smoothstep, sampleRGB, clamp, interpKeys, triAffine, bilinear, invBilinear, triSign, hexToRgb, rgbToHsl, hslToRgb } from './geometry.js';
import { buildMotion } from './smoothing.js';
import { blobToCanvas, buildProfileMesh, tinyCrop, faceBox, recolorCanvas } from './profile.js';
import { getTask, segment } from './models.js';
import { buildRig, deformRig, poseJoints } from './puppet.js';

export const KEY_PROPS = ['x', 'y', 'scale', 'rot', 'opacity'];
export const DEFAULT_ENTRY = () => ({
  id: 'c' + Math.random().toString(36).slice(2, 8), trackId: null, profileId: null, enabled: true,
  face: { on: true, feather: 0.07, color: 1, light: 0.6, motion: 1, keepMouth: true, keepEyes: false, grain: 0.015, sat: 1, soft: 0.6 },
  hair: { on: false },
  outfit: { on: false },
  top: { garmentId: null, width: 1.15, collar: 0.12, opacity: 1, clip: true },
  bottom: { garmentId: null, width: 1.25, opacity: 1, clip: true },
  recolor: { on: false, color: '#5b3fd6', strength: 0.75 },
  body: { on: false, light: 0.6, opacity: 1 },
  transform: { x: 0, y: 0, scale: 1, rot: 0, opacity: 1 },
  keys: [], strokes: [], skip: [],
});
/** Outfit checkbox: off = keep the original actor's clothes untouched. Older entries without the flag keep their behavior. */
export const outfitOn = e => (e.outfit ? !!e.outfit.on : true);
const inRanges = (ranges, k) => (ranges || []).some(([a, b]) => k >= a && k <= b);

/** Load everything a project's cast needs into memory. */
export async function prepareRuntime(project, { profiles, wardrobe, analysis, motionParams, plate = null, background = null }) {
  const plan = project.plan, W = plan.width, H = plan.height;
  const rt = { W, H, photo: !!plan.photo, entries: [], face: null, needsPerson: false, needsMulti: false, state: new Map(), warnings: [] };
  try { rt.face = new FaceRenderer(W, H); } catch (e) { rt.warnings.push(e.message); }
  for (const e of project.cast) {
    if (!e.trackId || !(project.selected || []).includes(e.trackId)) continue;
    const prof = profiles.find(p => p.id === e.profileId);
    const r = { e, prof, views: [], mesh: null, hair: null, top: null, bottom: null };
    r.motion = buildMotion(analysis.frames, e.trackId, plan.fps, motionParams);
    if (prof) {
      if (!prof.self && !prof.consent) { rt.warnings.push(`“${prof.name}” has no consent confirmation. Their likeness is not used.`); }
      else {
        r.mesh = buildProfileMesh(prof);
        for (const k of ['front', 'left', 'right']) {
          const a = prof.refs?.[k]?.analysis; if (!a?.ok || !r.mesh) continue;
          const img = await blobToCanvas(a.texBlob, 4096);
          const uv = new Float32Array(a.xy.length); for (let i = 0; i < a.xy.length; i += 2) { uv[i] = a.xy[i] / a.w; uv[i + 1] = a.xy[i + 1] / a.h; }
          r.views.push({ key: k, a, img, uv, edge: r.mesh.edges[k], tex: rt.face ? rt.face.texture(prof.id + ':' + k, img) : null });
        }
        if (e.hair.on && prof.hair?.png) {
          const base = await blobToCanvas(prof.hair.png, 4096);
          const s = prof.settings || {};
          r.hair = { canvas: recolorCanvas(base, s.hairColor || '#000000', s.hairTint || 0, s.hairBright || 0), xy: prof.hair.xy, scaleIn: base.width / prof.hair.w, s };
        }
      }
    }
    for (const part of ['top', 'bottom']) {
      if (!outfitOn(e)) continue;
      const g = wardrobe.find(w => w.id === e[part].garmentId);
      if (!g) continue;
      const img = await blobToCanvas(g.blob, 2048);
      r[part] = { g, img, grid: garmentGrid(g, img.width, img.height, part) };
      if (e[part].clip) rt.needsPerson = true;
    }
    if (e.recolor.on && outfitOn(e) && !e.body?.on) rt.needsMulti = true;
    if (e.body?.on && prof?.body?.ok && (prof.self || prof.consent) && rt.face) {
      const cut = await blobToCanvas(prof.body.png, 4096);
      r.rig = buildRig(prof.body.alpha, prof.body.w, prof.body.h, prof.body.joints);
      r.rigTex = rt.face.texture(prof.id + ':body:' + (prof.updatedAt || 0), cut);
      r.rigMean = prof.body.mean;
      if (!plate && (project.stage?.mode || 'scene') === 'scene') rt.warnings.push('Full-body mode without a clean plate: the original actor can show around your body. Build or upload a clean plate in Editor → Body.');
      rt.needsPerson = true;
    } else if (e.body?.on) rt.warnings.push(`Full body is on for Actor ${e.trackId}, but ${prof ? prof.name + ' has no analyzed full-body photo' : 'no character is cast'}.`);
    rt.entries.push(r);
  }
  if (rt.needsPerson) try { rt.personTask = await getTask('selfie', 'VIDEO'); } catch (err) { rt.needsPerson = false; rt.warnings.push('Garment clipping off: ' + err.message); }
  if (rt.needsMulti) try { rt.multiTask = await getTask('multiclass', 'VIDEO'); } catch (err) { rt.needsMulti = false; rt.warnings.push('Clothing recolor off: ' + err.message); }
  rt.work = mk(W, H); rt.tmp = mk(W, H); rt.maskC = mk(W, H);
  rt.stage = project.stage || { mode: 'scene' };
  if (plate) { rt.plate = mk(W, H); rt.plate.getContext('2d').drawImage(await blobToCanvas(plate, 4096), 0, 0, W, H); }
  if (rt.stage.mode === 'background') {
    rt.bg = mk(W, H); const bctx = rt.bg.getContext('2d');
    bctx.fillStyle = rt.stage.color || '#101014'; bctx.fillRect(0, 0, W, H);
    if (background) { const img = await blobToCanvas(background, 4096), s = Math.max(W / img.width, H / img.height); bctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s); }
    else if (rt.plate) bctx.drawImage(rt.plate, 0, 0);
  }
  return rt;
}
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** Garment grid: sample points over the whole image expressed in anchor (u,v) space. */
export function garmentGrid(g, iw, ih, part, N = 8) {
  const A = g.anchors.map(([x, y]) => [x * iw, y * ih]);
  const pts = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = (i / N) * iw, y = (j / N) * ih;
    pts.push({ x, y, uv: invBilinear(A, x, y) });
  }
  return { N, pts };
}

function poseXY(P, i, W, H) { return [P[i * 4] * W, P[i * 4 + 1] * H, P[i * 4 + 3]]; }

function garmentTarget(P, part, cfg, W, H) {
  const sh = [poseXY(P, POSE.lShoulder, W, H), poseXY(P, POSE.rShoulder, W, H)];
  const hip = [poseXY(P, POSE.lHip, W, H), poseXY(P, POSE.rHip, W, H)];
  const L = sh[0][0] <= sh[1][0] ? 0 : 1, R = 1 - L; // screen-left side index
  const widen = (a, b, w) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return [[m[0] + (a[0] - m[0]) * w, m[1] + (a[1] - m[1]) * w], [m[0] + (b[0] - m[0]) * w, m[1] + (b[1] - m[1]) * w]]; };
  if (part === 'top') {
    if (Math.min(sh[0][2], sh[1][2], hip[0][2], hip[1][2]) < 0.25) return null;
    let [tl, tr] = widen(sh[L], sh[R], cfg.width), [bl, br] = widen(hip[L], hip[R], cfg.width * 0.95);
    const up = [(tl[0] + tr[0] - bl[0] - br[0]) / 2, (tl[1] + tr[1] - bl[1] - br[1]) / 2];
    tl = [tl[0] + up[0] * cfg.collar, tl[1] + up[1] * cfg.collar]; tr = [tr[0] + up[0] * cfg.collar, tr[1] + up[1] * cfg.collar];
    const q = [tl, tr, br, bl];
    return (u, v) => bilinear(q, u, v);
  }
  const kn = [poseXY(P, POSE.lKnee, W, H), poseXY(P, POSE.rKnee, W, H)], an = [poseXY(P, POSE.lAnkle, W, H), poseXY(P, POSE.rAnkle, W, H)];
  if (Math.min(hip[0][2], hip[1][2], kn[0][2], kn[1][2]) < 0.25) return null;
  const Lh = hip[0][0] <= hip[1][0] ? 0 : 1, Rh = 1 - Lh;
  const [hl, hr] = widen(hip[Lh], hip[Rh], cfg.width), [kl, kr] = widen(kn[Lh], kn[Rh], cfg.width), [al, ar] = (Math.min(an[0][2], an[1][2]) >= 0.2 ? widen(an[Lh], an[Rh], cfg.width) : [[2 * kl[0] - hl[0], 2 * kl[1] - hl[1]], [2 * kr[0] - hr[0], 2 * kr[1] - hr[1]]]);
  const q1 = [hl, hr, kr, kl], q2 = [kl, kr, ar, al];
  return (u, v) => (v <= 0.5 ? bilinear(q1, u, v * 2) : bilinear(q2, u, (v - 0.5) * 2));
}

function drawGarment(ctx, img, grid, map) {
  const { N, pts } = grid, T = pts.map(p => map(p.uv[0], p.uv[1]));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + N + 2, d = a + N + 1;
    for (const [p, q, r] of [[a, b, c], [a, c, d]]) {
      const s0 = [pts[p].x, pts[p].y], s1 = [pts[q].x, pts[q].y], s2 = [pts[r].x, pts[r].y];
      const M = triAffine(s0, s1, s2, T[p], T[q], T[r]); if (!M) continue;
      // expand clip triangle ~0.6px to hide seams
      const cx = (T[p][0] + T[q][0] + T[r][0]) / 3, cy = (T[p][1] + T[q][1] + T[r][1]) / 3;
      const ex = pt => { const dx = pt[0] - cx, dy = pt[1] - cy, l = Math.hypot(dx, dy) || 1; return [pt[0] + dx / l * 0.6, pt[1] + dy / l * 0.6]; };
      ctx.save(); ctx.beginPath();
      const e0 = ex(T[p]), e1 = ex(T[q]), e2 = ex(T[r]);
      ctx.moveTo(e0[0], e0[1]); ctx.lineTo(e1[0], e1[1]); ctx.lineTo(e2[0], e2[1]); ctx.closePath(); ctx.clip();
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]); ctx.drawImage(img, 0, 0); ctx.restore();
    }
  }
}

function maskCanvasFrom(seg, W, H, into, bbox) {
  const ctx = into.getContext('2d'); ctx.clearRect(0, 0, W, H);
  if (!seg?.masks?.[0]) return into;
  const { width: mw, height: mh } = seg, m = seg.masks[0];
  const small = mk(mw, mh), sctx = small.getContext('2d'), img = sctx.createImageData(mw, mh);
  for (let i = 0; i < m.length; i++) { img.data[i * 4 + 3] = clamp((m[i] - 0.3) / 0.4, 0, 1) * 255; }
  sctx.putImageData(img, 0, 0);
  ctx.save(); if (bbox) { ctx.beginPath(); ctx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]); ctx.clip(); }
  ctx.imageSmoothingEnabled = true; ctx.drawImage(small, 0, 0, W, H); ctx.restore();
  return into;
}

const expandBox = (b, W, H, f = 0.15) => { const w = (b[2] - b[0]) * W, h = (b[3] - b[1]) * H; return [b[0] * W - w * f, b[1] * H - h * f, b[2] * W + w * f, b[3] * H + h * f]; };

/** Compute face mesh draw for one entry at frame k. Returns {draw, P (target px flat), box} or null. */
export function faceDraw(rt, r, k, src) {
  const e = r.e, L = r.motion.face[k];
  if (!L || !r.views.length || !r.mesh) return null;
  const W = rt.W, H = rt.H, n = L.length / 3;
  const st = rt.state.get(e.id) || {}; rt.state.set(e.id, st);
  const yaw = faceYaw(L);
  // choose reference view by yaw (hysteresis avoids flicker)
  let best = r.views[0], bd = Infinity;
  for (const v of r.views) { const d = Math.abs(v.a.yaw - yaw); if (d < bd) { bd = d; best = v; } }
  const cur = r.views.find(v => v.key === st.view);
  if (cur && Math.abs(cur.a.yaw - yaw) - bd < 0.12) best = cur;
  st.view = best.key;
  const ref = best.a.xy;
  const tgt = new Float32Array(n * 2); for (let i = 0; i < n; i++) { tgt[i * 2] = L[i * 3] * W; tgt[i * 2 + 1] = L[i * 3 + 1] * H; }
  const T = fitSimilarity(STABLE.map(i => [ref[i * 2], ref[i * 2 + 1]]), STABLE.map(i => [tgt[i * 2], tgt[i * 2 + 1]]));
  const tr = interpKeys(e.keys, k, e.transform, KEY_PROPS), m = e.face.motion;
  let cx = 0, cy = 0; for (const i of STABLE) { cx += tgt[i * 2]; cy += tgt[i * 2 + 1]; } cx /= STABLE.length; cy /= STABLE.length;
  const fw = faceWidth(tgt, 2), cs = Math.cos(tr.rot * Math.PI / 180), sn = Math.sin(tr.rot * Math.PI / 180);
  const P = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const [rx, ry] = applySim(T, ref[i * 2], ref[i * 2 + 1]);
    let x = rx + m * (tgt[i * 2] - rx), y = ry + m * (tgt[i * 2 + 1] - ry);
    x = (x - cx) * tr.scale; y = (y - cy) * tr.scale;
    P[i * 2] = cx + x * cs - y * sn + tr.x * fw; P[i * 2 + 1] = cy + x * sn + y * cs + tr.y * fw;
  }
  const idx = [];
  r.mesh.tris.forEach(([a, b, c], t) => {
    const f = r.mesh.flags[t];
    if (e.face.keepMouth && f & 1) return; if (e.face.keepEyes && f & 2) return;
    if (best.key !== 'front' && triSign(ref, a, b, c) <= 0) return;
    if (triSign(P, a, b, c) <= 0) return;
    idx.push(a, b, c);
  });
  if (idx.length < 30) return null;
  const alpha = new Float32Array(n); for (let i = 0; i < n; i++) alpha[i] = smoothstep(0, e.face.feather, best.edge[i]);
  // SceneBlend: low-frequency color + lighting transfer, per vertex
  const box = faceBox(P, 0.15), tiny = tinyCrop(src, box, 16), rt2 = best.a.tiny;
  const gl = new Float32Array(n * 3); let gsum = [0, 0, 0], gn = 0;
  const bw = box[2] - box[0], bh = box[3] - box[1], rbw = rt2.box[2] - rt2.box[0], rbh = rt2.box[3] - rt2.box[1];
  for (let i = 0; i < n; i++) {
    const s = sampleRGB(tiny.data, tiny.size, tiny.size, (P[i * 2] - box[0]) / bw, (P[i * 2 + 1] - box[1]) / bh);
    const q = sampleRGB(rt2.data, rt2.size, rt2.size, (ref[i * 2] - rt2.box[0]) / rbw, (ref[i * 2 + 1] - rt2.box[1]) / rbh);
    for (let c = 0; c < 3; c++) { const g = clamp((s[c] + 6) / (q[c] + 6), 0.35, 2.8); gl[i * 3 + c] = g; if (alpha[i] > 0.5) gsum[c] += g; }
    if (alpha[i] > 0.5) gn++;
  }
  gsum = gsum.map(v => (gn ? v / gn : 1));
  const prev = st.gain && st.gain.length === n * 3 ? st.gain : null, gain = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    const local = gl[i * 3 + c], glob = gsum[c];
    let g = 1 + (glob - 1) * e.face.color + (local - glob) * e.face.light;
    g = clamp(g, 0.3, 3);
    gain[i * 3 + c] = prev ? prev[i * 3 + c] * 0.55 + g * 0.45 : g;
  }
  st.gain = gain;
  return {
    P, box, tgt,
    draw: { tex: best.tex, pos: P, uv: best.uv, alpha, gain, idx: new Uint16Array(idx), opacity: tr.opacity, grain: e.face.grain, sat: e.face.sat, bias: lodBias(best, P, e.face.soft ?? 0.6) },
    view: best.key, yaw,
  };
}

/** Detail match: how much the reference is minified on screen → mip LOD bias so a sharp phone photo
 *  does not look pasted onto softer footage. soft 0 = full detail, 1 = strongly matched to scene softness. */
function lodBias(view, P, soft) {
  const a = view.a, rw = Math.hypot(a.xy[454 * 2] - a.xy[234 * 2], a.xy[454 * 2 + 1] - a.xy[234 * 2 + 1]);
  const tw = Math.hypot(P[454 * 2] - P[234 * 2], P[454 * 2 + 1] - P[234 * 2 + 1]) || 1;
  return soft * (0.4 + Math.max(0, Math.log2(rw / tw)) * 0.35);
}

function drawHair(ctx, r, fd, rt) {
  if (!r.hair || !fd) return;
  const { xy, s, canvas, scaleIn } = r.hair;
  const T = fitSimilarity(STABLE.map(i => [xy[i * 2] * scaleIn, xy[i * 2 + 1] * scaleIn]), STABLE.map(i => [fd.P[i * 2], fd.P[i * 2 + 1]]));
  const fade = 1 - smoothstep(0.35, 0.7, Math.abs(fd.yaw));
  if (fade <= 0.01) return;
  const fx = xy[10 * 2] * scaleIn, fy = xy[10 * 2 + 1] * scaleIn, fwRef = Math.hypot(xy[454 * 2] - xy[234 * 2], xy[454 * 2 + 1] - xy[234 * 2 + 1]) * scaleIn;
  ctx.save();
  ctx.globalAlpha = (s.hairOpacity ?? 0.95) * fade * (fd.draw.opacity ?? 1);
  ctx.setTransform(T.a, T.b, -T.b, T.a, T.tx, T.ty);
  ctx.translate(fx, fy + (s.hairFringe || 0) * fwRef); ctx.scale(s.hairVolume || 1, s.hairVolume || 1); ctx.translate(-fx, -fy);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

function recolorClothes(ctx, seg, box, cfg, W, H) {
  if (!seg?.masks?.[0]) return;
  const x0 = Math.max(0, box[0] | 0), y0 = Math.max(0, box[1] | 0), x1 = Math.min(W, Math.ceil(box[2])), y1 = Math.min(H, Math.ceil(box[3]));
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0), d = img.data, m = seg.masks[0], mw = seg.width, mh = seg.height;
  const [th, ts] = rgbToHsl(...hexToRgb(cfg.color));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const c = m[Math.min(mh - 1, (y * mh / H) | 0) * mw + Math.min(mw - 1, (x * mw / W) | 0)];
    if (c < 0.3) continue;
    const a = clamp((c - 0.3) / 0.4, 0, 1) * cfg.strength, i = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
    const l = rgbToHsl(d[i], d[i + 1], d[i + 2])[2];
    const [r, g, b] = hslToRgb(th, ts, clamp(l * 0.9 + 0.05, 0, 1));
    d[i] += (r - d[i]) * a; d[i + 1] += (g - d[i + 1]) * a; d[i + 2] += (b - d[i + 2]) * a;
  }
  ctx.putImageData(img, x0, y0);
}

/** Compose one frame into rt.work. opts: {disclosure, overlays:{track, mesh, mask}, onlyEntry, restoreAll} */
export function composeFrame(rt, src, k, opts = {}) {
  const W = rt.W, H = rt.H, out = rt.work, ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(src, 0, 0, W, H);
  const active = opts.restoreAll ? [] : rt.entries.filter(r => r.e.enabled && !inRanges(r.e.skip, k) && (!opts.onlyEntry || r.e.id === opts.onlyEntry));
  const stats = { faces: 0, garments: 0, hair: 0, recolor: 0, bodies: 0 };
  let personSeg = null, multiSeg = null;
  const bodyRs = active.filter(r => r.rig && r.e.body?.on);
  const needP = (active.some(r => (r.top && r.e.top.clip) || (r.bottom && r.e.bottom.clip)) || (bodyRs.length && rt.plate && rt.stage.mode !== 'background')) && rt.personTask;
  const needM = active.some(r => r.e.recolor.on && outfitOn(r.e)) && rt.multiTask;
  if (needP) personSeg = segment(rt.personTask, src, 'VIDEO', [-1]);
  if (needM) multiSeg = segment(rt.multiTask, src, 'VIDEO', [4]);
  // 0) stage: new background, or remove the original actor with the clean plate
  if (!opts.restoreAll && rt.stage.mode === 'background' && rt.bg && bodyRs.length) ctx.drawImage(rt.bg, 0, 0);
  else if (rt.plate && personSeg) for (const r of bodyRs) {
    const bb = r.motion.bbox[k]; if (!bb) continue;
    maskCanvasFrom(personSeg, W, H, rt.maskC, expandBox(bb, W, H, 0.2));
    const mctx = rt.maskC.getContext('2d'); // dilate: re-stamp the mask at small offsets
    const d = Math.max(2, Math.round(Math.min(W, H) * 0.012)); mctx.globalCompositeOperation = 'source-over';
    const copy = mk(W, H); copy.getContext('2d').drawImage(rt.maskC, 0, 0);
    for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) mctx.drawImage(copy, dx, dy);
    const tctx = rt.tmp.getContext('2d'); tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, W, H); tctx.drawImage(rt.plate, 0, 0);
    tctx.globalCompositeOperation = 'destination-in'; tctx.drawImage(rt.maskC, 0, 0); tctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(rt.tmp, 0, 0);
  }
  // 0b) full body (MotionLock Animate): your cut-out body skinned to the actor's pose
  if (rt.face && bodyRs.length) {
    const draws = [];
    for (const r of bodyRs) {
      const P = r.motion.pose[k]; if (!P) continue;
      const pos = deformRig(r.rig, poseJoints(P, W, H));
      const bb = r.motion.bbox[k], tiny = bb ? tinyCrop(src, expandBox(bb, W, H, 0), 4) : null;
      let g = 1;
      if (tiny) { let l = 0; for (let i = 0; i < tiny.data.length; i += 4) l += 0.299 * tiny.data[i] + 0.587 * tiny.data[i + 1] + 0.114 * tiny.data[i + 2]; l /= tiny.data.length / 4; const lr = 0.299 * r.rigMean[0] + 0.587 * r.rigMean[1] + 0.114 * r.rigMean[2]; g = clamp(1 + ((l + 6) / (lr + 6) - 1) * r.e.body.light, 0.55, 1.6); }
      draws.push({ tex: r.rigTex, pos, uv: r.rig.uv, alpha: new Float32Array(r.rig.n).fill(1), gain: new Float32Array(r.rig.n * 3).fill(g), idx: r.rig.idx, opacity: r.e.body.opacity ?? 1, grain: r.e.face.grain, sat: 1, bias: 0.3 });
    }
    if (draws.length) { rt.face.render(out, draws); ctx.drawImage(rt.face.canvas, 0, 0); stats.bodies = draws.length; }
  }
  // 1) body layers
  for (const r of active) {
    const P = r.motion.pose[k], bb = r.motion.bbox[k];
    if (!P || !bb) continue;
    const box = expandBox(bb, W, H, 0.12);
    if (r.e.recolor.on && outfitOn(r.e) && !r.rig && multiSeg) { recolorClothes(ctx, multiSeg, box, r.e.recolor, W, H); stats.recolor++; }
    for (const part of ['bottom', 'top']) {
      const G = r[part]; if (!G) continue;
      const map = garmentTarget(P, part, r.e[part], W, H); if (!map) continue;
      const tctx = rt.tmp.getContext('2d'); tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, W, H);
      drawGarment(tctx, G.img, G.grid, map);
      if (r.e[part].clip && personSeg) {
        maskCanvasFrom(personSeg, W, H, rt.maskC, box);
        tctx.globalCompositeOperation = 'destination-in'; tctx.drawImage(rt.maskC, 0, 0); tctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = r.e[part].opacity; ctx.drawImage(rt.tmp, 0, 0); ctx.globalAlpha = 1; stats.garments++;
    }
  }
  // 2) faces (WebGL)
  const fds = new Map();
  if (rt.face) {
    const draws = [];
    for (const r of active) { if (!r.e.face.on) continue; const fd = faceDraw(rt, r, k, src); if (fd) { fds.set(r.e.id, fd); draws.push(fd.draw); } }
    if (draws.length) { rt.face.render(out, draws); ctx.drawImage(rt.face.canvas, 0, 0); stats.faces = draws.length; }
  }
  // 3) hair
  for (const r of active) if (r.hair) { const fd = fds.get(r.e.id); if (fd) { drawHair(ctx, r, fd, rt); stats.hair++; } }
  // 4) restore brush strokes (show original pixels)
  for (const r of rt.entries) {
    const strokes = (r.e.strokes || []).filter(s => k >= s.from && k <= s.to);
    if (!strokes.length) continue;
    const mctx = rt.maskC.getContext('2d'); mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, W, H);
    mctx.strokeStyle = '#fff'; mctx.lineCap = mctx.lineJoin = 'round';
    for (const s of strokes) { mctx.lineWidth = s.size * W; mctx.beginPath(); s.pts.forEach(([x, y], i) => (i ? mctx.lineTo(x * W, y * H) : mctx.moveTo(x * W, y * H))); if (s.pts.length === 1) mctx.lineTo(s.pts[0][0] * W + 0.1, s.pts[0][1] * H); mctx.stroke(); }
    const tctx = rt.tmp.getContext('2d'); tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, W, H); tctx.drawImage(src, 0, 0, W, H);
    tctx.globalCompositeOperation = 'destination-in'; tctx.drawImage(rt.maskC, 0, 0); tctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(rt.tmp, 0, 0);
  }
  // 5) overlays (editor only)
  const ov = opts.overlays || {};
  if (ov.mask && rt.face) {
    const draws = [...fds.values()].map(f => f.draw);
    rt.face.render(out, draws, { maskOnly: true }); ctx.drawImage(rt.face.canvas, 0, 0);
    if (personSeg) { maskCanvasFrom(personSeg, W, H, rt.maskC); ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'source-atop'; ctx.drawImage(rt.maskC, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
  }
  if (ov.mesh) for (const fd of fds.values()) {
    ctx.strokeStyle = 'rgba(190,160,255,.55)'; ctx.lineWidth = 0.6; ctx.beginPath();
    const ix = fd.draw.idx, P = fd.P;
    for (let i = 0; i < ix.length; i += 3) { ctx.moveTo(P[ix[i] * 2], P[ix[i] * 2 + 1]); ctx.lineTo(P[ix[i + 1] * 2], P[ix[i + 1] * 2 + 1]); ctx.lineTo(P[ix[i + 2] * 2], P[ix[i + 2] * 2 + 1]); ctx.closePath(); }
    ctx.stroke();
  }
  if (opts.disclosure) {
    const fs = Math.max(11, Math.round(H * 0.026)), txt = 'AI-edited · RECAST AI+';
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`; const tw = ctx.measureText(txt).width;
    const x = W - tw - fs * 1.4, y = H - fs * 2.1;
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - fs * 0.5, y - fs * 0.2, tw + fs, fs * 1.5);
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.textBaseline = 'top'; ctx.fillText(txt, x, y + fs * 0.05);
  }
  return { canvas: out, stats, faces: fds };
}

/** Draw tracking overlay for all detections at frame k onto ctx (pixel space W×H). */
export function drawTracking(ctx, frame, W, H, { selected = [], colors, showHands = true } = {}) {
  if (!frame) return;
  ctx.save(); ctx.lineWidth = Math.max(1.5, W / 400); ctx.font = `600 ${Math.max(11, W / 45)}px -apple-system, system-ui, sans-serif`;
  for (const p of frame.people) {
    const col = colors(p.id), sel = selected.includes(p.id);
    const [x0, y0, x1, y1] = p.bbox;
    ctx.strokeStyle = col; ctx.globalAlpha = sel ? 1 : 0.7; ctx.setLineDash(sel ? [] : [6, 5]);
    ctx.strokeRect(x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H); ctx.setLineDash([]);
    if (p.pose) {
      ctx.beginPath();
      for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]]) {
        if (p.pose[a * 4 + 3] < 0.35 || p.pose[b * 4 + 3] < 0.35) continue;
        ctx.moveTo(p.pose[a * 4] * W, p.pose[a * 4 + 1] * H); ctx.lineTo(p.pose[b * 4] * W, p.pose[b * 4 + 1] * H);
      }
      ctx.stroke();
    }
    if (p.face) { ctx.fillStyle = col; for (let i = 0; i < p.face.length; i += 3 * 6) ctx.fillRect(p.face[i] * W - 0.75, p.face[i + 1] * H - 0.75, 1.5, 1.5); }
    const label = `Actor ${p.id}`; const tw = ctx.measureText(label).width;
    ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.fillRect(x0 * W, y0 * H - 20, tw + 12, 20);
    ctx.fillStyle = '#0b0a10'; ctx.textBaseline = 'middle'; ctx.fillText(label, x0 * W + 6, y0 * H - 10);
  }
  if (showHands && frame.hands) {
    ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.globalAlpha = 0.9; ctx.beginPath();
    for (const h of frame.hands) for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]]) {
      ctx.moveTo(h[a * 3] * W, h[a * 3 + 1] * H); ctx.lineTo(h[b * 3] * W, h[b * 3 + 1] * H);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function disposeRuntime(rt) { try { rt?.face?.dispose(); } catch {} }
