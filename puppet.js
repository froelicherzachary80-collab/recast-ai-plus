// RECAST AI+ v0.2 — MotionLock Animate: full-body 2D rig driven by the source actor's pose.
// Your full-body photo is cut out (person mask), meshed, and skinned to 11 bones taken from your own
// pose landmarks. Every frame each bone is mapped onto the actor's matching bone (rotation, length and
// body scale), and vertices follow by linear blend skinning. It is image warping, not generation:
// turning around or crossing limbs cannot reveal parts the photo never showed.

/** Virtual joints: indices into the 33-point pose, or [a,b] = midpoint. */
const J = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, neck: [11, 12], pelvis: [23, 24] };
export const BONES = [
  ['torso', 'pelvis', 'neck'], ['head', 'neck', 'nose'],
  ['lUpper', 'lSh', 'lEl'], ['lFore', 'lEl', 'lWr'], ['rUpper', 'rSh', 'rEl'], ['rFore', 'rEl', 'rWr'],
  ['lThigh', 'lHip', 'lKn'], ['lShin', 'lKn', 'lAn'], ['rThigh', 'rHip', 'rKn'], ['rShin', 'rKn', 'rAn'],
];
export const REQUIRED_JOINTS = ['lSh', 'rSh', 'lEl', 'rEl', 'lWr', 'rWr', 'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn'];

/** Joint position from a pose array. get(i) → [x, y]. */
export function joint(get, name) {
  const j = J[name];
  if (Array.isArray(j)) { const a = get(j[0]), b = get(j[1]); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  return get(j);
}

function distSeg(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Build a mesh over the cutout. alpha: Uint8 (w*h) or Float32 0..1; restJoints: {name:[x,y]} in cutout px. */
export function buildRig(alpha, w, h, restJoints, { cells = 44, power = 5 } = {}) {
  const step = Math.max(w, h) / cells, gx = Math.ceil(w / step) + 1, gy = Math.ceil(h / step) + 1;
  const a = (x, y) => { x = Math.max(0, Math.min(w - 1, x | 0)); y = Math.max(0, Math.min(h - 1, y | 0)); const v = alpha[y * w + x]; return v > 1 ? v / 255 : v; };
  // a cell is "solid" if any sample inside it has alpha
  const solid = new Uint8Array((gx - 1) * (gy - 1));
  for (let j = 0; j < gy - 1; j++) for (let i = 0; i < gx - 1; i++) {
    let hit = 0;
    for (let sy = 0; sy <= 3 && !hit; sy++) for (let sx = 0; sx <= 3; sx++) if (a((i + sx / 3) * step, (j + sy / 3) * step) > 0.04) { hit = 1; break; }
    solid[j * (gx - 1) + i] = hit;
  }
  const vid = new Int32Array(gx * gy).fill(-1), pos = [], tris = [];
  const vert = (i, j) => { const k = j * gx + i; if (vid[k] < 0) { vid[k] = pos.length / 2; pos.push(Math.min(w, i * step), Math.min(h, j * step)); } return vid[k]; };
  for (let j = 0; j < gy - 1; j++) for (let i = 0; i < gx - 1; i++) {
    if (!solid[j * (gx - 1) + i]) continue;
    const v00 = vert(i, j), v10 = vert(i + 1, j), v11 = vert(i + 1, j + 1), v01 = vert(i, j + 1);
    tris.push(v00, v10, v11, v00, v11, v01);
  }
  const n = pos.length / 2, rest = Float32Array.from(pos);
  const bones = BONES.map(([name, a0, b0]) => ({ name, a: restJoints[a0], b: restJoints[b0] }));
  // skin weights: top-2 nearest bones, inverse-distance^power
  const wIdx = new Uint8Array(n * 2), wVal = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    const x = rest[v * 2], y = rest[v * 2 + 1];
    let b1 = 0, d1 = Infinity, b2 = 0, d2 = Infinity;
    bones.forEach((b, k) => { const d = distSeg(x, y, b.a, b.b); if (d < d1) { b2 = b1; d2 = d1; b1 = k; d1 = d; } else if (d < d2) { b2 = k; d2 = d; } });
    const e = step * 0.5, w1 = 1 / Math.pow(d1 + e, power), w2 = 1 / Math.pow(d2 + e, power), s = w1 + w2;
    wIdx[v * 2] = b1; wIdx[v * 2 + 1] = b2; wVal[v * 2] = w1 / s; wVal[v * 2 + 1] = w2 / s;
  }
  const uv = new Float32Array(n * 2); for (let v = 0; v < n; v++) { uv[v * 2] = rest[v * 2] / w; uv[v * 2 + 1] = rest[v * 2 + 1] / h; }
  const torsoLen = Math.hypot(restJoints.neck[0] - restJoints.pelvis[0], restJoints.neck[1] - restJoints.pelvis[1]) || 1;
  return { n, rest, uv, idx: new Uint16Array(tris), bones, wIdx, wVal, torsoLen, w, h };
}

/** Per-bone affine (as 2x3) mapping rest bone → target bone with length ratio k along and g across. */
export function boneAffine(a, b, a2, b2, g, kClamp = [0.25, 2.2]) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6, L2 = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const u2x = L2 > 1e-6 ? (b2[0] - a2[0]) / L2 : ux, u2y = L2 > 1e-6 ? (b2[1] - a2[1]) / L2 : uy;
  const k = Math.max(kClamp[0], Math.min(kClamp[1], L2 / L));
  // p' = a2 + (p-a)·u * k * u2 + (p-a)·n * g * n2   with n = (-uy, ux)
  const m00 = k * u2x * ux + g * (-u2y) * (-uy), m01 = k * u2x * uy + g * (-u2y) * ux;
  const m10 = k * u2y * ux + g * u2x * (-uy), m11 = k * u2y * uy + g * u2x * ux;
  return [m00, m01, m10, m11, a2[0] - (m00 * a[0] + m01 * a[1]), a2[1] - (m10 * a[0] + m11 * a[1])];
}

/** Deform the rig to target joints (pixel space). Returns Float32Array positions. */
export function deformRig(rig, target) {
  const g = Math.hypot(target.neck[0] - target.pelvis[0], target.neck[1] - target.pelvis[1]) / rig.torsoLen;
  const M = rig.bones.map(bn => {
    const [, a0, b0] = BONES.find(B => B[0] === bn.name);
    return bn.name === 'torso' ? boneAffine(bn.a, bn.b, target[a0], target[b0], g, [0.5, 1.8]) : boneAffine(bn.a, bn.b, target[a0], target[b0], g);
  });
  const out = new Float32Array(rig.n * 2), r = rig.rest;
  for (let v = 0; v < rig.n; v++) {
    const x = r[v * 2], y = r[v * 2 + 1];
    let px = 0, py = 0;
    for (let s = 0; s < 2; s++) {
      const m = M[rig.wIdx[v * 2 + s]], wv = rig.wVal[v * 2 + s];
      px += wv * (m[0] * x + m[1] * y + m[4]); py += wv * (m[2] * x + m[3] * y + m[5]);
    }
    out[v * 2] = px; out[v * 2 + 1] = py;
  }
  return out;
}

/** Target joints from a smoothed pose (Float32 stride 4, normalized) in pixel space. */
export function poseJoints(P, W, H) {
  const get = i => [P[i * 4] * W, P[i * 4 + 1] * H];
  const t = {}; for (const k of Object.keys(J)) t[k] = joint(get, k);
  return t;
}
