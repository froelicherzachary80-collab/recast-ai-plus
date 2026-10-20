import type { Track, MasterSettings } from '../audio/mixer';
import type { Note } from '../audio/notes';
import type { HumanVoiceParams } from '../audio/humanvoice';

export type AssetRole = 'mix' | 'vocals' | 'instrumental' | 'converted-dry' | 'converted' | 'harmony' | 'sample' | 'edited' | 'layer' | 'render';
export interface AssetInfo { id: string; name: string; role: AssetRole; duration: number; sampleRate: number; channels: number; createdAt: number; provenance: string; }

export type QualityMode = 'LIGHT' | 'BALANCED' | 'HIGH' | 'CUSTOM';

export interface CoverSettings {
  transpose: number; autoOctave: boolean; rangeLow: number; rangeHigh: number;
  voiceBlend: number; stability: number; pitchCorrection: number; vibrato: number; microVariation: number;
  formant: number; expression: number; consonantProtection: number; unvoicedPreservation: number;
  hvPreset: string; hv: HumanVoiceParams;
  quality: QualityMode; chunkSec: number; overlapSec: number; contextSec: number; previewSec: number;
  backend: 'webgpu' | 'wasm';
}

export interface HarmonyLayer { id: string; name: string; mode: 'semitones' | 'diatonic'; interval: number; gainDb: number; pan: number; delayMs: number; humanize: number; formant: number; trackId?: string; assetId?: string; }

export interface AnalysisInfo { duration: number; sampleRate: number; channels: number; peakDb: number; bpm: number; bpmConfidence: number; key: string; keyConfidence: number; keyAlternatives: string[]; lufs: number; truePeakDb: number; }

export interface Project {
  id: string; name: string; createdAt: number; updatedAt: number; sampleRate: number;
  assets: Record<string, AssetInfo>;
  tracks: Track[]; master: MasterSettings;
  cover: CoverSettings; singerId: string | null;
  analysis: AnalysisInfo | null;
  notes: Note[]; editAssetId: string | null;
  harmonies: HarmonyLayer[];
  syntheticLabel: boolean;
  log: { t: number; msg: string }[];
}

export interface VoiceAnalysis {
  durationSec: number; rangeLowMidi: number | null; rangeHighMidi: number | null; medianMidi: number | null;
  centroidHz: number; lufs: number; voicedRatio: number; mfccMean: number[]; sampleCount: number; analyzedAt: number;
}

export type SingerMode = 'neural-rvc' | 'dsp-character' | 'analysis-only';

export interface Singer {
  id: string; name: string; avatar: string | null; description: string; voiceType: string;
  rangeLow: number; rangeHigh: number; defaultStyle: string; presentation: string;
  mode: SingerMode; voiceModelId: string | null; contentModelId: string | null; speakerId: number;
  dspCharacter: { formant: number; transpose: number };
  analysis: VoiceAnalysis | null; sampleAssetIds: string[];
  preset: Partial<CoverSettings>; recentProjects: string[];
  permission: { confirmed: boolean; statement: string; at: number } | null;
  createdAt: number; updatedAt: number; synthetic: true;
}
