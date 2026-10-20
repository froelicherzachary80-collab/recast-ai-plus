// RECAST AI+ — render job: decode → compose → encode, with real progress, cancel, and preview frames.
import { iterateFrames, VideoWriter } from './media.js';
import { prepareRuntime, composeFrame, disposeRuntime } from './compositor.js';

const toBlob = (c, q = 0.72, maxSide = 540) => {
  const s = Math.min(1, maxSide / Math.max(c.width, c.height));
  const t = document.createElement('canvas'); t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  return new Promise(r => t.toBlob(r, 'image/jpeg', q));
};

/** opts: {range:[a,b], encode:boolean, disclosure, includeAudio, signal, onProgress, onFrame} */
export async function renderProject(project, ctx, opts) {
  const { file, meta, profiles, wardrobe, analysis, motionParams } = ctx;
  const plan = project.plan;
  const [a, b] = opts.range || [0, plan.frames - 1];
  const rt = await prepareRuntime(project, { profiles, wardrobe, analysis, motionParams, plate: ctx.plate, background: ctx.background, lips: ctx.lips || null });
  const result = { previews: new Map(), originals: new Map(), stats: { faces: 0, garments: 0, hair: 0, recolor: 0, frames: 0 }, warnings: [...rt.warnings], range: [a, b] };
  if (plan.photo) {
    // Poster / photo: one full-resolution composite, exported as PNG (lossless) or JPEG.
    try {
      const t0 = performance.now();
      let src = null;
      for await (const f of iterateFrames(file, meta, plan, {})) src = f.canvas;
      const r = composeFrame(rt, src, 0, { disclosure: opts.disclosure });
      Object.assign(result.stats, r.stats); result.stats.frames = 1;
      const fmt = opts.imageFormat === 'jpeg' ? ['image/jpeg', 'jpg', 'JPEG'] : ['image/png', 'png', 'PNG'];
      const blob = await new Promise(res => rt.work.toBlob(res, fmt[0], 0.95));
      if (!blob) throw new Error('The browser could not encode the image (canvas too large?).');
      result.previews.set(0, await toBlob(rt.work, 0.85, 1600)); result.originals.set(0, await toBlob(src, 0.85, 1600));
      result.output = { blob, mime: fmt[0], ext: fmt[1], codec: `${fmt[2]} ${plan.width}×${plan.height}` };
      result.notes = []; result.seconds = (performance.now() - t0) / 1000;
      opts.onProgress?.(1, 1, { fps: 0 });
      return result;
    } finally { disposeRuntime(rt); }
  }
  let writer = null;
  if (opts.encode) {
    writer = new VideoWriter(rt.work, plan);
    await writer.start({ audioFile: file, meta, includeAudio: opts.includeAudio !== false, audioBuffer: ctx.audioBuffer || null });
  }
  const t0 = performance.now();
  try {
    let done = 0; const total = b - a + 1;
    const sub = opts.encode ? plan : { ...plan, start: plan.start + a / plan.fps, frames: total };
    for await (const { index, canvas } of iterateFrames(file, meta, sub, { signal: opts.signal })) {
      if (opts.signal?.aborted) break;
      const k = opts.encode ? index : index + a;
      const restoreAll = (project.restore || []).some(([x, y]) => k >= x && k <= y);
      const r = composeFrame(rt, canvas, k, { disclosure: opts.disclosure, restoreAll });
      for (const key of Object.keys(r.stats)) result.stats[key] += r.stats[key];
      result.stats.frames++;
      if (writer) await writer.addFrame(k);
      if (k >= a && k <= b) {
        result.previews.set(k, await toBlob(rt.work));
        result.originals.set(k, await toBlob(canvas));
      }
      done++;
      opts.onProgress?.(done, opts.encode ? plan.frames : total, { fps: done / ((performance.now() - t0) / 1000), k });
      if (done % 2 === 0) await new Promise(res => setTimeout(res, 0));
    }
    if (opts.signal?.aborted) { await writer?.cancel(); result.cancelled = true; return result; }
    if (writer) {
      opts.onProgress?.(plan.frames, plan.frames, { phase: 'finalizing' });
      const out = await writer.finish((i, n) => opts.onProgress?.(i, n, { phase: 'recording' }));
      result.output = out; result.notes = writer.notes;
    }
    result.seconds = (performance.now() - t0) / 1000;
    return result;
  } finally { disposeRuntime(rt); }
}
