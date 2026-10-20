// RECAST AI+ v0.4 — T-pose model maker.
// Turns your full-body photo into a clean T-pose model sheet (arms straight out), which then becomes
// the bind pose of your rig. Binding in a T-pose separates the arms from the body, so raised-arm,
// superhero and dance poses deform more cleanly. Best result: upload a real photo of you in a T-pose.
import { buildRig, deformRig, BONES } from './puppet.js';
import { restInfo, fk, fromJoints } from './poserig.js';
import { makePose, POSES } from './poselib.js';

const ARM_BONES = new Set(BONES.map((b, i) => [b[0], i]).filter(([n]) => /Upper|Fore/.test(n)).map(([, i]) => i));

/** Target joints (photo px) for a T-pose of this body. Feet stay where they were. */
export function tposeJoints(joints) {
  const I = restInfo(joints), base = fromJoints(joints, I);
  const P = makePose(I, base, POSES.find(p => p.name === 'T-pose').spec);
  return { I, P, J: fk(P, I) };
}

/** Drop triangles stretched more than maxStretch (tears instead of rubber skin) and draw arms last. */
export function tearAndOrder(rig, pos, maxStretch = 1.7) {
  const r = rig.rest, keepBody = [], keepArm = [];
  let torn = 0;
  for (let t = 0; t < rig.idx.length; t += 3) {
    const v = [rig.idx[t], rig.idx[t + 1], rig.idx[t + 2]];
    let worst = 0;
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const l0 = Math.hypot(r[b * 2] - r[a * 2], r[b * 2 + 1] - r[a * 2 + 1]) || 1e-6, l1 = Math.hypot(pos[b * 2] - pos[a * 2], pos[b * 2 + 1] - pos[a * 2 + 1]);
      worst = Math.max(worst, l1 / l0);
    }
    if (worst > maxStretch) { torn++; continue; }
    const arm = v.every(x => ARM_BONES.has(rig.wIdx[x * 2]) && rig.wVal[x * 2] > 0.6);
    (arm ? keepArm : keepBody).push(...v);
  }
  return { idx: Uint16Array.from([...keepBody, ...keepArm]), torn, total: rig.idx.length / 3 };
}

/** Build a T-pose model from an analyzed body (see plate.analyzeBody). Needs a FaceRenderer class. */
export async function makeTPoseModel(body, { toCanvas, Renderer, maxStretch = 1.7 }) {
  const rig = buildRig(body.alpha, body.w, body.h, body.joints, { cells: 56 });
  const { J } = tposeJoints(body.joints);
  const pos = deformRig(rig, J), { idx, torn, total } = tearAndOrder(rig, pos, maxStretch);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < idx.length; i++) { const v = idx[i]; x0 = Math.min(x0, pos[v * 2]); x1 = Math.max(x1, pos[v * 2]); y0 = Math.min(y0, pos[v * 2 + 1]); y1 = Math.max(y1, pos[v * 2 + 1]); }
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
  const W = Math.ceil(x1 - x0) + pad * 2, H = Math.ceil(y1 - y0) + pad * 2, ox = pad - x0, oy = pad - y0;
  const P = new Float32Array(pos.length); for (let i = 0; i < pos.length; i += 2) { P[i] = pos[i] + ox; P[i + 1] = pos[i + 1] + oy; }
  const r = new Renderer(W, H), src = await toCanvas(body.png, 4096), tex = r.texture('tpose', src);
  const blank = document.createElement('canvas'); blank.width = W; blank.height = H;
  r.render(blank, [{ tex, pos: P, uv: rig.uv, alpha: new Float32Array(rig.n).fill(1), gain: new Float32Array(rig.n * 3).fill(1), idx, opacity: 1, grain: 0, sat: 1, bias: 0 }]);
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ctx = out.getContext('2d', { willReadFrequently: true }); ctx.drawImage(r.canvas, 0, 0); r.dispose();
  const img = ctx.getImageData(0, 0, W, H), alpha = new Uint8Array(W * H);
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let i = 0; i < W * H; i++) { const a = img.data[i * 4 + 3]; alpha[i] = a < 12 ? 0 : a; if (a > 230) { sr += img.data[i * 4]; sg += img.data[i * 4 + 1]; sb += img.data[i * 4 + 2]; sn++; } }
  const joints = {}; for (const [k, v] of Object.entries(J)) joints[k] = [v[0] + ox, v[1] + oy];
  const png = await new Promise(res => out.toBlob(res, 'image/png'));
  const issues = ['Generated from your photo: the sides of the body and armpits were never visible, so they may look stretched or cut. A real T-pose photo gives the best model.'];
  if (torn / total > 0.04) issues.push(`${Math.round(torn / total * 100)}% of the mesh tore while lifting the arms (arms were close to the body).`);
  return { ok: true, png, w: W, h: H, alpha, joints, mean: sn ? [sr / sn, sg / sn, sb / sn] : body.mean, missing: [], poseModel: body.poseModel, issues, source: 'tpose-generated', at: Date.now() };
}
