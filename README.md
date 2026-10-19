# RECAST AI+ — v0.1 (Private Cinematic Recast Edition)

A local, private actor-replacement studio that runs entirely in the browser. Import a clip, pick an actor, add photos of yourself (or a consenting friend), and RECAST tracks the original performance frame by frame and composites your face, hair and garments onto it, then exports an MP4.

No server, no account, no paid API. All media stays in the browser's IndexedDB on your device.


## What's new in v0.3 — Pose Studio
Your full-body photo becomes a posable model (tab **Pose**):
- **Pose by dragging** joints. Elbows and knees swing a limb, wrists and ankles bend it with two-bone IK, the neck leans the torso (hips stay planted), the head dot turns the head, the green dot moves the whole body. Bone lengths always stay yours. Size, mirror, reset, and a saved-poses library.
- **Copy a pose from any photo** of a person.
- **Dances:** keyframe your own (smooth or linear easing, looping), start from presets (Wave, Arms-up cheer, Side-step groove, Jumping jacks, Disco point, Robot), or **learn a dance from any video**: the dancer's pose is tracked frame by frame and retargeted onto your proportions. Learned dances can be converted to editable keyframes.
- **Stage:** portrait, square or landscape; colour, photo or looping video background; soft ground shadow.
- **Export:** PNG image of the current pose, or MP4 of the dance at 30 fps with your music or the dance video's original sound.
- Limits: it is a 2D model of one photo. Side and back views, crossed limbs, hands and loose clothing do not change shape like a real body.

## What's new in v0.2
- **Full-Body Animate** (new mode, experimental). Inspired by Wan Animate's character replacement, but running on your phone: the full-body photo in your character profile is cut out, meshed and rigged to 10 bones from your own pose, then driven every frame by the actor's tracked shoulders, elbows, wrists, hips, knees and ankles (linear blend skinning in WebGL). Your face replacement and hair sit on top.
  - **Keep the original scene:** a *clean plate* (built from frames where the background was visible, or uploaded) paints out the original actor before your body is drawn. Building works for tripod shots.
  - **New background:** solid colour or your own image.
  - It is 2D warping of one photo: turning around, crossed limbs, fingers and loose clothing are not simulated. Real Wan 2.2 Animate needs an ~80 GB-class data-center GPU, which no phone has.
- **Dub Studio** (new step between Editor and Render). Your voice replaces the actor's lines:
  - Find lines with **Whisper** (Transformers.js, on-device after a one-time ~40–80 MB download) or with voice-activity detection (no download), or add them by hand.
  - **Teleprompter recording** per line: listen to the original, 3-beep countdown, record while a bar fills.
  - Each take is silence-trimmed, **time-fitted with WSOLA** (pitch preserved, 0.7–1.4× limit with a warning) and level-matched so it lands where the actor's mouth moves.
  - Original voice inside dubbed lines: lower it, mute it, or remove the centre-panned voice (stereo).
  - Room reverb, tone matching, preview with picture, WAV export, and the render uses the dub as the soundtrack.
  - **Voice cloning:** in-app cloning TTS is not built in yet. Browser engines exist (Kyutai Pocket TTS ports, Chatterbox via Transformers.js), but none is verified on iPhone Safari. You can generate a line in a local cloning tool and **Import audio** for that line; it is fitted the same way. Only use voices of people who agreed.
- Mipmapped textures now honour transparency (needed for the body cutout).

## What's new in v0.1.1
- **Photos and posters.** Import a JPEG/PNG/HEIC instead of a video. RECAST detects the actors, replaces the face (and optionally hair/outfit) at full resolution up to 3072px, and exports a PNG or JPEG poster. Same editor tools: compare, keyframes, restore brush, verify.
- **Hair & outfit checkboxes.** When creating a project (and per actor in Cast Director and the editor):
  - *Change hair to my hairstyle* — unchecked keeps the original actor's hair.
  - *Change outfit* — unchecked keeps the original actor's outfit exactly as filmed (default). Checked enables garment overlays and clothing recolor.
- **Detail match** (Editor → Face): mipmapped reference textures with a level-of-detail bias, so a sharp phone selfie blends with softer film/video footage instead of looking pasted on.

