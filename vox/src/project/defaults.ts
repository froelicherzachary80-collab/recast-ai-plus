import { defaultMaster, makeTrack } from '../audio/mixer';
import { presetParams } from '../audio/humanvoice';
import type { CoverSettings, Project, Singer, QualityMode } from './types';

export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const QUALITY: Record<Exclude<QualityMode, 'CUSTOM'>, Pick<CoverSettings, 'chunkSec' | 'overlapSec' | 'contextSec' | 'previewSec'>> = {
  LIGHT: { chunkSec: 4, overlapSec: 0.15, contextSec: 0.25, previewSec: 10 },
  BALANCED: { chunkSec: 8, overlapSec: 0.25, contextSec: 0.5, previewSec: 15 },
  HIGH: { chunkSec: 15, overlapSec: 0.4, contextSec: 1.0, previewSec: 20 },
};

export const defaultCover = (): CoverSettings => ({
  transpose: 0, autoOctave: false, rangeLow: 48, rangeHigh: 72, voiceBlend: 1, stability: 0.66, pitchCorrection: 0, vibrato: 1, microVariation: 0,
  formant: 1, expression: 0.6, consonantProtection: 0.3, unvoicedPreservation: 0.2, hvPreset: 'Natural Studio', hv: presetParams('Natural Studio'),
  quality: 'BALANCED', ...QUALITY.BALANCED, backend: 'webgpu',
});

export function newProject(name = 'Untitled cover'): Project {
  return { id: uid('prj'), name, createdAt: Date.now(), updatedAt: Date.now(), sampleRate: 44100, assets: {},
    tracks: [makeTrack('original', 'Original vocal', null), makeTrack('converted', 'Converted vocal', null), makeTrack('instrumental', 'Instrumental', null)],
    master: defaultMaster(), cover: defaultCover(), singerId: null, analysis: null, notes: [], editAssetId: null, harmonies: [], syntheticLabel: true, log: [] };
}

export function newSinger(name = 'New singer'): Singer {
  return { id: uid('sgr'), name, avatar: null, description: '', voiceType: 'Tenor', rangeLow: 48, rangeHigh: 72, defaultStyle: 'Natural Studio', presentation: 'Unspecified',
    mode: 'analysis-only', voiceModelId: null, contentModelId: null, speakerId: 0, dspCharacter: { formant: 1, transpose: 0 }, analysis: null, sampleAssetIds: [],
    preset: {}, recentProjects: [], permission: null, createdAt: Date.now(), updatedAt: Date.now(), synthetic: true };
}

/** Built-in original synthetic DSP characters (not neural, not based on any real person). */
export const SYNTH_CHARACTERS: Singer[] = [
  { ...newSinger('VOX-A (DSP character, higher formants)'), id: 'builtin_voxa', mode: 'dsp-character', dspCharacter: { formant: 1.12, transpose: 0 }, description: 'Original DSP voice character: formants raised ~12% with PSOLA. Not a neural voice.', voiceType: 'Synthetic' },
  { ...newSinger('VOX-B (DSP character, deeper formants)'), id: 'builtin_voxb', mode: 'dsp-character', dspCharacter: { formant: 0.9, transpose: 0 }, description: 'Original DSP voice character: formants lowered ~10%. Not a neural voice.', voiceType: 'Synthetic' },
];
