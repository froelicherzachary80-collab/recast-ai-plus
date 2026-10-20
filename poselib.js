// RECAST AI+ v0.4 — pose library: solo poses (basics, poster, superhero, dance, everyday) and
// two-person scenes (romance, friends, action). Poses are built from YOUR rig's proportions, and
// contacts (holding hands, arm around shoulder, high five) are solved with IK so hands really meet.
import { fk, dragJoint, sideSign, outDir, wrapAngle } from './poserig.js';

const PI = Math.PI, H = PI / 2;
const clone = p => ({ x: p.x, y: p.y, s: p.s, a: { ...p.a } });
/** Which rig side ('l'|'r') appears on screen-right / screen-left. */
export const screenSide = I => { const sl = sideSign(I, 'l'); return { R: sl > 0 ? 'l' : 'r', L: sl > 0 ? 'r' : 'l' }; };
const lowestFoot = J => Math.max(J.lAn[1], J.rAn[1]);

/** Build a pose from a spec in screen terms. base = the character's relaxed pose (sets x, y, s, torso, head).
 *  spec: { armL:[upper, fore], armR, legL:[thigh, shin], legR, lean, head, drop, lift, plant } — elevations in radians:
 *  0 = hanging down, π/2 = straight out to that side, π = straight up, negative = across the body. */
export function makePose(I, base, spec = {}) {
  const P = clone(base), a = P.a, sd = screenSide(I), T = I.torso * base.s;
  const lean = spec.lean || 0;
  a.torso = base.a.torso + lean; a.head = a.torso + (base.a.head - base.a.torso) + (spec.head || 0);
  const limb = (key, side, sgn, upperName, lowerName) => { const v = spec[key]; if (!v) return; a[side + upperName] = outDir(sgn, v[0]); a[side + lowerName] = outDir(sgn, v[1]); };
  limb('armR', sd.R, 1, 'Upper', 'Fore'); limb('armL', sd.L, -1, 'Upper', 'Fore');
  limb('legR', sd.R, 1, 'Thigh', 'Shin'); limb('legL', sd.L, -1, 'Thigh', 'Shin');
  if (spec.drop || spec.lift) P.y = base.y + ((spec.drop || 0) - (spec.lift || 0)) * T;
  if (spec.plant) { // keep feet on the ground (crouches): IK each ankle back to the floor
    const J0 = fk(base, I), floor = lowestFoot(J0);
    let Q = P;
    for (const [side, sgn] of [[sd.R, 1], [sd.L, -1]]) {
      const ank = side + 'An', J = fk(Q, I), spread = (spec.plant.spread || 0) * T * sgn;
      Q = dragJoint(Q, I, ank, [J0[ank][0] + spread, floor]);
    }
    return Q;
  }
  return P;
}

