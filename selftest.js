// RECAST AI+ — in-browser self tests (run from Settings). Each reports pass/fail with evidence.
import { db } from './db.js';
import { VideoWriter, probe, FrameGrabber, makePlan } from './media.js';
import { FaceRenderer } from './facerender.js';
import { hasModel, getTask } from './models.js';

export async function runSelfTests(log) {
  const results = [];
  const run = async (name, fn) => {
    const t0 = performance.now();
    try { const detail = await fn(); results.push({ name, ok: true, detail, ms: performance.now() - t0 }); }
    catch (e) { results.push({ name, ok: false, detail: String(e?.message || e), ms: performance.now() - t0 }); }
    log?.(results[results.length - 1]);
  };

  await run('Project persistence (IndexedDB write → read)', async () => {
    const id = 'selftest-' + Date.now(), blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
    await db.put('kv', { id, n: 42, blob, arr: new Float32Array([1.5, 2.5]) });
    const r = await db.get('kv', id); await db.del('kv', id);
    if (r?.n !== 42 || r.arr[1] !== 2.5 || (await r.blob.arrayBuffer()).byteLength !== 4) throw new Error('Round-trip mismatch');
    return 'record, Blob and Float32Array survived';
  });

  let encoded = null;
  await run('Video encoding (synthetic 2 s clip → MP4)', async () => {
    const W = 320, H = 240, fps = 15, N = 30;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
    const plan = { width: W, height: H, fps, frames: N, start: 0, end: N / fps };
    const w = new VideoWriter(c, plan); await w.start({ includeAudio: false });
    for (let i = 0; i < N; i++) {
      ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = i < N / 2 ? '#ff0000' : '#00ff00'; ctx.fillRect(40 + i * 4, 60, 100, 100);
      await w.addFrame(i);
    }
    const out = await w.finish();
    encoded = { blob: out.blob, plan, ext: out.ext };
    return `${(out.blob.size / 1024).toFixed(1)} KB ${out.mime} via ${w.mode} (${out.codec})`;
  });

  await run('Video decoding + frame check (reopen encoded clip)', async () => {
    if (!encoded) throw new Error('No encoded clip (previous test failed)');
    const f = new File([encoded.blob], 'selftest.' + encoded.ext, { type: encoded.blob.type });
    const meta = await probe(f);
    const plan = makePlan(meta, null, 'preview');
    const g = await new FrameGrabber(f, meta, plan).init();
    const sample = async (k, x, y) => { const c = await g.get(k); const d = c.getContext('2d').getImageData(Math.round(x * c.width / 320), Math.round(y * c.height / 240), 1, 1).data; return [d[0], d[1], d[2]]; };
    const early = await sample(2, 40 + 2 * 4 + 50, 110), late = await sample(25, 40 + 25 * 4 + 50, 110);
    g.dispose();
    if (!(early[0] > 150 && early[1] < 100)) throw new Error(`frame 2 expected red, got rgb(${early})`);
    if (!(late[1] > 150 && late[0] < 100)) throw new Error(`frame 25 expected green, got rgb(${late})`);
    return `duration ${meta.duration.toFixed(2)} s, ${meta.width}×${meta.height}, ${meta.engine}; frame colors match`;
  });

  await run('Recast layer composition (WebGL mesh warp)', async () => {
    const fr = new FaceRenderer(64, 64);
    const bg = document.createElement('canvas'); bg.width = bg.height = 64; const bctx = bg.getContext('2d'); bctx.fillStyle = '#000'; bctx.fillRect(0, 0, 64, 64);
    const tex = document.createElement('canvas'); tex.width = tex.height = 8; const tctx = tex.getContext('2d'); tctx.fillStyle = '#0000ff'; tctx.fillRect(0, 0, 8, 8);
    const t = fr.texture('t', tex);
    fr.render(bg, [{ tex: t, pos: new Float32Array([10, 10, 54, 10, 54, 54, 10, 54]), uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), alpha: new Float32Array([1, 1, 1, 1]), gain: new Float32Array(12).fill(1), idx: new Uint16Array([0, 2, 1, 0, 3, 2]), opacity: 1, grain: 0, sat: 1 }]);
    const o = document.createElement('canvas'); o.width = o.height = 64; const octx = o.getContext('2d'); octx.drawImage(fr.canvas, 0, 0);
    const inside = octx.getImageData(32, 32, 1, 1).data, outside = octx.getImageData(3, 3, 1, 1).data;
    fr.dispose();
    if (!(inside[2] > 200 && inside[0] < 40)) throw new Error(`warped pixel not blue: rgb(${inside[0]},${inside[1]},${inside[2]})`);
    if (outside[2] > 40) throw new Error('background was overwritten outside the mesh');
    return 'mesh pixels replaced, background preserved';
  });

  for (const [key, label] of [['pose_lite', 'Landmark model init (Pose)'], ['face', 'Landmark model init (Face)'], ['selfie', 'Segmentation model init']]) {
    await run(label, async () => {
      if (!(await hasModel(key))) throw new Error('Not installed (install it in Model Manager to test)');
      const task = await getTask(key, 'IMAGE');
      const c = document.createElement('canvas'); c.width = c.height = 128; c.getContext('2d').fillRect(0, 0, 128, 128);
      const t0 = performance.now();
      if (key === 'selfie') task.segment(c, () => {}); else task.detect(c);
      return `ran on a blank frame in ${(performance.now() - t0).toFixed(0)} ms (no people expected)`;
    });
  }
  return results;
}
