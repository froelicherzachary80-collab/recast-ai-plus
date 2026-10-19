// RECAST AI+ v0.3 — editable pose rig (pure math, unit-tested).
// A pose is stored as angles, not points, so bone lengths always stay the same as in your photo:
//   { x, y, s, a: { torso, head, lUpper, lFore, rUpper, rFore, lThigh, lShin, rThigh, rShin } }
// x,y = pelvis on stage (px), s = scale (stage px per photo px), angles = absolute radians (y points down).
// a.pelvis is the direction of the hip line (right hip → left hip), so the torso can lean while the hips stay put.

export const LIMBS = { lUpper: ['lSh', 'lEl'], lFore: ['lEl', 'lWr'], rUpper: ['rSh', 'rEl'], rFore: ['rEl', 'rWr'], lThigh: ['lHip', 'lKn'], lShin: ['lKn', 'lAn'], rThigh: ['rHip', 'rKn'], rShin: ['rKn', 'rAn'] };
export const CHAINS = { lArm: ['lUpper', 'lFore'], rArm: ['rUpper', 'rFore'], lLeg: ['lThigh', 'lShin'], rLeg: ['rThigh', 'rShin'] };
export const HANDLES = ['pelvis', 'neck', 'nose', 'lEl', 'lWr', 'rEl', 'rWr', 'lKn', 'lAn', 'rKn', 'rAn'];
const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const rot = (v, t) => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t)];
const add = (a, v) => [a[0] + v[0], a[1] + v[1]];
const polar = (l, t) => [l * Math.cos(t), l * Math.sin(t)];
export const wrapAngle = t => { t = (t + Math.PI) % (2 * Math.PI); if (t < 0) t += 2 * Math.PI; return t - Math.PI; };

/** Rest information from the rig's photo joints (cutout px). */
export function restInfo(R) {
  const L = {}; for (const [k, [a, b]] of Object.entries(LIMBS)) L[k] = len(R[a], R[b]);
  return {
    R, L, torso: len(R.pelvis, R.neck), head: len(R.neck, R.nose), torsoAngle: ang(R.pelvis, R.neck), pelvisAngle: ang(R.rHip, R.lHip),
    sh: { l: [R.lSh[0] - R.neck[0], R.lSh[1] - R.neck[1]], r: [R.rSh[0] - R.neck[0], R.rSh[1] - R.neck[1]] },
    hip: { l: [R.lHip[0] - R.pelvis[0], R.lHip[1] - R.pelvis[1]], r: [R.rHip[0] - R.pelvis[0], R.rHip[1] - R.pelvis[1]] },
  };
}

/** Pose → joints (stage px). */
export function fk(P, I) {
  const s = P.s, a = P.a, tr = a.torso - I.torsoAngle;
  const pelvis = [P.x, P.y], neck = add(pelvis, polar(I.torso * s, a.torso));
  const J = { pelvis, neck, nose: add(neck, polar(I.head * s, a.head)) };
  J.lSh = add(neck, rot([I.sh.l[0] * s, I.sh.l[1] * s], tr)); J.rSh = add(neck, rot([I.sh.r[0] * s, I.sh.r[1] * s], tr));
  const hr = (a.pelvis ?? (I.pelvisAngle + tr)) - I.pelvisAngle;
  J.lHip = add(pelvis, rot([I.hip.l[0] * s, I.hip.l[1] * s], hr)); J.rHip = add(pelvis, rot([I.hip.r[0] * s, I.hip.r[1] * s], hr));
  for (const [bone, [from, to]] of Object.entries(LIMBS)) J[to] = add(J[from], polar(I.L[bone] * s, a[bone]));
  return J;
}

/** Joints → pose (lengths taken from the joints' torso; bone angles from the joints). */
export function fromJoints(J, I) {
  const a = { torso: ang(J.pelvis, J.neck), head: ang(J.neck, J.nose), pelvis: ang(J.rHip, J.lHip) };
  for (const [bone, [from, to]] of Object.entries(LIMBS)) a[bone] = ang(J[from], J[to]);
  return { x: J.pelvis[0], y: J.pelvis[1], s: len(J.pelvis, J.neck) / I.torso, a };
}

