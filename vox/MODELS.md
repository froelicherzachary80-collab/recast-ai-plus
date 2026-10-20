# Models & licensing notes

ZMF VOX STUDIO+ bundles **no model weights**. Import `.onnx` files you are licensed to use
(Model Manager → Import, or "Download & cache" from a CORS-enabled URL). Each import is opened
with ONNX Runtime to classify it by its input/output signature; the SHA-256 is stored and can
be re-verified.

URLs could not be fetched or verified from the environment this release was built in, so the
app does not include a pre-approved download list. Check every model's licence yourself.

## Voice conversion (RVC)

| Component | Expected ONNX I/O | Source / licence notes |
|---|---|---|
| RVC generator (v2) | `phone [1,T,768] f32`, `phone_lengths [1] i64`, `pitch [1,T] i64`, `pitchf [1,T] f32`, `ds [1] i64`, `rnd [1,192,T] f32` → `audio [1,1,L]` | Export with RVC WebUI's ONNX export (`infer/modules/onnx/export.py`). RVC code is MIT; **the voice in the weights must be yours or authorised**. |
| RVC generator (v1) | as above with `phone [1,T,256]` | needs a 256-d content encoder |
| Content encoder | `source [1,N]` or `[1,1,N]` @16 kHz → `[1,T,768]` (v2) / `[1,T,256]` (v1) @50 fps | ContentVec (MIT) / HuBERT-base (MIT) exported to ONNX; e.g. the `vec-768-layer-12` export used by so-vits-svc / RVC tooling |

Not implemented: faiss `.index` feature retrieval, RMVPE/CREPE F0 models (YIN is built in),
non-f0 models can run but cannot follow sung pitch.

## Separation (MDX-Net)

| Model family | Parameters (choose in AI Cover Studio) | Licence notes |
|---|---|---|
| UVR-MDX-NET Inst HQ | n_fft 6144, dim_f 3072, dim_t 256, primary = instrumental | UVR models are distributed by the UVR project; check each model card |
| Kim Vocal / Voc_FT | n_fft 7680, dim_f 3072, dim_t 256, primary = vocals | |
| UVR-MDX-NET Main | n_fft 4096, dim_f 2048, dim_t 256 | |

`dim_f` / `dim_t` are read from the model when it declares fixed shapes. Some models need a
compensation factor; the default is 1.0.

## Runtime and libraries

| Dependency | Licence |
|---|---|
| onnxruntime-web | MIT |
| React | MIT |
| @breezystack/lamejs (MP3 encoder) | LGPL-3.0 (unmodified library, separate module) |
| Vite, TypeScript, Vitest, playwright-core (dev only) | MIT / Apache-2.0 |

## Test fixtures

All test audio is synthesised by the test code (`tests/fixtures.ts`, `tests/helpers.ts`); the
ONNX files used in tests are tiny synthetic graphs generated at test time — they are not voice
models and contain no third-party data.
