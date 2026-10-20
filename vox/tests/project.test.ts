import { describe, it, expect } from 'vitest';
import { writeProjectFile, readProjectFile } from '../src/project/projectFile';
import { newProject } from '../src/project/defaults';
import { analyzeVoice } from '../src/audio/voiceAnalysis';
import { convertVocal } from '../src/pipeline/cover';
import { newSinger, SYNTH_CHARACTERS, defaultCover } from '../src/project/defaults';
import { hzToMidi } from '../src/audio/f0';
import { sungTone } from './helpers';

describe('project file', () => {
  it('round-trips settings and bundled audio', async () => {
    const p = newProject('Round trip'), x = sungTone(44100, 0.5, 300);
    p.assets.a1 = { id: 'a1', name: 'v', role: 'vocals', duration: 0.5, sampleRate: 44100, channels: 1, createdAt: 1, provenance: 't' };
    p.tracks[0].assetId = 'a1'; p.cover.transpose = 3;
    const blob = writeProjectFile(p, new Map([['a1', { sampleRate: 44100, channels: [x] }]]), { bundle: true, bits: 24 });
    const r = await readProjectFile(blob);
    expect(r.project.cover.transpose).toBe(3); expect(r.project.tracks[0].assetId).toBe('a1');
    const y = r.assets.get('a1')!.channels[0];
    expect(y.length).toBe(x.length); expect(Math.abs(y[1000] - x[1000])).toBeLessThan(1e-5);
    const lite = await readProjectFile(writeProjectFile(p, new Map(), { bundle: false }));
    expect(lite.assets.size).toBe(0);
  });
});

describe('voice analysis', () => {
  it('reports range and timbre descriptors (analysis only)', () => {
    const a = analyzeVoice([{ sampleRate: 44100, channels: [sungTone(44100, 2, (t) => 196 * Math.pow(2, t / 2))] }]);
    expect(Math.round(a.rangeLowMidi!)).toBeGreaterThanOrEqual(55); expect(Math.round(a.rangeHighMidi!)).toBeLessThanOrEqual(67);
    expect(a.mfccMean.length).toBe(13); expect(a.voicedRatio).toBeGreaterThan(0.8);
  });
});

describe('cover pipeline (DSP character path, no neural model)', () => {
  it('transposes melody and refuses analysis-only singers', async () => {
    const vocal = { sampleRate: 44100, channels: [sungTone(44100, 1.5, 220)] };
    const s = { ...defaultCover(), transpose: 3, expression: 0, unvoicedPreservation: 0, consonantProtection: 0 };
    const r = await convertVocal({ vocal, settings: s, singer: SYNTH_CHARACTERS[0], models: {}, maxLoaded: 1 });
    expect(r.evidence.neural).toBe(false); expect(r.evidence.engine).toMatch(/NOT neural/);
    expect(r.evidence.melodyMedianCentsError!).toBeLessThan(30);
    await expect(convertVocal({ vocal, settings: s, singer: newSinger('x'), models: {}, maxLoaded: 1 })).rejects.toThrow(/analysis profile/);
    void hzToMidi;
  });
});