/** Rest pose placed with pelvis at (x,y) and scale s. */
export function restPose(I, x, y, s) {
  const p = fromJoints(I.R, I); return { ...p, x, y, s, a: { ...p.a } };
}

/** Analytic two-bone IK. Returns the middle joint, keeping the bend on the same side as prevMid. */
export function ik2(A, T, l1, l2, prevMid) {
  let dx = T[0] - A[0], dy = T[1] - A[1], d = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / d, uy = dy / d;
  d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, d));
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), hgt = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const side = prevMid ? Math.sign(ux * (prevMid[1] - A[1]) - uy * (prevMid[0] - A[0])) || 1 : 1;
  const mid = [A[0] + ux * along - uy * hgt * side, A[1] + uy * along + ux * hgt * side];
  return { mid, end: [A[0] + ux * d, A[1] + uy * d] };
}

/** Apply a drag of handle `name` to point `pt`. Returns a new pose. */
export function dragJoint(P, I, name, pt) {
  const N = { ...P, a: { ...P.a } }, J = fk(P, I), a = N.a;
  if (name === 'pelvis') { N.x = pt[0]; N.y = pt[1]; return N; }
  if (name === 'neck') { const d = wrapAngle(ang(J.pelvis, pt) - a.torso); a.torso += d; a.head += d; for (const b of ['lUpper', 'lFore', 'rUpper', 'rFore']) a[b] += d; return N; }
  if (name === 'nose') { a.head = ang(J.neck, pt); return N; }
  for (const [chain, [b1, b2]] of Object.entries(CHAINS)) {
    const root = LIMBS[b1][0], mid = LIMBS[b1][1], end = LIMBS[b2][1];
    if (name === mid) { const d = wrapAngle(ang(J[root], pt) - a[b1]); a[b1] += d; a[b2] += d; return N; }
    if (name === end) {
      const { mid: m, end: e } = ik2(J[root], pt, I.L[b1] * P.s, I.L[b2] * P.s, J[mid]);
      a[b1] = ang(J[root], m); a[b2] = ang(m, e); return N;
    }
  }
  return N;
}

export function lerpPose(A, B, t) {
  const a = {}; for (const k of Object.keys(A.a)) a[k] = A.a[k] + wrapAngle(B.a[k] - A.a[k]) * t;
  return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, s: A.s + (B.s - A.s) * t, a };
}
const ease = t => t * t * (3 - 2 * t);

/** Sample a dance at time t (s). dance: {keys:[{t,pose}], duration, loop, ease:'smooth'|'linear'} */
export function samplePose(dance, t) {
  const ks = dance.keys; if (!ks.length) return null;
  if (dance.loop && dance.duration > 0) t = ((t % dance.duration) + dance.duration) % dance.duration;
  if (t <= ks[0].t) return ks[0].pose;
  if (t >= ks[ks.length - 1].t) {
    if (dance.loop && dance.duration > ks[ks.length - 1].t) { const span = dance.duration - ks[ks.length - 1].t + ks[0].t; return lerpPose(ks[ks.length - 1].pose, ks[0].pose, (dance.ease === 'linear' ? x => x : ease)((t - ks[ks.length - 1].t) / span)); }
    return ks[ks.length - 1].pose;
  }
  let lo = 0, hi = ks.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ks[m].t <= t) lo = m; else hi = m; }
  const u = (t - ks[lo].t) / (ks[hi].t - ks[lo].t || 1);
  return lerpPose(ks[lo].pose, ks[hi].pose, dance.ease === 'linear' ? u : ease(u));
}

