import test from 'node:test';
import assert from 'node:assert/strict';
import { restInfo, fk, fromJoints, restPose, LIMBS } from '../poserig.js';
import { makePose, POSES, DUOS, searchPoses, screenSide, fxAnchor } from '../poselib.js';
import { tposeJoints, tearAndOrder } from '../tpose.js';
import { buildRig, deformRig } from '../puppet.js';
import { applyGrade, GRADES } from '../fx.js';

const R = { nose: [100, 30], neck: [100, 70], pelvis: [100, 200], lSh: [130, 70], rSh: [70, 70], lEl: [150, 130], rEl: [50, 130], lWr: [160, 190], rWr: [40, 190], lHip: [120, 200], rHip: [80, 200], lKn: [125, 300], rKn: [75, 300], lAn: [125, 390], rAn: [75, 390] };
const I = restInfo(R), base = fromJoints(R, I);
const lens = J => Object.fromEntries(Object.entries(LIMBS).map(([k, [a, b]]) => [k, Math.hypot(J[b][0] - J[a][0], J[b][1] - J[a][1])]));

test('T-pose: wrists level with shoulders, out to each side, bone lengths kept', () => {
  const { J } = tposeJoints(R);
  for (const s of ['l', 'r']) assert.ok(Math.abs(J[s + 'Wr'][1] - J[s + 'Sh'][1]) < 1e-6, s);
  assert.ok(J.lWr[0] > 230 && J.rWr[0] < -30, `${J.lWr[0]} ${J.rWr[0]}`);
  const a = lens(R), b = lens(J); for (const k of Object.keys(a)) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, k);
  assert.ok(Math.abs(J.lAn[1] - 390) < 2, 'feet stay on the floor');
});

test('every solo pose is finite and keeps bone lengths', () => {
  const L0 = lens(fk(base, I));
  for (const p of POSES) {
    const J = fk(makePose(I, base, p.spec), I);
    for (const [n, v] of Object.entries(J)) assert.ok(Number.isFinite(v[0]) && Number.isFinite(v[1]), `${p.name} ${n}`);
    const L = lens(J); for (const k of Object.keys(L0)) assert.ok(Math.abs(L[k] - L0[k]) < 1e-6, `${p.name} ${k}`);
  }
});

test('screen sides: raising "armR" lifts the arm on the right of the image', () => {
  const sd = screenSide(I); assert.equal(sd.R, 'l'); // the person's left arm is on screen-right in a front photo
  const J = fk(makePose(I, base, { armR: [Math.PI, Math.PI] }), I);
  assert.ok(J.lWr[1] < J.nose[1], 'screen-right hand above head'); assert.ok(J.rWr[1] > J.neck[1], 'other hand still down');
});

test('hero landing plants both feet on the floor while crouching', () => {
  const P = makePose(I, base, POSES.find(p => p.name === 'Hero landing').spec), J = fk(P, I);
  assert.ok(P.y > base.y + 40, 'pelvis dropped');
  assert.ok(Math.abs(J.lAn[1] - 390) < 1.5 && Math.abs(J.rAn[1] - 390) < 1.5, `${J.lAn[1]} ${J.rAn[1]}`);
});

test('duo scenes: contact points actually meet and both stand on one floor', () => {
  const R2 = Object.fromEntries(Object.entries(R).map(([k, [x, y]]) => [k, [x * 0.9, y * 0.9]])); // a shorter partner
  const IB = restInfo(R2);
  const A = { I, pose: restPose(I, 300, 600, 1) }, B = { I: IB, pose: restPose(IB, 0, 0, 1) };
  for (const d of DUOS) {
    const out = d.make(A, B), JA = fk(out.A, I), JB = fk(out.B, IB);
    assert.ok(Math.abs(Math.max(JA.lAn[1], JA.rAn[1]) - Math.max(JB.lAn[1], JB.rAn[1])) < 1.5, `${d.name} floor`);
    assert.ok(JB.pelvis[0] > JA.pelvis[0], `${d.name}: B is on the right`);
    if (['Holding hands', 'High five', 'Heads together'].includes(d.name)) assert.ok(Math.hypot(JA.lWr[0] - JB.rWr[0], JA.lWr[1] - JB.rWr[1]) < 2, `${d.name} hands meet`);
  }
});

test('pose search by words', () => {
  assert.ok(searchPoses('superhero').solo.length >= 5);
  assert.ok(searchPoses('couple').duo.some(d => d.name === 'Holding hands'));
  assert.equal(searchPoses('zzz').solo.length, 0);
});

test('effect anchor follows the forearm direction', () => {
  const P = makePose(I, base, POSES.find(p => p.name === 'Energy blast').spec), a = fxAnchor(I, P, 'handR');
  assert.ok(a.dir[0] > 0.9, 'beam points to screen-right');
});

test('T-pose tearing removes overstretched skin and keeps the rest', () => {
  const alpha = new Uint8Array(200 * 400);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 200; x++) { const torso = x > 60 && x < 140 && y > 20 && y < 210, legs = y >= 210 && ((x > 65 && x < 95) || (x > 105 && x < 135)), arms = y > 70 && y < 200 && ((x > 30 && x < 62) || (x > 138 && x < 170)); if (torso || legs || arms) alpha[y * 200 + x] = 255; }
  const rig = buildRig(alpha, 200, 400, R), { J } = tposeJoints(R), pos = deformRig(rig, J);
  const r = tearAndOrder(rig, pos, 1.7);
  assert.ok(r.torn > 0 && r.torn < r.total * 0.2, `${r.torn}/${r.total}`);
  assert.equal(r.idx.length % 3, 0);
  const none = tearAndOrder(rig, rig.rest, 1.7); assert.equal(none.torn, 0);
});

test('grades: noir is grey, none is untouched, amount blends', () => {
  const px = () => Uint8ClampedArray.from([200, 60, 30, 255, 20, 120, 220, 255]);
  const n = applyGrade(px(), 'noir'); assert.equal(n[0], n[1]); assert.equal(n[1], n[2]);
  assert.deepEqual([...applyGrade(px(), 'none')], [...px()]);
  const half = applyGrade(px(), 'noir', 0.5), full = applyGrade(px(), 'noir', 1);
  assert.ok(half[0] > full[0] && half[0] < 200);
  for (const k of Object.keys(GRADES)) { const d = applyGrade(px(), k); for (const v of d) assert.ok(v >= 0 && v <= 255); }
});
