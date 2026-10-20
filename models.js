// RECAST AI+ — model registry, explicit download/import, IndexedDB cache, MediaPipe task creation.
import { db } from './db.js';

export const TASKS_VERSION = '0.10.14';
const TASKS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const TASKS_ESM = [`${TASKS_BASE}/+esm`, `${TASKS_BASE}/vision_bundle.mjs`];
const TASKS_WASM = `${TASKS_BASE}/wasm`;
const G = 'https://storage.googleapis.com/mediapipe-models';

export const MODELS = [
  { key: 'pose_lite', name: 'Pose Landmarker Lite', feature: 'Multi-person body landmarks (33 pts), actor detection & Body MotionLock', url: `${G}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`, approx: '≈ 5.5 MB', license: 'Apache-2.0 (MediaPipe model card)', required: true },
  { key: 'pose_full', name: 'Pose Landmarker Full', feature: 'More accurate body landmarks (used by Mobile Quality / High Quality presets when installed)', url: `${G}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`, approx: '≈ 9 MB', license: 'Apache-2.0 (MediaPipe model card)' },
  { key: 'face', name: 'Face Landmarker', feature: '478-point face mesh, expressions & head pose (Face MotionLock, reference analysis)', url: `${G}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`, approx: '≈ 3.6 MB', license: 'Apache-2.0 (MediaPipe model card)', required: true },
  { key: 'hand', name: 'Hand Landmarker', feature: 'Hand landmarks for Gesture MotionLock overlay', url: `${G}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`, approx: '≈ 7.5 MB', license: 'Apache-2.0 (MediaPipe model card)' },
  { key: 'selfie', name: 'Selfie Segmenter', feature: 'Person masks: garment clipping & mask inspection', url: `${G}/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`, approx: '≈ 0.25 MB', license: 'Apache-2.0 (MediaPipe model card)' },
  { key: 'demucs', kind: 'onnx', name: 'HTDemucs stem separator', feature: 'Splits a video’s sound into character voices, song vocals and music (Dub Studio)', url: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx', approx: '≈ 172 MB', license: 'MIT (Meta HTDemucs; ONNX export by demucs-web)' },
  { key: 'multiclass', name: 'Selfie Multiclass 256', feature: 'Hair / skin / clothes classes: hair extraction & clothing recolor', url: `${G}/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`, approx: '≈ 16 MB', license: 'Apache-2.0 (MediaPipe model card)' },
];
export const UNAVAILABLE_MODELS = [
  { name: 'Local inpainting (background reconstruction)', why: 'No inpainting model has been validated on Safari/iPhone for this build. Upload-a-clean-plate is also V0.2.' },
  { name: 'Garment generation from text', why: 'No local image-generation model is installed or validated on-device. The text field stays disabled.' },
  { name: 'Whisper speech-to-text (Transformers.js)', why: 'Used by Dub Studio. Downloads from Hugging Face the first time you tap Transcribe (tiny ≈ 40 MB, base ≈ 80 MB) and is cached by the browser. Not managed on this screen.', available: true },
  { name: 'In-app voice cloning TTS (Pocket TTS, Chatterbox)', why: 'Browser builds exist but are unverified on iPhone Safari (Chatterbox is ~1.5 GB and marked Safari in-progress by its web port). For now: record your lines, or generate a cloned line in a local tool and import it per line.' },
  { name: 'Wan 2.2 Animate–style diffusion video', why: 'Needs an ~80 GB-class data-center GPU. RECAST uses a pose-driven full-body rig instead.' },
];

let visionMod = null, fileset = null, visionErr = null;
export const runtime = { tasks: {}, delegate: {}, errors: {} };

export async function loadVision() {
  if (fileset) return visionMod;
  let lastErr;
  for (const url of TASKS_ESM) {
    try { visionMod = await import(/* @vite-ignore */ url); break; } catch (e) { lastErr = e; }
  }
  if (!visionMod) { visionErr = lastErr; throw new Error('Could not load MediaPipe Tasks Vision from jsDelivr: ' + (lastErr?.message || lastErr)); }
  fileset = await visionMod.FilesetResolver.forVisionTasks(TASKS_WASM);
  return visionMod;
}

export async function modelStatus() {
  const rows = await db.all('models');
  const m = {}; for (const r of rows) m[r.id] = { size: r.size, savedAt: r.savedAt, source: r.source };
  return m;
}
export async function hasModel(key) { return !!(await db.get('models', key)); }

export async function downloadModel(key, onProgress) {
  const def = MODELS.find(m => m.key === key);
  const res = await fetch(def.url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${new URL(def.url).host}`);
  const total = +res.headers.get('content-length') || 0;
  let bytes;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader(), chunks = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress?.(got, total); }
    bytes = new Uint8Array(got); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
  } else bytes = new Uint8Array(await res.arrayBuffer());
  await db.put('models', { id: key, bytes, size: bytes.length, savedAt: Date.now(), source: def.url });
  disposeTask(key);
  return bytes.length;
}
export async function importModel(key, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 1000) throw new Error('That file is too small to be a model.');
  await db.put('models', { id: key, bytes, size: bytes.length, savedAt: Date.now(), source: 'Imported: ' + file.name });
  disposeTask(key);
}
export async function deleteModel(key) { disposeTask(key); await db.del('models', key); }

export function disposeTask(key) {
  for (const k of Object.keys(runtime.tasks)) if (k.startsWith(key + ':')) { try { runtime.tasks[k].close(); } catch {} delete runtime.tasks[k]; }
}
export function disposeAll() { for (const k of Object.keys(runtime.tasks)) { try { runtime.tasks[k].close(); } catch {} delete runtime.tasks[k]; } }

async function bytesFor(key) {
  const rec = await db.get('models', key);
  if (!rec) throw new Error(`Model "${MODELS.find(m => m.key === key)?.name || key}" is not installed. Install it in Model Manager.`);
  return rec.bytes;
}

/** Create (or reuse) a MediaPipe task. kind: pose|face|hand|seg. mode: VIDEO|IMAGE. Tries GPU then CPU. */
export async function getTask(key, mode = 'VIDEO', extra = {}) {
  const id = `${key}:${mode}:${JSON.stringify(extra)}`;
  if (runtime.tasks[id]) return runtime.tasks[id];
  const V = await loadVision();
  const buf = await bytesFor(key);
  const make = async (delegate) => {
    const baseOptions = { modelAssetBuffer: buf, delegate };
    if (key.startsWith('pose')) return V.PoseLandmarker.createFromOptions(fileset, { baseOptions, runningMode: mode, numPoses: extra.num ?? 4, minPoseDetectionConfidence: 0.45, minPosePresenceConfidence: 0.45, minTrackingConfidence: 0.45, outputSegmentationMasks: false });
    if (key === 'face') return V.FaceLandmarker.createFromOptions(fileset, { baseOptions, runningMode: mode, numFaces: extra.num ?? 4, minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false });
    if (key === 'hand') return V.HandLandmarker.createFromOptions(fileset, { baseOptions, runningMode: mode, numHands: 4 });
    if (key === 'selfie' || key === 'multiclass') return V.ImageSegmenter.createFromOptions(fileset, { baseOptions, runningMode: mode, outputConfidenceMasks: true, outputCategoryMask: false });
    throw new Error('Unknown model ' + key);
  };
  let task;
  try { task = await make('GPU'); runtime.delegate[key] = 'GPU (WebGL)'; }
  catch (e) {
    runtime.errors[key + ':gpu'] = String(e?.message || e);
    task = await make('CPU'); runtime.delegate[key] = 'CPU (WebAssembly)';
  }
  runtime.tasks[id] = task;
  return task;
}

let tsCounter = 0;
/** MediaPipe VIDEO mode requires strictly increasing timestamps across calls. */
export const nextTs = () => (tsCounter += 33.34);

/** Run a segmenter and return per-class Float32 masks copied out (safe after callback). */
export function segment(task, image, mode = 'VIDEO', classes = [0]) {
  let out = null;
  const cb = (r) => {
    const masks = r.confidenceMasks || [];
    out = { width: masks[0]?.width || 0, height: masks[0]?.height || 0, masks: classes.map(c => { const m = masks[c < 0 ? masks.length + c : c]; return m ? m.getAsFloat32Array().slice() : null; }) };
  };
  const r = mode === 'VIDEO' ? task.segmentForVideo(image, nextTs(), cb) : task.segment(image, cb);
  if (!out && r && r.confidenceMasks) cb(r);
  try { r?.close?.(); } catch {}
  return out;
}