/** Mirror a pose left↔right around the vertical line x = cx. */
export function mirrorPose(P, cx) {
  const m = t => wrapAngle(Math.PI - t), a = {};
  const swap = { lUpper: 'rUpper', rUpper: 'lUpper', lFore: 'rFore', rFore: 'lFore', lThigh: 'rThigh', rThigh: 'lThigh', lShin: 'rShin', rShin: 'lShin' };
  for (const k of Object.keys(P.a)) a[swap[k] || k] = k === 'pelvis' ? wrapAngle(-P.a[k]) : m(P.a[k]);
  return { x: 2 * cx - P.x, y: P.y, s: P.s, a };
}

// ───────── dance presets (built from your own rest pose, so proportions are yours) ─────────
const UP = -Math.PI / 2, DOWN = Math.PI / 2;
/** Arm angles are given as screen directions; 'outer' means away from the body on that side. */
function sideSign(I, limb) { return I.R[limb === 'l' ? 'lSh' : 'rSh'][0] >= I.R.neck[0] ? 1 : -1; } // +1 = arm on screen-right
/** Arm/leg direction from "elevation": 0 = hanging straight down, π/2 = straight out to that side, π = straight up. */
const outDir = (sgn, elev) => DOWN - sgn * elev;
export const PRESETS = {
  wave: { name: 'Wave hello', duration: 2, make(I, base) {
    const sr = sideSign(I, 'r'), keys = [];
    for (let i = 0; i <= 8; i++) { const p = lerpPose(base, base, 0); p.a.rUpper = outDir(sr, 2.2); p.a.rFore = UP + sr * 0.45 * Math.sin(i / 8 * Math.PI * 4); p.a.head = base.a.head + 0.06 * Math.sin(i / 8 * Math.PI * 2); keys.push({ t: i / 8 * 2, pose: p }); }
    return keys;
  } },
  cheer: { name: 'Arms-up cheer', duration: 1.6, make(I, base) {
    const sl = sideSign(I, 'l'), sr = sideSign(I, 'r'), keys = [];
    for (let i = 0; i <= 4; i++) { const p = lerpPose(base, base, 0), up = i % 2 === 1; p.a.lUpper = outDir(sl, up ? 2.6 : 2.1); p.a.lFore = outDir(sl, up ? 2.9 : 2.5); p.a.rUpper = outDir(sr, up ? 2.6 : 2.1); p.a.rFore = outDir(sr, up ? 2.9 : 2.5); p.y = base.y - (up ? I.torso * base.s * 0.12 : 0); keys.push({ t: i * 0.4, pose: p }); }
    return keys;
  } },
  groove: { name: 'Side-step groove', duration: 2, make(I, base) {
    const keys = [], sl = sideSign(I, 'l'), sr = sideSign(I, 'r'), w = I.torso * base.s;
    for (let i = 0; i <= 8; i++) {
      const ph = i / 8 * Math.PI * 2, p = lerpPose(base, base, 0), sw = Math.sin(ph), bob = Math.abs(Math.sin(ph));
      p.x = base.x + sw * w * 0.35; p.y = base.y + bob * w * 0.06;
      p.a.torso = base.a.torso + sw * 0.12; p.a.head = base.a.head + sw * 0.15;
      const el = 0.35 + 0.45 * Math.max(0, sw), er = 0.35 + 0.45 * Math.max(0, -sw);
      p.a.lUpper = outDir(sl, el); p.a.lFore = outDir(sl, el + 1.3);
      p.a.rUpper = outDir(sr, er); p.a.rFore = outDir(sr, er + 1.3);
      p.a.lThigh = outDir(sl, 0.08 + bob * 0.12); p.a.lShin = outDir(sl, 0.08 - bob * 0.18);
      p.a.rThigh = outDir(sr, 0.08 + bob * 0.12); p.a.rShin = outDir(sr, 0.08 - bob * 0.18);
      keys.push({ t: i / 8 * 2, pose: p });
    }
    return keys;
  } },
  jacks: { name: 'Jumping jacks', duration: 1.2, make(I, base) {
    const sl = sideSign(I, 'l'), sr = sideSign(I, 'r'), w = I.torso * base.s, keys = [];
    for (let i = 0; i <= 4; i++) {
      const open = i % 2 === 1, p = lerpPose(base, base, 0);
      p.a.lUpper = outDir(sl, open ? 2.6 : 0.15); p.a.lFore = outDir(sl, open ? 2.9 : 0.1);
      p.a.rUpper = outDir(sr, open ? 2.6 : 0.15); p.a.rFore = outDir(sr, open ? 2.9 : 0.1);
      p.a.lThigh = p.a.lShin = outDir(sl, open ? 0.32 : 0.04); p.a.rThigh = p.a.rShin = outDir(sr, open ? 0.32 : 0.04);
      p.y = base.y - (open ? w * 0.12 : 0); keys.push({ t: i * 0.3, pose: p });
    }
    return keys;
  } },
  disco: { name: 'Disco point', duration: 2, make(I, base) {
    const sl = sideSign(I, 'l'), sr = sideSign(I, 'r'), keys = [];
    for (let i = 0; i <= 4; i++) {
      const p = lerpPose(base, base, 0), right = i % 2 === 0;
      if (right) { p.a.rUpper = outDir(sr, 2.5); p.a.rFore = outDir(sr, 2.6); p.a.lUpper = outDir(sl, 0.5); p.a.lFore = outDir(-sl, 0.9); p.a.torso = base.a.torso - sr * 0.1; }
      else { p.a.rUpper = outDir(sr, 0.5); p.a.rFore = outDir(-sr, 0.9); p.a.lUpper = outDir(sl, 0.3); p.a.lFore = outDir(sl, 0.2); p.a.torso = base.a.torso + sr * 0.05; }
      p.a.head = p.a.torso + (base.a.head - base.a.torso); keys.push({ t: i * 0.5, pose: p });
    }
    return keys;
  } },
  robot: { name: 'Robot', duration: 2.4, make(I, base) {
    const sl = sideSign(I, 'l'), sr = sideSign(I, 'r'), keys = [];
    [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]].forEach(([lu, ru], i) => {
      const p = lerpPose(base, base, 0);
      p.a.lUpper = outDir(sl, lu ? Math.PI / 2 : 0.1); p.a.lFore = lu ? UP : outDir(sl, 0.1);
      p.a.rUpper = outDir(sr, ru ? Math.PI / 2 : 0.1); p.a.rFore = ru ? UP : outDir(sr, 0.1);
      p.a.head = base.a.head + (i === 4 ? 0 : i % 2 ? 0.25 : -0.25);
      keys.push({ t: i * 0.6, pose: p }); if (i < 4) keys.push({ t: i * 0.6 + 0.45, pose: p });
    });
    return keys;
  } },
};

