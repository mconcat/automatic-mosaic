import './style.css';
import { blockedRequests, installLocalOnlyFetch } from './core/local-only';
import { isNetworkError, LoadRetry } from './core/load-retry';
import { coreParamSpecs, ParamStore } from './core/params';
import { Pipeline } from './core/pipeline';
import { Registry, type DetectorEntry } from './core/registry';
import type { Effect, ExecutionLocation } from './core/types';
import { MediaPipeFaceDetector, type FaceModel } from './detectors/mediapipe-face';
import { LANDMARKER_PARAMS, MediaPipeFaceLandmarker } from './detectors/mediapipe-face-landmarker';
import { OWL_PARAMS, OwlVitDetector, owlTargets } from './detectors/owlvit';
import { crashDetectorWorkers, DetectorProxy, workerStats } from './detectors/worker/proxy';
import { pixelate } from './effects/pixelate';
import { solid } from './effects/solid';
import { Canvas2DRenderer } from './render/canvas2d-renderer';
import { CameraError, CameraSource, toCameraError, type CameraDevice } from './sources/camera';
import type { AmHook, AmSnapshot, AppState } from './test-hook';
import { LoadingBar } from './ui/loading-bar';
import { LongTaskMonitor } from './ui/long-tasks';
import { QuickControls } from './ui/quick-controls';
import { ParamPanel } from './ui/panel';
import { StatsView } from './ui/stats';
import { stageNoteText } from './ui/status-text';

