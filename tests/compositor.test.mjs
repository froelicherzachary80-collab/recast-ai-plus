import test from 'node:test';
import assert from 'node:assert/strict';
import { garmentGrid, DEFAULT_ENTRY, KEY_PROPS } from '../compositor.js';
import { bilinear } from '../geometry.js';

test('garment grid: anchor corners land on uv (0,0),(1,0),(1,1),(0,1)', () => {
  const g = { anchors: [[0.2, 0.1], [0.8, 0.1], [0.78, 0.96], [0.22, 0.96]] };
  const grid = garmentGrid(g, 1000, 1000, 'top', 10);
  const find = (x, y) => grid.pts.find(p => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6);
  // grid points at image corners extrapolate outside [0,1]
  const tl = find(0, 0).uv; assert.ok(tl[0] < 0 && tl[1] < 0);
  // a point at the anchor TL maps to ~ (0,0): reconstruct via bilinear
  const A = g.anchors.map(([x, y]) => [x * 1000, y * 1000]);
  for (const p of grid.pts) { const [x, y] = bilinear(A, p.uv[0], p.uv[1]); assert.ok(Math.abs(x - p.x) < 1e-3 && Math.abs(y - p.y) < 1e-3); }
  assert.equal(grid.pts.length, 121);
});

test('default cast entry carries every keyframable prop', () => {
  const e = DEFAULT_ENTRY();
  for (const k of KEY_PROPS) assert.ok(k in e.transform, k);
  assert.ok(e.face.keepMouth);
});

test('outfit checkbox: new entries keep the original outfit; legacy entries keep old behavior', async () => {
  const { outfitOn } = await import('../compositor.js');
  assert.equal(outfitOn(DEFAULT_ENTRY()), false);
  assert.equal(outfitOn({}), true);
  assert.equal(outfitOn({ outfit: { on: true } }), true);
  assert.equal(DEFAULT_ENTRY().hair.on, false);
});