const solo = (cat, name, spec, tags = '', fx = null) => ({ cat, name, spec, tags, fx });
export const POSES = [
  solo('Basics', 'T-pose', { armL: [H, H], armR: [H, H], legL: [0.06, 0.06], legR: [0.06, 0.06] }, 'model rig reference'),
  solo('Basics', 'A-pose', { armL: [0.75, 0.75], armR: [0.75, 0.75], legL: [0.08, 0.08], legR: [0.08, 0.08] }, 'model rig reference'),
  solo('Basics', 'Relaxed', { armL: [0.12, 0.08], armR: [0.12, 0.08], legL: [0.05, 0.05], legR: [0.05, 0.05] }, 'standing natural'),
  solo('Poster', 'Hero stance', { armL: [0.75, -0.95], armR: [0.75, -0.95], legL: [0.14, 0.14], legR: [0.14, 0.14] }, 'hands on hips confident cover'),
  solo('Poster', 'Arms crossed', { armL: [0.15, -1.45], armR: [0.18, -1.35], legL: [0.12, 0.12], legR: [0.12, 0.12], head: 0.04 }, 'serious tough cover'),
  solo('Poster', 'Fist raised', { armL: [0.2, 0.15], armR: [2.95, 3.0], legL: [0.15, 0.15], legR: [0.15, 0.15] }, 'victory power triumph'),
  solo('Poster', 'Victory V', { armL: [2.5, 2.65], armR: [2.5, 2.65], legL: [0.12, 0.12], legR: [0.12, 0.12] }, 'celebrate win champion'),
  solo('Poster', 'Thinker', { armL: [0.3, -1.3], armR: [0.35, PI + 0.35], head: 0.12, legL: [0.05, 0.05], legR: [0.05, 0.05] }, 'hand on chin drama mystery'),
  solo('Poster', 'Cool lean', { armL: [0.12, 0.1], armR: [0.25, -0.35], lean: -0.08, head: 0.1, legL: [0.02, -0.12], legR: [0.18, 0.18] }, 'casual hands in pocket'),
  solo('Superhero', 'Hero landing', { armL: [0.2, 0.1], armR: [1.9, 2.3], drop: 0.55, plant: { spread: 0.35 }, legL: [1.2, -0.3], legR: [1.2, -0.3], lean: 0.05 }, 'crouch impact landing ground', [{ type: 'shock', joint: 'feet', color: '#9fd3ff' }]),
  solo('Superhero', 'Take off', { armL: [0.35, 0.25], armR: [2.9, 2.95], lift: 0.45, legL: [0.03, 0], legR: [0.03, 0] }, 'flying up fly launch', [{ type: 'trail', joint: 'feet', color: '#ffd38a' }]),
  solo('Superhero', 'Hover', { armL: [1.15, 1.05], armR: [1.15, 1.05], lift: 0.55, legL: [0.12, -0.04], legR: [0.12, -0.04] }, 'float levitate powers', [{ type: 'aura', color: '#8dc6ff' }]),
  solo('Superhero', 'Energy blast', { armL: [-H + 0.25, -H + 0.05], armR: [H - 0.05, H], lean: 0.08, head: 0.1, legL: [0.35, 0.3], legR: [0.15, 0.1] }, 'beam attack power hands', [{ type: 'beam', joint: 'handR', color: '#7fe3ff' }]),
  solo('Superhero', 'Palm blast', { armL: [H, H], armR: [0.2, 0.1], head: -0.1, legL: [0.2, 0.2], legR: [0.15, 0.15] }, 'repulsor hand light', [{ type: 'glow', joint: 'handL', color: '#bfe8ff' }]),
  solo('Superhero', 'Ready to fight', { armL: [0.4, 2.6], armR: [0.5, 2.7], drop: 0.1, plant: { spread: 0.4 }, legL: [0.45, 0.2], legR: [0.45, 0.2] }, 'fists guard battle combat'),
  solo('Superhero', 'Thunder call', { armL: [0.6, 0.4], armR: [3.0, 3.05], legL: [0.2, 0.2], legR: [0.2, 0.2], head: -0.05 }, 'lightning storm hammer sky', [{ type: 'lightning', joint: 'handR', color: '#cfe0ff' }]),
  solo('Dance', 'Dab', { armL: [-2.36, -3.6], armR: [2.25, 2.3], head: 0.35, legL: [0.12, 0.12], legR: [0.12, 0.12] }, 'party move'),
  solo('Dance', 'Disco point', { armL: [0.5, -0.9], armR: [2.5, 2.6], lean: -0.1, legL: [0.12, 0.12], legR: [0.25, 0.25] }, 'retro 70s'),
  solo('Dance', 'Hands up', { armL: [2.7, 2.9], armR: [2.7, 2.9], head: -0.08, legL: [0.1, 0.1], legR: [0.1, 0.1] }, 'party club rave'),
  solo('Dance', 'Star jump', { armL: [2.4, 2.5], armR: [2.4, 2.5], lift: 0.3, legL: [0.45, 0.45], legR: [0.45, 0.45] }, 'jump energy'),
  solo('Everyday', 'Wave', { armL: [0.12, 0.08], armR: [2.0, PI], legL: [0.05, 0.05], legR: [0.05, 0.05] }, 'hello hi greeting'),
  solo('Everyday', 'Shrug', { armL: [0.5, 1.9], armR: [0.5, 1.9], head: 0.12, legL: [0.06, 0.06], legR: [0.06, 0.06] }, 'dunno whatever'),
  solo('Everyday', 'Surrender', { armL: [1.75, PI], armR: [1.75, PI], legL: [0.08, 0.08], legR: [0.08, 0.08] }, 'hands up caught'),
  solo('Everyday', 'Walking', { armL: [0.25, 0.15], armR: [0.05, 0.1], legL: [0.12, -0.04], legR: [-0.03, 0.08] }, 'stride step'),
];

