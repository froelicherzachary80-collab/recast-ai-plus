// RECAST AI+ — pure geometry helpers (no DOM). Unit-tested in tests/.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Bowyer–Watson Delaunay triangulation. points: [[x,y], ...] → [[a,b,c], ...] */
export function delaunay(points) {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const d = Math.max(maxX - minX, maxY - minY, 1e-6) * 20;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const pts = points.concat([[mx - d, my - d], [mx, my + d], [mx + d, my - d]]);

  const circ = (a, b, c) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b], [cx, cy] = pts[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) return { a, b, c, x: 0, y: 0, r2: Infinity };
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };

  let tris = [circ(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const keep = [], edges = new Map();
    for (const t of tris) {
      const inside = t.r2 === Infinity || (px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 * (1 + 1e-9);
      if (inside) {
        for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
          const k = u < v ? u + ',' + v : v + ',' + u;
          const e = edges.get(k);
          if (e) e.n++; else edges.set(k, { u, v, n: 1 });
        }
      } else keep.push(t);
    }
    for (const e of edges.values()) if (e.n === 1) keep.push(circ(e.u, e.v, i));
    tris = keep;
  }
  return tris.filter(t => t.a < n && t.b < n && t.c < n).map(t => [t.a, t.b, t.c]);
}

export function triSign(p, a, b, c) {
  // p: flat array [x0,y0,x1,y1,...] or array of [x,y]
  const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1], cx = p[c * 2], cy = p[c * 2 + 1];
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distToPolygon(x, y, poly) {
  let m = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distToSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
    if (d < m) m = d;
  }
  return m;
}

/** Least-squares 2D similarity (Umeyama). src,dst: [[x,y],...]. Returns {a,b,tx,ty}: x' = a x - b y + tx, y' = b x + a y + ty */
export function fitSimilarity(src, dst) {
  const n = Math.min(src.length, dst.length);
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let A = 0, B = 0, N = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx, y = src[i][1] - sy, u = dst[i][0] - dx, v = dst[i][1] - dy;
    A += x * u + y * v; B += x * v - y * u; N += x * x + y * y;
  }
  const a = N > 0 ? A / N : 1, b = N > 0 ? B / N : 0;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}
export const applySim = (T, x, y) => [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty];
export const simScale = T => Math.hypot(T.a, T.b);
export const simAngle = T => Math.atan2(T.b, T.a);

/** Affine matrix mapping triangle s→d. Returns [a,b,c,d,e,f] for canvas setTransform. */
export function triAffine(s0, s1, s2, d0, d1, d2) {
  const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-10) return null;
  const i00 = (y2 - y0) / det, i01 = -(x2 - x0) / det, i10 = -(y1 - y0) / det, i11 = (x1 - x0) / det;
  const ux = d1[0] - d0[0], uy = d1[1] - d0[1], vx = d2[0] - d0[0], vy = d2[1] - d0[1];
  const a = ux * i00 + vx * i10, c = ux * i01 + vx * i11;
  const b = uy * i00 + vy * i10, d = uy * i01 + vy * i11;
  return [a, b, c, d, d0[0] - a * x0 - c * y0, d0[1] - b * x0 - d * y0];
}

/** Bilinear quad: q = [p00, p10, p11, p01] (TL, TR, BR, BL). */
export function bilinear(q, u, v) {
  const [A, B, C, D] = q;
  return [
    (1 - u) * (1 - v) * A[0] + u * (1 - v) * B[0] + u * v * C[0] + (1 - u) * v * D[0],
    (1 - u) * (1 - v) * A[1] + u * (1 - v) * B[1] + u * v * C[1] + (1 - u) * v * D[1],
  ];
}

/** Inverse bilinear via Newton iteration (works for extrapolation too). */
export function invBilinear(q, x, y) {
  let u = 0.5, v = 0.5;
  const [A, B, C, D] = q;
  for (let it = 0; it < 20; it++) {
    const [px, py] = bilinear(q, u, v);
    const ex = px - x, ey = py - y;
    if (ex * ex + ey * ey < 1e-12) break;
    const dux = (1 - v) * (B[0] - A[0]) + v * (C[0] - D[0]), duy = (1 - v) * (B[1] - A[1]) + v * (C[1] - D[1]);
    const dvx = (1 - u) * (D[0] - A[0]) + u * (C[0] - B[0]), dvy = (1 - u) * (D[1] - A[1]) + u * (C[1] - B[1]);
    const det = dux * dvy - dvx * duy;
    if (Math.abs(det) < 1e-12) break;
    u -= (ex * dvy - ey * dvx) / det;
    v -= (dux * ey - duy * ex) / det;
  }
  return [u, v];
}

/** Keyframe interpolation. keys: [{f, ...props}] (any order). base: default props. */
export function interpKeys(keys, f, base, props) {
  const out = { ...base };
  if (!keys || !keys.length) return out;
  const ks = [...keys].sort((a, b) => a.f - b.f);
  for (const p of props) {
    const has = ks.filter(k => k[p] !== undefined);
    if (!has.length) continue;
    if (f <= has[0].f) { out[p] = has[0][p]; continue; }
    if (f >= has[has.length - 1].f) { out[p] = has[has.length - 1][p]; continue; }
    for (let i = 0; i < has.length - 1; i++) {
      const a = has[i], b = has[i + 1];
      if (f >= a.f && f <= b.f) { out[p] = lerp(a[p], b[p], (f - a.f) / (b.f - a.f || 1)); break; }
    }
  }
  return out;
}

/** Sample an RGBA tiny image (w×h, Uint8ClampedArray) bilinearly at normalized u,v → [r,g,b]. */
export function sampleRGB(data, w, h, u, v) {
  const x = clamp(u * w - 0.5, 0, w - 1), y = clamp(v * h - 0.5, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * w + x0) * 4 + c], b = data[(y0 * w + x1) * 4 + c];
    const cc = data[(y1 * w + x0) * 4 + c], d = data[(y1 * w + x1) * 4 + c];
    out[c] = lerp(lerp(a, b, fx), lerp(cc, d, fx), fy);
  }
  return out;
}

/** Variance of Laplacian on a grayscale Float32Array (sharpness metric). */
export function laplacianVariance(gray, w, h) {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
    s += l; s2 += l * l; n++;
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
export function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Even-numbered processing size with long side ≤ maxSide. */
export function fitSize(w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const e = v => Math.max(2, Math.round((v * s) / 2) * 2);
  return { width: e(w), height: e(h), scale: s };
}
