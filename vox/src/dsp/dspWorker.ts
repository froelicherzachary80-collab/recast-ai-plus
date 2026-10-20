/// <reference lib="webworker" />
/** Off-main-thread DSP (mix rendering, centre extraction, harmonies, edit rendering, analysis). */
import { renderMix } from '../audio/mixer';
import { centerExtract } from '../audio/centerExtract';
import { renderHarmony } from '../pipeline/harmony';
import { renderEdits } from '../pipeline/editRender';
import { estimateBpm, estimateKey, loudness, truePeak } from '../audio/analysis';
import { peak, type Pcm } from '../audio/pcm';
import { resample } from '../audio/resample';

const pcmOut = (p: Pcm) => ({ result: p, transfer: p.channels.map((c) => c.buffer) });

self.onmessage = (e: MessageEvent) => {
  const { id, op, args } = e.data;
  try {
    let r: { result: any; transfer: Transferable[] };
    switch (op) {
      case 'renderMix': { const assets = new Map<string, Pcm>(Object.entries(args.assets)); r = pcmOut(renderMix(args.tracks, assets, args.master, args.range, args.sr, args.opts)); break; }
      case 'centerExtract': { const o = centerExtract(args.mix); r = { result: o, transfer: [...o.vocals.channels, ...o.instrumental.channels].map((c) => c.buffer) }; break; }
      case 'harmony': r = pcmOut(renderHarmony(args.vocal, args.layer, args.key)); break;
      case 'editRender': r = pcmOut(renderEdits(args.pcm, args.tr, args.notes, args.opts)); break;
      case 'resample': r = pcmOut({ sampleRate: args.to, channels: args.pcm.channels.map((c: Float32Array) => resample(c, args.pcm.sampleRate, args.to)) }); break;
      case 'analyze': {
        const p: Pcm = args.pcm, b = estimateBpm(p), k = estimateKey(p), l = loudness(p);
        r = { result: { bpm: b.bpm, bpmConfidence: b.confidence, key: k.name, keyTonic: k.tonic, keyMode: k.mode, keyConfidence: k.confidence, keyAlternatives: k.alternatives, lufs: l.integrated, lra: l.lra, shortTermMax: l.shortTermMax, truePeak: truePeak(p), peak: peak(p) }, transfer: [] };
        break;
      }
      default: throw new Error(`unknown op ${op}`);
    }
    (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: true, result: r.result }, r.transfer);
  } catch (err) { (self as DedicatedWorkerGlobalScope).postMessage({ id, ok: false, msg: (err as Error).message }); }
};