---

## 1. What is in this folder

```
index.html              app shell (PWA)
styles.css              dark studio UI
manifest.webmanifest    install-to-Home-Screen metadata
sw.js                   offline cache (app shell + MediaPipe/Mediabunny runtime)
icon.svg, icon-*.png    app icons
app.js        13 screens, routing, render queue
ui.js         tiny DOM toolkit
db.js         IndexedDB persistence
models.js     model registry, explicit download/import, MediaPipe task creation (GPU → CPU fallback)
media.js      probe, decode (Mediabunny/WebCodecs, <video> fallback), MP4 encode (Mediabunny, MediaRecorder fallback), audio, export verification
analysis.js   per-frame Pose + Face (+ Hand) inference and identity tracking
tracker.js    multi-person tracker, swap/merge identity corrections
smoothing.js  MotionLock: One Euro filter, gap bridging, jitter metrics
geometry.js   Delaunay, similarity/affine/bilinear maps, keyframes, color math
facemesh.js   face topology, face mesh build
profile.js    reference-photo analysis, quality scoring, hair extraction
facerender.js WebGL2 mesh-warp face renderer with per-vertex feather and color/light gains
compositor.js per-frame recast: garments, clothing recolor, face, hair, restore brush, disclosure label
render.js     render job (decode → compose → encode), progress, cancel, previews
caps.js       device capability test
selftest.js   in-browser pipeline self-tests
tests/          Node unit tests for the pure logic
```

There is **no build step**. The app is plain ES modules. Third-party code loads at runtime from jsDelivr: `@mediapipe/tasks-vision@0.10.14` (+ its WASM) and `mediabunny@1`. Models download from Google's MediaPipe storage when you tap Install.

> **Why not React/TypeScript/Vite/Tailwind as specified?** The build machine for this version had no access to the npm registry, so nothing could be installed or compiled. Rather than ship untested build config, v0.1 is dependency-free vanilla JS that runs as-is on any static host. Porting the UI to React + TS + Vite is item 1 on the V0.2 roadmap; the engine modules (every `.js` file other than `app.js`/`ui.js`) are framework-agnostic and port directly.

---

## 2. Run locally

Any static server works. It must be served over `http://localhost` or `https://` (module scripts, WebCodecs and service workers need a secure context).

```bash
cd recast
python3 -m http.server 5173        # then open http://localhost:5173
# or: npx serve .
```

Run unit tests (Node 18+):

```bash
npm test        # = node --test tests/*.test.mjs
```

---

## 3. Deploy free (from an iPhone, no computer needed)

### Option A — GitHub Pages (recommended)
1. In Safari, sign in at github.com and create a new **public** repository, e.g. `recast`.
2. Unzip `recast.zip` in the Files app. Tap **Add file → Upload files**, then **Select** and pick every file in the `recast` folder (the app files are all in one flat folder so this works from iPhone; the `tests` folder is optional). Commit.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root → Save.**
4. After about a minute the site is live at `https://<your-username>.github.io/recast/`.

### Option B — Cloudflare Pages / Netlify
Both accept a direct upload of the folder or zip in their dashboards (free tier). The site has no build command and the output directory is the folder root.

### After deploying
Open the URL in Safari → Share → **Add to Home Screen**. Running as an installed app gives more reliable storage retention on iOS.

---

## 4. First run on iPhone 16 Pro (Safari 26)

1. **Settings → Run capability test.** Confirms WebGL2, WebCodecs H.264/HEVC decode and H.264 encode, storage quota, and that MediaPipe and Mediabunny load.
2. **Models → Install required + segmenter.** Downloads Pose Lite, Face Landmarker and Selfie Segmenter (about 9.5 MB). Optional: Pose Full, Hand, Selfie Multiclass (needed for hair extraction and clothing recolor, about 16 MB). Tap **Test** on each to see it start and which delegate it got (GPU/WebGL or CPU/WASM).
3. **Settings → Run self-tests.** Should show pass for storage, MP4 encode, decode + pixel check, WebGL mesh warp, and model start-up.

### Manual end-to-end test (acceptance walkthrough)
Use a clip you own: e.g. record yourself or a consenting friend for 5–10 s on the iPhone, facing the camera, turning the head a little and talking.

