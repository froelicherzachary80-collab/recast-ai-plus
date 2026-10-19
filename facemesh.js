// MediaPipe Face Landmarker topology constants (478-point mesh incl. irises).
import { delaunay, pointInPolygon, distToPolygon, triSign } from './geometry.js';

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
export const EYE_A = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 468, 469, 470, 471, 472];
export const EYE_B = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249, 473, 474, 475, 476, 477];
// Stable points for rigid (similarity) alignment: eye corners, nose bridge, nose tip, forehead, chin, cheeks.
export const STABLE = [33, 133, 362, 263, 168, 6, 1, 10, 152, 234, 454];
export const NOSE_TIP = 1, FOREHEAD = 10, CHIN = 152, CHEEK_A = 234, CHEEK_B = 454;
export const N_FACE = 478;

// Pose (33) indices
export const POSE = { nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28 };
export const POSE_EDGES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];
export const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

/** Yaw estimate in [-1,1] from flat (stride s) landmarks. */
export function faceYaw(lm, s = 3) {
  const ax = lm[CHEEK_A * s], bx = lm[CHEEK_B * s], nx = lm[NOSE_TIP * s];
  const w = bx - ax;
  if (Math.abs(w) < 1e-6) return 0;
  return ((nx - ax) / w - 0.5) * 2;
}

/** Face width in the same units as the landmarks. */
export function faceWidth(lm, s = 3) {
  return Math.hypot(lm[CHEEK_B * s] - lm[CHEEK_A * s], lm[CHEEK_B * s + 1] - lm[CHEEK_A * s + 1]);
}

/** Build the replacement mesh from reference landmarks given in pixels (flat xy, length 2N).
 *  Returns triangles inside the face oval, plus per-vertex edge distance (normalized by face width). */
export function buildFaceMesh(xy) {
  const n = xy.length / 2;
  const pts = []; for (let i = 0; i < n; i++) pts.push([xy[i * 2], xy[i * 2 + 1]]);
  const oval = FACE_OVAL.map(i => pts[i]);
  const fw = Math.hypot(pts[CHEEK_B][0] - pts[CHEEK_A][0], pts[CHEEK_B][1] - pts[CHEEK_A][1]) || 1;
  const all = delaunay(pts);
  const ovalSet = new Set(FACE_OVAL);
  const tris = [];
  for (const [a, b, c] of all) {
    const cx = (pts[a][0] + pts[b][0] + pts[c][0]) / 3, cy = (pts[a][1] + pts[b][1] + pts[c][1]) / 3;
    if (!pointInPolygon(cx, cy, oval)) continue;
    if (Math.abs(triSign(xy, a, b, c)) < 1e-6) continue;
    tris.push(triSign(xy, a, b, c) > 0 ? [a, b, c] : [a, c, b]); // consistent orientation
  }
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    edge[i] = ovalSet.has(i) ? 0 : (pointInPolygon(pts[i][0], pts[i][1], oval) ? distToPolygon(pts[i][0], pts[i][1], oval) / fw : 0);
  }
  const mouth = new Set(LIPS_INNER), ea = new Set(EYE_A), eb = new Set(EYE_B);
  const flags = tris.map(([a, b, c]) =>
    (mouth.has(a) && mouth.has(b) && mouth.has(c) ? 1 : 0) |
    ((ea.has(a) && ea.has(b) && ea.has(c)) || (eb.has(a) && eb.has(b) && eb.has(c)) ? 2 : 0));
  return { tris, edge, flags, faceWidth: fw };
}

/** Per-vertex edge distance for another reference view using the shared triangle set. */
export function edgeDistances(xy) {
  const n = xy.length / 2, ovalSet = new Set(FACE_OVAL);
  const pts = []; for (let i = 0; i < n; i++) pts.push([xy[i * 2], xy[i * 2 + 1]]);
  const oval = FACE_OVAL.map(i => pts[i]);
  const fw = Math.hypot(pts[CHEEK_B][0] - pts[CHEEK_A][0], pts[CHEEK_B][1] - pts[CHEEK_A][1]) || 1;
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) edge[i] = ovalSet.has(i) ? 0 : (pointInPolygon(pts[i][0], pts[i][1], oval) ? distToPolygon(pts[i][0], pts[i][1], oval) / fw : 0);
  return edge;
}
