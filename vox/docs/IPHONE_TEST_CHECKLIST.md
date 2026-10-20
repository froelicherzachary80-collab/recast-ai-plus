# iPhone 16 Pro / Safari 26 test checklist

Status: **NOT YET VERIFIED** on device. Fill in results (✅/❌ + notes, timings) and commit.

Device: ______  iOS: ______  Safari: ______  Installed as PWA: yes / no

## Setup
- [ ] Open the deployed URL in Safari; Settings → capabilities show WebGPU adapter: ______
- [ ] Share → Add to Home Screen; app opens standalone
- [ ] Settings → Request persistent storage → reports persistent: ______

## Acceptance
1. [ ] Import a real MP3 (Files app) — duration/SR/channels correct
2. [ ] Import a real WAV
3. [ ] Playback works (with silent switch off), meters move
4. [ ] Waveform matches audible content (silences/peaks line up); pinch-zoom works
5. [ ] Neural separation with an MDX-Net model: stems audible and different. Time for 15 s preview: ______ ; full song: ______ ; backend: ______
6. [ ] Load an authorised RVC v2 model + ContentVec encoder; singer shows "neural RVC"
7. [ ] Convert a 15 s preview — evidence panel: backend ______, time ______, NRMS diff ______, melody error ______ cents
8. [ ] Audible timbre change vs source (A/B)
9. [ ] Melody preserved (by ear + evidence)
10. [ ] Render cover mix with instrumental
11. [ ] DSP effect audibly applied (e.g. reverb send)
12. [ ] Export WAV → Save to Files → plays in Files/Music
13. [ ] Export MP3 → plays
14. [ ] Close app, reopen → project restored
15. [ ] Airplane mode → reopen app → loads, project & models available, conversion still runs
16. [ ] Settings → Privacy shows 0 requests with a body
17. [ ] WebGPU vs WASM: run the same preview on both; record times / failures
18. [ ] Full 3–4 min song: peak memory behaviour (does the tab reload?), with and without Memory-saving

## Notes / failures
