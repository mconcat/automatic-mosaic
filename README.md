# Automatic Mosaic

A browser-only proof of concept that automatically mosaics faces, or any objects you name in text, in a live webcam feed. Detection, tracking and rendering all run in the browser. The only network traffic is the one-time download of models and WASM from their official sources, which then stay in the browser cache. There is no backend, so the production build is a static site.

**Live demo:** https://mconcat.github.io/automatic-mosaic/ (desktop Chrome recommended)

## Try it

1. Open the demo (or run it locally, see below) and press **Start**, then allow camera access. A progress bar shows while models download and initialize.
2. Use the **quick controls** under the header:
   - **Face mosaic | Text targets** switches between masking faces and masking objects you describe.
   - In **Text targets** mode a **Hide:** field appears. Enter English object names separated by commas and press Enter or **Apply**, for example `human face`, `a tie, a flag`, `cell phone, laptop`, `wrist watch, suit jacket`. If something is not picked up, try adding an article (`a tie`) or lower **Text threshold** in Advanced settings.
   - **Mosaic blocks** sets how many cells span the masked region (fewer = coarser). **Effect** switches Pixelate / Solid, **Shape** switches Rectangle / Ellipse, and **Show boxes** draws detection boxes, scores and track IDs.
3. Everything else is in the collapsed **Advanced settings** panel: camera, mirror, detector model, run location (Worker / main thread), delegate (GPU / CPU), confidence, inference size, target FPS, tracking (hold, smoothing, IoU), padding, strength, display mode (Sync / Async) and live monitors.

## Browser support

| Environment | Face mosaic | Text targets |
|---|---|---|
| Desktop Chrome (macOS, Windows) | Supported. About 15 MB first download | Supported. Needs WebGPU; about 300 MB first download, cached afterwards |
| Chrome on Linux | Works | WebGPU may be disabled by default. If so, an error message is shown |
| Safari / Firefox desktop | Likely works, not tested | Depends on WebGPU support, not tested |
| iPhone / iPad | Runs on the main thread with the CPU delegate | May exceed the per-tab memory limit on older devices |

The camera only opens in a secure context: HTTPS (GitHub Pages) or `localhost`.

## How it works

```
Camera → Detector (Web Worker) → Tracker → Trigger hook → Rules → Renderer + Effect → <canvas>
                        ↑ all stages read the shared ParamStore (quick controls + Advanced settings)
```