installLocalOnlyFetch(); // MediaPipe를 쓰기 전에

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}.`);
  return el as T;
}

const ui = {
  toggle: $<HTMLButtonElement>('toggle'),
  status: $<HTMLParagraphElement>('status'),
  detector: $<HTMLParagraphElement>('detector'),
  error: $<HTMLParagraphElement>('error'),
  stage: $<HTMLElement>('stage'),
  stageNote: $<HTMLParagraphElement>('stage-note'),
};

const STATUS_TEXT: Record<AppState, string> = {
  idle: 'Idle — press Start.',
  starting: 'Connecting camera…',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Error — fix the problem and start again.',
};

const LOCATION_TEXT: Record<ExecutionLocation, string> = { worker: 'Worker', main: 'Main thread' };

// MediaPipe 얼굴 검출기 항목: Worker면 DetectorProxy(Worker 안에서 같은 어댑터), 아니면 메인 스레드에서 직접.
function faceDetector(id: string, label: string, model: FaceModel): DetectorEntry {
  return {
    id,
    label,
    create: (location) =>
      location === 'worker' ? new DetectorProxy(id, ['face'], { kind: 'mediapipe-face', model }) : new MediaPipeFaceDetector(id, model),
  };
}

// 두 번째 검출기 (FaceLandmarker, 박스 = 랜드마크를 감싸는 사각형). 파이프라인·트래커·이펙트는 바꾸지 않는다.
const LANDMARKER_ID = 'mediapipe-face-landmarker';
const faceLandmarker: DetectorEntry = {
  id: LANDMARKER_ID,
  label: 'FaceLandmarker (face mesh)',
  params: LANDMARKER_PARAMS,
  create: (location) =>
    location === 'worker' ? new DetectorProxy(LANDMARKER_ID, ['face'], { kind: 'mediapipe-face-landmarker' }) : new MediaPipeFaceLandmarker(LANDMARKER_ID),
};

// 세 번째 검출기: 텍스트로 가릴 대상을 정한다 (OWL-ViT, 오픈 어휘 검출, Transformers.js WebGPU). 메인 스레드 전용.
const OWL_ID = 'owlvit';
const owlvit: DetectorEntry = {
  id: OWL_ID,
  label: 'Text targets (OWL-ViT)',
  params: OWL_PARAMS,
  mainOnly: true,
  create: () => new OwlVitDetector(OWL_ID),
};

// 레지스트리 등록 (UI 선택지가 여기서 나온다)
const detectors = new Registry<DetectorEntry>()
  .register(faceDetector('mediapipe-face-short', 'BlazeFace short-range', 'short'))
  .register(faceDetector('mediapipe-face-full', 'BlazeFace full-range', 'full'))
  .register(faceLandmarker)
  .register(owlvit);
const effects = new Registry<Effect>().register(pixelate).register(solid);

// 코어 + 이펙트 + 검출기가 들고 온 파라미터
const specs = [
  ...coreParamSpecs(detectors.list(), effects.list()),
  ...effects.list().flatMap((e) => e.params),
  ...detectors.list().flatMap((d) => d.params ?? []),
];
// iPhone·iPad(WebKit)는 Worker 안에서 MediaPipe가 document를 찾다 실패하고, GPU 실행 장치를 만들다 멈춘다. 메인 스레드·CPU로 시작한다.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const params = new ParamStore(specs, IOS ? { location: 'main', delegate: 'CPU' } : {});
const camera = new CameraSource($<HTMLVideoElement>('source'));
const renderer = new Canvas2DRenderer($<HTMLCanvasElement>('view'));
const pipeline = new Pipeline({ renderer, params, detectors, effects });
const panel = new ParamPanel($('panel'), params, specs, [
  { key: 'model', items: detectors.list() },
  { key: 'effect', items: effects.list() },
]);
const stats = new StatsView($('stats'));
const longTasks = new LongTaskMonitor();
longTasks.observe();
// 모델을 받거나 불러오는 동안 화면 위에 진행 표시줄 (고장으로 오해하지 않게)
new LoadingBar($('stage'), () => pipeline.detectorState === 'loading').start();

let state: AppState = 'idle';
let error: CameraError | null = null;
let videoSize = { width: 0, height: 0 };
let lastTracks: MediaStreamTrack[] = [];
let devices: CameraDevice[] = [];
let startToken = 0; // 시작·정지·오류마다 바뀐다. 기다리던 작업이 아직 유효한지 확인한다.
let quietDevice = false; // 장치 목록·전환 결과를 store에 반영할 때는 전환을 다시 걸지 않는다

function showError(err: CameraError | null): void {
  error = err;
  ui.error.textContent = err?.message ?? '';
  ui.error.hidden = !err;
}

function setState(next: AppState, err: CameraError | null = null): void {
  state = next;
  showError(err);
  ui.stage.dataset.state = next;
  ui.status.textContent = STATUS_TEXT[next];
  ui.toggle.textContent = next === 'running' || next === 'starting' ? 'Stop' : 'Start';
  ui.toggle.disabled = next === 'starting';
  panel.setCameraDisabled(next === 'starting');
  updateUi();
}

function setDeviceParam(deviceId: string): void {
  quietDevice = true;
  params.set('deviceId', deviceId);
  quietDevice = false;
}

// 카메라를 놓고 화면과 영상 크기를 비운다.
function release(): void {
  startToken++;
  camera.stop();
  pipeline.reset();
  videoSize = { width: 0, height: 0 };
}

function fail(err: unknown): void {
  const cameraError = toCameraError(err);
  console.warn('[app]', cameraError.code, cameraError.cause ?? '');
  release();
  setState('error', cameraError);
}

// 고른 장치는 store의 deviceId 하나로만 들고 있다. 시작할 때마다 그 값으로 연다.
async function start(): Promise<void> {
  if (state === 'starting' || state === 'running') return;
  const token = ++startToken;
  pipeline.reset();
  setState('starting');
  try {
    await camera.start(params.get('deviceId') || undefined);
  } catch (err) {
    if (token === startToken) fail(err);
    return;
  }
  if (token !== startToken) return; // 연결 중에 정지·오류
  lastTracks = camera.tracks;
  setState('running');
  await refreshDevices();
}

function stop(): void {
  release();
  setState('stopped');
}

// 권한을 얻은 뒤에야 장치 이름이 보인다. 고른 장치가 사라지면 첫 장치로 바뀌고 다음 시작도 그 장치를 연다.
async function refreshDevices(): Promise<void> {
  try {
    devices = await camera.listDevices();
    const current = camera.deviceId ?? params.get('deviceId');
    panel.setDevices(devices);
    setDeviceParam(devices.some((d) => d.deviceId === current) ? current : (devices[0]?.deviceId ?? ''));
  } catch (err) {
    console.warn('[app] Failed to list devices.', err);
  }
}

// 실행 중일 때만 바로 바꾼다 (멈춰 있으면 다음 시작 때 deviceId를 쓴다).
// 새 장치를 못 열면 기존 카메라를 계속 쓰고 오류 문구만 보여 준다. 기존 스트림까지 잃었으면 error 상태가 된다.
async function switchDevice(deviceId: string): Promise<void> {
  if (state !== 'running' || deviceId === (camera.deviceId ?? '')) return;
  const token = startToken;
  panel.setCameraDisabled(true); // 전환이 겹치지 않게
  let err: unknown = null;
  try {
    await camera.start(deviceId || undefined);
  } catch (e) {
    err = e;
  }
  if (token !== startToken) return; // 그사이 정지·오류
  panel.setCameraDisabled(false);
  if (!camera.active) {
    fail(err);
    return;
  }
  lastTracks = camera.tracks;
  showError(err ? toCameraError(err) : null);
  setDeviceParam(camera.deviceId ?? '');
}

camera.onFrame((frame) => {
  videoSize = { width: frame.width, height: frame.height };
  pipeline.push(frame);
});
camera.onEnded = (err) => fail(err);
camera.onDeviceChange(() => void refreshDevices());

// 간단 조작줄: Face mosaic ↔ Text targets 토글, Hide 입력, 자주 쓰는 모자이크 설정. 나머지는 패널(Advanced settings).
new QuickControls($('quick'), params, {
  textModel: OWL_ID,
  defaultFaceModel: 'mediapipe-face-short',
  hideForm: $<HTMLFormElement>('hide-form'),
  hideInput: $<HTMLInputElement>('hide-input'),
});

params.subscribe((key) => {
  if (key === 'deviceId' && !quietDevice) void switchDevice(params.get('deviceId'));
});

ui.toggle.addEventListener('click', () => {
  if (state === 'running') stop();
  else void start();
});

function snapshot(): AmSnapshot {
  const now = performance.now();
  const failReason = state === 'running' ? pipeline.failClosedReason(now) : null;
  return {
    state,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    frameCount: pipeline.frameCount,
    renderFps: pipeline.renderFps.value(now),
    videoWidth: videoSize.width,
    videoHeight: videoSize.height,
    mirror: params.get('mirror'),
    deviceId: camera.deviceId ?? (params.get('deviceId') || null),
    tracks: lastTracks.map((t) => ({ kind: t.kind, label: t.label, readyState: t.readyState })),
    devices: devices.map((d) => ({ deviceId: d.deviceId, label: d.label })),
    detectorState: pipeline.detectorState,
    detectorError: pipeline.detectorError,
    detectorId: pipeline.detectorId,
    location: pipeline.executionLocation,
    activeDelegate: pipeline.activeDelegate,
    delegateFallback: pipeline.fallbackReason,
    displayMode: params.get('displayMode'),
    detections: pipeline.detections.map((d) => ({
      label: d.label,
      score: d.score,
      box: { ...d.box },
      keypoints: (d.keypoints ?? []).map((k) => ({ x: k.x, y: k.y })),
    })),
    tracked: trackedSnapshot(),
    regions: pipeline.regions.map((r) => ({ ...r })),
    drawnFrameId: pipeline.drawnFrameId,
    detectionFrameId: pipeline.detectionFrameId,
    failReason,
    failClosed: failReason !== null,
    fullCover: pipeline.coverDrawn,
    inferenceFps: pipeline.inferenceFps.value(now),
    inferenceMs: pipeline.inferenceMs,
    droppedFrames: pipeline.droppedFrames,
    workers: { ...workerStats },
    longTasks: { count: longTasks.count, maxMs: longTasks.maxMs, recent: longTasks.recent.map((t) => ({ ...t })) },
    viewRect: renderer.viewRect,
    blockedRequests: [...blockedRequests],
  };
}

function trackedSnapshot(): AmSnapshot['tracked'] {
  const { tracks, timestampMs } = pipeline.tracks;
  return tracks.map((t) => ({ id: t.id, label: t.label, box: { ...t.box }, rawBox: { ...t.source.box }, held: t.lastSeenMs !== timestampMs, lastSeenMs: t.lastSeenMs }));
}

function delegateText(s: AmSnapshot): string {
  if (!s.activeDelegate) return '—';
  return s.delegateFallback ? `${s.activeDelegate} (GPU fallback)` : s.activeDelegate;
}

function detectorText(s: AmSnapshot): string {
  switch (s.detectorState) {
    case 'idle':
      return 'Detector not loaded';
    case 'loading':
      return 'Loading detector…';
    case 'error':
      if (isNetworkError(s.detectorError)) return 'Model download was interrupted (network or the tab went to the background). Retrying…';
      return s.detectorError ?? 'Detector error';
    case 'ready': {
      const label = detectors.get(s.detectorId ?? '')?.label ?? s.detectorId;
      const where = s.location ? ` · ${LOCATION_TEXT[s.location]}` : '';
      const fallback = s.delegateFallback ? ' — GPU unavailable, running on CPU.' : '';
      const targets = s.detectorId === OWL_ID ? ` · Targets: ${owlTargets(String(params.get('prompt') ?? '')).join(', ') || 'none — enter English object names separated by commas'}` : '';
      return `Detector ready · ${label}${where} · ${s.activeDelegate}${targets}${fallback}`;
    }
  }
}

function updateUi(): void {
  const s = snapshot();
  stats.update(s);
  const m = panel.monitors;
  m.inferenceFps = s.inferenceFps;
  m.renderFps = s.renderFps;
  m.inferenceMs = s.inferenceMs;
  m.detections = s.detections.length;
  m.location = s.location ? LOCATION_TEXT[s.location] : '—';
  m.delegate = delegateText(s);
  m.dropped = s.droppedFrames;
  m.longTasks = s.longTasks.count;
  m.workers = s.workers.live;
  const detector = detectorText(s);
  if (ui.detector.textContent !== detector) ui.detector.textContent = detector;
  ui.detector.dataset.state = s.detectorState;
  ui.detector.title = s.delegateFallback ?? s.detectorError ?? ''; // 자세한 이유는 툴팁으로
  const note = stageNoteText({ running: s.state === 'running', displayMode: s.displayMode, failReason: s.failReason, hasFrame: s.drawnFrameId !== null });
  ui.stageNote.hidden = note === null;
  if (note !== null && ui.stageNote.textContent !== note) ui.stageNote.textContent = note;
}

// 모델 다운로드가 끊기면(iOS는 백그라운드 탭의 요청을 끊는다) 다시 불러온다.
const loadRetry = new LoadRetry({
  state: () => pipeline.detectorState,
  error: () => pipeline.detectorError,
  visible: () => document.visibilityState === 'visible',
  retry: () => pipeline.syncDetector(),
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadRetry.onVisible();
});
pipeline.onDetectorState = () => {
  updateUi();
  loadRetry.onState();
};
window.setInterval(updateUi, 250);
pipeline.syncDetector(); // 페이지를 열자마자 검출기를 불러온다 (시작 전에 준비되도록)

const hook: AmHook = {
  snapshot,
  get: (key) => params.get(key),
  set: (key, value) => params.set(key, value),
  params: () => params.snapshot(),
  start,
  stop,
  renders: (sinceSeq) => pipeline.renders(sinceSeq),
  inferences: (sinceSeq) => pipeline.inferences(sinceSeq),
  fault: (kind, ms = 3000) => {
    switch (kind) {
      case 'delay':
        pipeline.fault = { kind: 'delay', ms };
        return true;
      case 'error':
        pipeline.fault = { kind: 'error' };
        return true;
      case 'crash':
        return crashDetectorWorkers() > 0;
      case 'none':
        pipeline.fault = null;
        if (pipeline.detectorState === 'error') pipeline.syncDetector();
        return true;
    }
  },
};
window.__am = hook;
