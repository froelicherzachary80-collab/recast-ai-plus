# Mobile limitations & troubleshooting

## Known limitations (honest list)

- **iPhone testing has not been performed yet.** Everything below about iOS is based on
  platform behaviour, not measurements from this app. Use the checklist and report results.
- **Background processing:** iOS suspends Safari tabs/PWAs in the background. Keep the app in
  the foreground during separation/conversion. Finished results are saved; an interrupted job
  must be restarted (use *Retry*).
- **Memory:** Safari tabs on iPhone are killed at roughly 1.5–3 GB. Full-song stereo buffers
  are ~10 MB/minute/channel at 32-bit float, and DSP stages make copies. For long songs:
  enable *Memory-saving mode*, choose LIGHT quality, use preview ranges, and export segments.
- **Real-time:** inference is offline rendering, not real time. Mixer playback renders the
  selected range first.
- **WebGPU:** availability and operator coverage vary. ONNX Runtime falls back per-operator to
  WASM within a session, and the app falls back to a WASM-only session if WebGPU session
  creation fails. You can force WASM in Settings.
- **Threads:** multi-threaded WASM needs cross-origin isolation (COOP/COEP headers). Without them
  ONNX Runtime runs single-threaded — slower but functional.
- **Storage eviction:** Safari can clear website data that isn't used for a while. Install the
  PWA to the Home Screen and tap *Request persistent storage* in Settings; keep `.zvox` backups.
- **No faiss index**, no zero-shot conversion, no on-device training (see README).
- **DSP fallbacks** (centre extraction, DSP characters, harmonies) are clearly labelled and are
  not neural.
- Per-chunk processing is cancellable; a failed job can be retried as a whole (per-chunk
  resume is not implemented).

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| "ONNX Runtime could not load this file" | Not an ONNX model (e.g. `.pth`). Export to ONNX first. |
| Model detected as *unknown* | Input names differ from the RVC/ContentVec/MDX signatures. Override the kind in Model Manager only if you know it matches. |
| "Content model outputs 768-dim … voice model expects 256" | v1 RVC model with a v2 encoder. Use a 256-d encoder. |
| Worker crashed / page reloads during a job | Out of memory. Memory-saving mode, LIGHT quality, shorter range. |
| WebGPU errors | Settings → WASM only. |
| Stems "nearly identical" | The separation model's primary stem setting is wrong or the model failed; try the other preset or supply stems. |
| Melody error high in evidence panel | Wrong transpose / octave; enable auto-octave with the singer's range. |
| Audio doesn't play on iPhone | Tap Play again (iOS requires a gesture to start audio); check the silent switch. |
| Export doesn't download on iPhone | The share sheet opens instead — choose *Save to Files*. |