- **Detectors** sit behind one `Detector` interface and a registry, so they can be swapped at runtime:
  - MediaPipe FaceDetector (BlazeFace short- and full-range)
  - MediaPipe FaceLandmarker (box = landmark bounds)
  - OWL-ViT open-vocabulary detection via [Transformers.js](https://github.com/huggingface/transformers.js) for text targets
- **Worker execution:** MediaPipe detectors run in a module Web Worker behind an RPC proxy. Frames are transferred, not copied, at most one request is in flight, and a GPU failure falls back to the CPU automatically. OWL-ViT runs on the main thread with WebGPU.
- **Tracking:** greedy IoU matching gives stable track IDs. A track is held for a short time after a missed detection, and boxes are smoothed with a One Euro filter. The output box is always the union of the smoothed and the raw box, so smoothing never shrinks coverage.
- **Leak safeguards:** padding around boxes, hold on missed frames, and two display modes:
  - **Sync** (default) draws only frames that were analysed, together with their own detections.
  - **Async** draws at camera rate using the latest boxes.
  - If the detector is loading, failing or stalled, async mode covers the whole frame (fail-closed) instead of showing raw video.
- **Effects:** pixelate (relative or absolute block size, strength) and solid fill, in rectangle or ellipse regions.
- **Model sources** (fetched at runtime):

  | File | Source |
  |---|---|
  | MediaPipe models | `storage.googleapis.com/mediapipe-models` (Google) |
  | MediaPipe WASM | `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm` |
  | OWL-ViT model | `huggingface.co/Xenova/owlvit-base-patch32` |
  | ONNX Runtime WASM | `cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/` |

- **Telemetry:** MediaPipe Tasks 1.2.0 posts usage metrics to `odml.pa.googleapis.com`. The app wraps `fetch` in the page and in the worker and blocks only that host (`src/core/local-only.ts`).

## Run locally

Requires Node.js 22.12+ and desktop Chrome.

```sh
npm install
npm run dev        # http://localhost:5317
```

No extra setup step is needed; models and WASM are fetched on first use.

## Deploy to GitHub Pages

`vite.config.ts` uses `base: './'`, so the build works under a project-site subpath such as `https://<user>.github.io/<repo>/`.

1. Push to `main`.
2. In the repository, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**.
3. `.github/workflows/deploy.yml` runs typecheck → unit tests → build → deploy on every push to `main`. It can also be started manually from the Actions tab.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on port 5317 |
| `npm run build` | Production build to `dist/` (static, relative paths) |
| `npm run preview` | Serve the build on port 5318 |
| `npm run demo` | Build, then serve on `127.0.0.1:5320` (for example behind `tailscale serve --bg 5320` to open it on another device over HTTPS) |
| `npm run typecheck` | `tsc -b` (strict) |
| `npm test` | Vitest unit tests (`tests/unit`) |
| `npm run e2e` | Playwright end-to-end tests (`tests/e2e`) in headless Chrome with a fake camera |
| `npm run fixtures` | Build the fake-camera clips into `tests/fixtures/` |

## Testing

- **Unit tests** (Vitest) cover geometry, the IoU tracker, the One Euro filter, the pipeline, effects, params, the worker proxy and the fetch guard.
- **End-to-end tests** (Playwright, headless Chrome) feed y4m clips as a fake camera with `--use-file-for-fake-video-capture`. `npm run fixtures` builds them with ffmpeg from MediaPipe's public-domain test portrait: one still face, one moving face, two faces, and no face. The tests check detection counts, pixel-level masking, sync-mode frame identity, fail-closed behaviour, worker lifecycle, network destinations and more.
- **Test hook:** the app exposes `window.__am` for the e2e tests:
  - `snapshot()` returns state, detections, tracks, regions, frame IDs, delegate, FPS, long tasks, workers and blocked requests.
  - `get(key)` / `set(key, value)` read and write params.
  - `start()` / `stop()` control the camera.
  - `renders()` returns per-frame render records.
  - `fault('delay' | 'error' | 'crash' | 'none')` simulates detector failures.

  Types are in `src/test-hook.ts`.

### Parameters

| Key | Default | Values |
|---|---|---|
| `deviceId` | `''` | Camera device ID (`''` = default) |
| `mirror` | `true` | Mirror the view |
| `model` | `'mediapipe-face-short'` | `mediapipe-face-short`, `mediapipe-face-full`, `mediapipe-face-landmarker`, `owlvit` |
| `prompt` | `'human face, cell phone'` | Text targets: comma-separated English names |
| `owlThreshold` | `0.1` | 0.02–0.5, OWL-ViT score threshold |
| `numFaces` | `4` | 1–8, FaceLandmarker only |
| `location` | `'worker'` | `worker` / `main` (iOS defaults to `main`) |
| `delegate` | `'GPU'` | `GPU` / `CPU` (iOS defaults to `CPU`) |
| `minConfidence` | `0.5` | 0.1–0.99 |
| `nmsThreshold` | `0.3` | 0.1–0.9 |
| `inferenceSize` | `640` | Long side of the inference input: 320 / 480 / 640 / 0 (original) |
| `targetFps` | `8` | 1–15 |
| `holdMs` | `400` | 0–2000, how long a missed track keeps its last box |
| `smoothing`, `minCutoff`, `beta` | `true`, `1`, `0.01` | One Euro smoothing |
| `iouThreshold` | `0.3` | Track matching threshold |
| `effect` | `'pixelate'` | `pixelate` / `solid` |
| `shape` | `'rect'` | `rect` / `ellipse` |
| `padding` | `1.3` | 1.0–2.0 box scale |
| `blockMode` | `'relative'` | `relative` (cells across the region) / `absolute` (px) |
| `blockCells` / `blockSize` | `10` / `16` | 4–32 cells / 4–64 px |
| `strength` | `1` | 0–1, pixelate blend with the original |
| `solidColor` | `'#000000'` | Solid fill colour |
| `displayMode` | `'sync'` | `sync` / `async` |
| `debug` | `false` | Show boxes, scores, track IDs |

## Extending

- **New detector:** implement `Detector` (`src/core/types.ts`) and register a `DetectorEntry` in `src/main.ts`. An entry can bring its own params, which then appear in the store, the panel and `window.__am`. The pipeline, tracker and effects stay unchanged; FaceLandmarker and OWL-ViT were added this way.
- **New effect:** implement `Effect` with a `params` schema (see `src/effects/pixelate.ts`) and register it. Its params show up automatically.
- **Hand-shape triggers:** the pipeline has a no-op `Trigger` stage after the tracker. A `GestureRecognizer` adapter could emit hand tracks there, and a trigger could fire an action, such as toggling the mosaic, when a gesture is held for N ms.

## Project layout

```
src/main.ts           composition root: registries, pipeline, panel, quick controls, test hook
src/core/             types, ParamStore, registry, pipeline, geometry, frame gate, rules, fail-closed, fetch guard
src/detectors/        MediaPipe task base, FaceDetector, FaceLandmarker, OWL-ViT; worker/ (worker + RPC proxy)
src/tracking/         IoU tracker, One Euro filter
src/effects/          pixelate, solid, full-frame cover, ellipse clip
src/render/           Canvas 2D renderer, debug overlay
src/sources/          webcam FrameSource
src/ui/               quick controls, Advanced settings panel (Tweakpane), loading bar, stats, status text
tests/unit/           Vitest
tests/e2e/            Playwright
scripts/              make-fixtures.mjs
docs/                 PLAN.md (design), PROGRESS.md (phase log), both in Korean
```

## Known limitations

- Text targets understand short English noun phrases only, are sensitive to wording, and need WebGPU plus a ~300 MB first download.
- On iPhone and iPad, detection runs on the main thread with the CPU delegate. Text targets may exceed the memory limit on older devices.
- Pixelation with large blocks is not strong anonymization; use **Solid** when that matters.