| Step | What to do | What you should see |
|---|---|---|
| Characters | **Characters → Create “Myself”**, add a front face photo (selfie in even light). | Quality score, yaw value, and any issues (small, dark, blurry). Missing-views warning for profiles. |
| Import | **Studio → + CREATE NEW RECAST → Face Recast → Mobile Preview → Choose video** | Metadata table (resolution, fps, duration, codec, audio), playable video, real thumbnails strip, trim sliders, processing plan with any reductions listed. |
| Actors | **Detect actors** | Progress counts real frames (`Frame n / N`) with measured frames/s. Then the monitor shows boxes, skeletons and face points following the person while you scrub. Tap to select. |
| Cast | Assign **Myself** to the selected actor. | Consent chip “self”. |
| MotionLock | Move the Smoothing slider. | Chart: raw (amber) vs smoothed (violet) head path; jitter numbers drop. |
| Editor | Scrub. Toggle **Face mesh**, **Masks**, **Compare**. | Your face rendered on the actor, following mouth/eyes/head; mesh wireframe on the face; compare slider splitting original/recast. Per-frame timing shown. |
| Render | **Full render + MP4 → Start render** | Frame-accurate progress, measured speed, cancel works. Then a rendered-preview player with compare/scrub. |
| Export | **Save / Share video** → Save Video. **Verify export.** | The video plays in Photos with original audio. Verification table shows large Δ inside the face region and smaller Δ for the whole frame. |

Recommended source footage: face at least ~150 px wide in the processed frame, front-lit, not too fast. Wide shots with small faces mostly fail face detection at 640 px; use Mobile Quality.

---

## 5. Implemented vs experimental vs unavailable

Status below is what the code does. **It has not yet been run in Safari on an iPhone** (see §7).

### Functional (real processing)
- Video import from Photos/Files/camera, MP4/MOV, metadata, trim, real thumbnails, explicit processing plan (no silent downscaling).
- Frame-accurate decoding via Mediabunny/WebCodecs, with a `<video>`-seeking fallback.
- Multi-person detection (Pose Landmarker, up to 4 per frame) + Face Landmarker (478 points) on every frame; face↔body association; identity tracker with velocity prediction and re-acquisition after occlusion; tappable selection; swap-from-frame and merge corrections; local re-detection (±15 frames).
- MotionLock: One Euro smoothing, short-gap bridging (long gaps stay empty), jitter metrics, expression-follow strength. Timing, duration and camera motion are preserved because every output frame is the original frame with layers composited onto it.
- Face Recast: Delaunay mesh from your photo, warped onto the actor's tracked landmarks with WebGL2; reference view chosen per frame by head yaw (front/left/right) with hysteresis; back-facing triangle culling; feathered edges; keep-source mouth interior and optional eyes.
- SceneBlend: per-vertex low-frequency color and lighting transfer (skin tone + light direction), saturation, film grain, temporal smoothing of color gains.
- Hair: hair layer cut from your photo with Selfie Multiclass, recolor/brightness/volume/hairline/opacity, aligned per frame by a similarity fit to the face.
- Wardrobe: garment photo with automatic plain-background removal, draggable fit points, 8×8 bilinear mesh warp onto shoulders/hips (tops) or hips/knees/ankles (bottoms), clipping to the person mask, clothing recolor from the clothes class.
- Group recast: several actors, each with its own character, settings, keyframes and repairs.
- Editor: monitor, compare slider, side-by-side, original view, tracking/mesh/mask overlays, multi-track timeline (coverage, keys, overrides, strokes, audio), inspector with keyframes (x/y/scale/rotation/opacity), restore brush with frame span, per-layer frame skip, restore-original-frame.
- Render queue: one job at a time, real progress, cancel, preview-range renders.
- Export: H.264 MP4 (HEVC/VP9 if H.264 encode is missing), original audio re-encoded to AAC/Opus where supported, optional burned-in “AI-edited” label, Share sheet / download, **export verification** that re-decodes the file and measures pixel change in the actor's face region.
- Local character library with consent gate for other people, export/import profiles, delete per photo/character/project, delete-all. Project export/import.
- Model Manager (download with progress, import from file, test, remove, license/size/delegate), capability test, self-tests, PWA offline shell.