// ───────── two-person scenes ─────────
const RELAXED = POSES.find(p => p.name === 'Relaxed').spec;
const wristOf = side => side + 'Wr';
/** Place B next to A (distance in A torso lengths), with both feet on the same floor. */
function placePair(A, B, IA, IB, dist) {
  const JA = fk(A.pose, IA), TA = IA.torso * A.pose.s;
  const Bp = clone(B.pose); Bp.x = A.pose.x + dist * TA;
  const JB = fk(Bp, IB); Bp.y += lowestFoot(JA) - lowestFoot(JB);
  return Bp;
}
const reach = (P, I, side, target) => dragJoint(P, I, wristOf(side), target);
/** A point between two people both hands can reach: at desiredY if possible, otherwise as low as reach allows. */
function meetPoint(JA, JB, IA, IB, sA, sB, sa, sb, desiredY) {
  const shA = JA[sa + 'Sh'], shB = JB[sb + 'Sh'], x = (shA[0] + shB[0]) / 2;
  const LA = (IA.L[sa + 'Upper'] + IA.L[sa + 'Fore']) * sA * 0.97, LB = (IB.L[sb + 'Upper'] + IB.L[sb + 'Fore']) * sB * 0.97;
  const lim = (sh, L) => { const dx = Math.abs(x - sh[0]); return dx >= L ? sh[1] : sh[1] + Math.sqrt(L * L - dx * dx); };
  const top = (sh, L) => { const dx = Math.abs(x - sh[0]); return dx >= L ? sh[1] : sh[1] - Math.sqrt(L * L - dx * dx); };
  const lo = Math.min(lim(shA, LA), lim(shB, LB)), hi = Math.max(top(shA, LA), top(shB, LB));
  return [x, Math.max(hi, Math.min(lo, desiredY))];
}