/** Retarget per-frame pose landmarks (33×{x,y} in px, from any video) onto your rig.
 *  frames: Array<Float32Array(33*2)|null>. Root motion is scaled from the dancer's torso to yours. */
export function retargetFrames(frames, I, anchor, s) {
  const idx = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28 };
  const joints = f => { const g = i => [f[i * 2], f[i * 2 + 1]], J = {}; for (const [k, i] of Object.entries(idx)) J[k] = g(i); J.neck = [(J.lSh[0] + J.rSh[0]) / 2, (J.lSh[1] + J.rSh[1]) / 2]; J.pelvis = [(J.lHip[0] + J.rHip[0]) / 2, (J.lHip[1] + J.rHip[1]) / 2]; return J; };
  const first = frames.find(Boolean); if (!first) return [];
  const J0 = joints(first);
  const torsos = frames.filter(Boolean).map(f => { const J = joints(f); return len(J.pelvis, J.neck); }).sort((a, b) => a - b);
  const dancerTorso = torsos[Math.floor(torsos.length / 2)] || 1, k = (I.torso * s) / dancerTorso;
  let last = null;
  return frames.map(f => {
    if (!f) return last;
    const J = joints(f), p = fromJoints(J, I);
    p.s = s; p.x = anchor[0] + (J.pelvis[0] - J0.pelvis[0]) * k; p.y = anchor[1] + (J.pelvis[1] - J0.pelvis[1]) * k;
    last = p; return p;
  });
}