### Basic / experimental
- **Full Recast**: combines face + hair + garments; no body reshaping.
- Garments are rigid 2D layers: sleeves do not follow arms; back views show the front.
- Hair does not simulate movement or remove the actor's own hair.
- Performance Match = lightest smoothing preset, not a separate algorithm.
- MediaRecorder export fallback (only if WebCodecs encoding is missing): real-time, no audio.

### Not available in v0.1 (shown as unavailable in the app)
- Body proportion changes (height, shoulders, limbs). Full-body/side/rear photos and reference videos are stored for V0.2 but not used.
- Background reconstruction / inpainting and clean-plate compositing.
- Text-to-garment generation (field disabled: no local generation model).
- Video diffusion or photoreal full-body synthesis.
- Transformers.js / ONNX Runtime Web models (no model in this build needs them).
- Worker-based inference (MediaPipe runs on the main thread with yielding), resume-from-checkpoint.
- WebGPU is detected and reported but not used by v0.1; MediaPipe's GPU delegate uses WebGL2.

---

## 6. Privacy and consent
- Network requests: jsDelivr (code), Google Fonts, and Google's model storage when you install a model. Nothing else, and never your media.
- Characters for anyone other than you require a recorded consent confirmation; without it the likeness is not rendered.
- The AI-edited label is on by default. Only edit footage you have rights to; do not publish edits of real people without their permission.

---

## 7. Testing status (honest)

| Area | Status |
|---|---|
| Pure logic (Delaunay, similarity fit, affine/bilinear maps, keyframes, tracker identity through occlusion, swap/merge, gap filling, One Euro, mesh build, frame selection/timing, presets, garment grid) | **43 Node unit tests, all passing** (incl. WSOLA, voice detection, take fitting, body rig, hole filling) (`npm test`). |
| All modules | Parse-checked with Node; all cross-module imports resolve. |
| Browser pipeline (storage, encode, decode + pixel check, WebGL warp, model start-up) | Implemented as in-app **self-tests** (Settings). **Not yet executed** — the build environment had no browser and no access to the CDN or model hosts. |
| End-to-end on iPhone 16 Pro Safari | **Not yet executed.** Use the walkthrough in §4. The v0.1 acceptance criteria should be treated as unverified until that run passes. |
| Sample video | Not bundled (no rights-cleared clip was available offline). Record your own 5–10 s clip. |

If something fails on device, the capability test and self-test output identify which layer (runtime load, model start, decode, encode, WebGL) is responsible.

---

## 8. Roadmap — V0.2
1. Port UI to React + TypeScript + Vite + Tailwind; keep engine modules; add Playwright e2e on WebKit with a bundled rights-cleared clip.
2. Move inference and compositing into a Web Worker with OffscreenCanvas; checkpoint/resume renders.
3. Body silhouette fitting: proportion warps (shoulder width, height, limb length) using pose-driven mesh deformation and the person mask.
4. Arm-aware garments: sleeve segments driven by shoulder–elbow–wrist; front/back garment pairs.
5. Background: clean-plate upload, temporal plate building from frames where the actor is absent, then a validated local inpainting model (ONNX Runtime Web, WebGPU) for actor removal.
6. Expression library from the facial-expression video (choose the closest reference frame per source expression, e.g. open-mouth teeth).
7. Hair: remove source hair via plate + segmentation; secondary motion approximation.
8. Motion blur from landmark velocity; noise-profile matching for grain.
9. Mesh deformation handles in the editor; mask freeze/propagate by tracking.
10. WebGPU compositing path where it is faster than WebGL2.

---

## 9. Licenses and attribution
- MediaPipe Tasks Vision — Apache-2.0 © Google. Models (Pose/Face/Hand Landmarker, Selfie Segmenter, Selfie Multiclass): Apache-2.0 per their model cards; attribution required when redistributing.
- Mediabunny — MPL-2.0 © Vanilagy.
- Archivo, IBM Plex Sans, IBM Plex Mono — SIL Open Font License 1.1.
- RECAST AI+ source in this folder — yours to license.