/** Each duo returns { A, B, order:'AB'|'BA' (drawn first → last), fx } given layers {pose, I} with A on screen-left. */
export const DUOS = [
  { cat: 'Romance', name: 'Holding hands', tags: 'couple love walk', make(A, B) {
    let a = makePose(A.I, A.pose, RELAXED), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 1.05), RELAXED);
    const JA = fk(a, A.I), JB = fk(b, B.I), sa = screenSide(A.I).R, sb = screenSide(B.I).L, T = A.I.torso * a.s;
    const meet = meetPoint(JA, JB, A.I, B.I, a.s, b.s, sa, sb, (JA.pelvis[1] + JB.pelvis[1]) / 2 + 0.25 * T);
    return { A: reach(a, A.I, sa, meet), B: reach(b, B.I, sb, meet), order: 'AB' };
  } },
  { cat: 'Romance', name: 'Heads together', tags: 'couple selfie close love', make(A, B) {
    let a = makePose(A.I, A.pose, { ...RELAXED, lean: 0.07, head: 0.28 }), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 0.72), { ...RELAXED, lean: -0.07, head: -0.28 });
    const JA = fk(a, A.I), JB = fk(b, B.I), sa = screenSide(A.I).R, sb = screenSide(B.I).L, T = A.I.torso * a.s;
    const meet = meetPoint(JA, JB, A.I, B.I, a.s, b.s, sa, sb, (JA.pelvis[1] + JB.pelvis[1]) / 2 + 0.2 * T);
    return { A: reach(a, A.I, sa, meet), B: reach(b, B.I, sb, meet), order: 'AB' };
  } },
  { cat: 'Romance', name: 'Arm around shoulder', tags: 'couple friends hug side', make(A, B) {
    let a = makePose(A.I, A.pose, RELAXED), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 0.82), { ...RELAXED, head: -0.12 });
    const JB = fk(b, B.I), sa = screenSide(A.I), sb = screenSide(B.I), JA = fk(a, A.I);
    return { A: reach(a, A.I, sa.R, JB[sb.R + 'Sh']), B: reach(b, B.I, sb.L, JA[sa.L + 'Hip']), order: 'BA' };
  } },
  { cat: 'Romance', name: 'Slow dance (side by side)', tags: 'couple dance wedding prom', make(A, B) {
    let a = makePose(A.I, A.pose, { ...RELAXED, head: 0.2, lean: 0.05 }), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 0.7), { ...RELAXED, head: -0.22, lean: -0.05 });
    const JA = fk(a, A.I), JB = fk(b, B.I), sa = screenSide(A.I), sb = screenSide(B.I);
    return { A: reach(a, A.I, sa.R, JB[sb.R + 'Hip']), B: reach(b, B.I, sb.L, JA[sa.R + 'Sh']), order: 'AB' };
  } },
  { cat: 'Friends', name: 'High five', tags: 'celebrate team win', make(A, B) {
    let a = makePose(A.I, A.pose, RELAXED), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 1.1), RELAXED);
    const JA = fk(a, A.I), JB = fk(b, B.I), sa = screenSide(A.I).R, sb = screenSide(B.I).L, T = A.I.torso * a.s;
    const meet = meetPoint(JA, JB, A.I, B.I, a.s, b.s, sa, sb, Math.min(JA.nose[1], JB.nose[1]) - 0.35 * T);
    return { A: reach(a, A.I, sa, meet), B: reach(b, B.I, sb, meet), order: 'AB' };
  } },
  { cat: 'Poster', name: 'Back to back', tags: 'duo heroes cover partners', make(A, B) {
    const cross = POSES.find(p => p.name === 'Arms crossed').spec;
    const a = makePose(A.I, A.pose, { ...cross, lean: -0.06 }), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 0.78), { ...cross, lean: 0.06 });
    return { A: a, B: b, order: 'AB' };
  } },
  { cat: 'Action', name: 'Face-off', tags: 'rivals fight battle versus', make(A, B) {
    const f = POSES.find(p => p.name === 'Ready to fight').spec;
    const a = makePose(A.I, A.pose, { ...f, lean: 0.06 }), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 1.7), { ...f, lean: -0.06 });
    return { A: a, B: b, order: 'AB' };
  } },
  { cat: 'Action', name: 'Energy clash', tags: 'beam battle powers superhero', make(A, B) {
    const blast = POSES.find(p => p.name === 'Energy blast').spec;
    const mirror = { ...blast, armL: blast.armR, armR: blast.armL, legL: blast.legR, legR: blast.legL, lean: -blast.lean, head: -blast.head };
    const a = makePose(A.I, A.pose, blast), b = makePose(B.I, placePair({ ...A, pose: a }, B, A.I, B.I, 2.4), mirror);
    return { A: a, B: b, order: 'AB', fxA: [{ type: 'beam', joint: 'handR', color: '#7fe3ff' }], fxB: [{ type: 'beam', joint: 'handL', color: '#ff9a7f' }] };
  } },
];

/** Search poses and duos by words (name, category, tags). */
export function searchPoses(q) {
  const words = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hit = p => words.every(w => `${p.name} ${p.cat} ${p.tags}`.toLowerCase().includes(w));
  return { solo: POSES.filter(hit), duo: DUOS.filter(hit) };
}

/** Resolve an effect joint key to a stage point and direction for a pose. */
export function fxAnchor(I, P, key) {
  const J = fk(P, I), sd = screenSide(I);
  if (key === 'feet') return { p: [(J.lAn[0] + J.rAn[0]) / 2, Math.max(J.lAn[1], J.rAn[1])], dir: [0, 1] };
  const side = key === 'handR' ? sd.R : sd.L, w = J[side + 'Wr'], e = J[side + 'El'], d = Math.hypot(w[0] - e[0], w[1] - e[1]) || 1;
  return { p: w, dir: [(w[0] - e[0]) / d, (w[1] - e[1]) / d] };
}
export { wrapAngle };
