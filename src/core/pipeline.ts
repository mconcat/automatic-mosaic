import { coverFrame } from '../effects/cover';
import { drawDebugOverlay } from '../render/debug-overlay';
import { IouTracker, type TrackerOptions } from '../tracking/iou-tracker';
import { mapToSource } from './detections';
import { failReason, staleLimitMs, type FailReason } from './fail-closed';
import { FpsCounter } from './fps-counter';
import { FrameGate } from './frame-gate';
import { clampRect, fitLongSide, padRect, snapOut } from './geometry';
import type { Params, ParamStore, ParamValues } from './params';
import type { DetectorRegistry, EffectRegistry } from './registry';
import { defaultRules, matchRule } from './rules';
import type { Detection, Detector, DetectorOptions, DisplayMode, Effect, ExecutionLocation, Frame, ParamSpec, ParamValue, Rect, Renderer, Size, Track, Trigger } from './types';

// Source → Detector → Tracker(IoU 매칭 + One Euro + hold) → Trigger(빈 훅) → Rules → Renderer+Effect (PLAN §2.1).
// 표시 모드 (PLAN §2.3):
// - 동기: 분석이 끝난 바로 그 프레임만 그 프레임의 검출 결과와 함께 그린다. 검출기를 불러오는 중·오류·지연일 때는
//   새 프레임을 그리지 않으므로 마지막 분석 프레임(없으면 빈 화면)이 남는다.
// - 비동기: 카메라 프레임마다 최신 검출 결과로 그린다. 결과를 믿을 수 없으면(fail-closed) 화면 전체를 가린다.
// 어느 쪽이든 검출 결과나 fail-closed 판정을 거치지 않고 원본 프레임을 그리는 경로는 없다. 검출기가 Worker인지 여부는 모른다.

export type DetectorState = 'idle' | 'loading' | 'ready' | 'error';

/** 시험용 고장 (window.__am.fault): 검출마다 지연시키거나 실패시킨다. */
export type Fault = { kind: 'delay'; ms: number } | { kind: 'error' };

interface Result {
  frameId: number;
  timestampMs: number;
  size: Size;
  detections: Detection[]; // 이 프레임의 검출 결과
  tracks: Track[]; // 트래커를 거친 결과 (검출 없이 유지 중인 트랙 포함)
}

// 화면에 그린 프레임. 다음 프레임이 오거나 reset()까지 들고 있다 (다시 그리기용).
interface Shown {
  frameId: number;
  timestampMs: number;
  bitmap: ImageBitmap;
  size: Size;
  result: Result | null; // 동기: 이 프레임의 검출 결과. 비동기: null (그릴 때 최신 결과를 쓴다)
}

/** 그린 프레임 하나의 기록 (테스트 훅 renders()) */
export interface RenderRecord {
  seq: number;
  frameId: number; // 그린 카메라 프레임
  timestampMs: number; // 그린 카메라 프레임의 시각
  detectionFrameId: number | null; // 박스를 가져온 검출 프레임. 화면 전체를 가렸으면 null
  mode: DisplayMode;
  fullCover: boolean; // 화면 전체를 가렸다 (스냅숏의 fullCover와 같은 뜻)
  tracks: { id: number; held: boolean }[]; // 모자이크를 그린 트랙. held: 그 검출 프레임에서는 검출되지 않고 유지 중
}

/** 검출 한 번의 기록 (테스트 훅 inferences(), 측정용) */
export interface InferenceRecord {
  seq: number;
  frameId: number;
  ms: number; // detect() 시간 (Worker면 왕복)
  count: number; // 검출 수
}

const LOG_SIZE = 600;

// 그릴 모자이크 하나 (원본 px). padded: 프레임으로 자르기 전, rect: 자른 뒤
interface Mask {
  rect: Rect;
  padded: Rect;
  effect: Effect;
  params: Record<string, unknown>;
  track: Track;
  held: boolean;
}

export interface PipelineDeps {
  renderer: Renderer;
  params: ParamStore;
  detectors: DetectorRegistry;
  effects: EffectRegistry;
  now?: () => number; // performance.now() 기준 시계 (테스트에서 바꾼다)
}

// 바뀌면 마지막 프레임을 다시 그리는 코어 파라미터. 등록된 이펙트의 파라미터도 모두 다시 그린다.
const CORE_RENDER_KEYS = ['mirror', 'effect', 'shape', 'padding', 'debug'];

function trackerOptions(p: Params): TrackerOptions {
  return { holdMs: p.holdMs, iouThreshold: p.iouThreshold, smoothing: p.smoothing, minCutoff: p.minCutoff, beta: p.beta };
}

// 이 값이 바뀌면 검출기를 새로 만든다 (실행 장치·신뢰도는 updateOptions)
function detectorKey(p: Params): string {
  return `${p.model}@${p.location}`;
}

// 이펙트·검출기가 params 스키마로 들고 온 파라미터의 현재 값
function ownParams(specs: readonly ParamSpec[], p: ParamValues): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const { key } of specs) {
    const v = p[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

export class Pipeline {
  detectorState: DetectorState = 'idle';
  detectorError: string | null = null;
  /** 검출기 상태가 바뀔 때 (UI 갱신용) */
  onDetectorState: (() => void) | null = null;
  /** Tracker 뒤, Rules 앞의 트리거 훅. 지금은 아무것도 하지 않는다. */
  trigger: Trigger = () => [];
  fault: Fault | null = null;

  frameCount = 0; // reset() 뒤 새로 그린 프레임 수 (다시 그리기는 세지 않는다)
  droppedFrames = 0; // 차례가 왔지만 추론 중이라 버린 프레임 수
  inferenceMs = 0; // detect() 시간 (지수 이동 평균, Worker면 왕복 시간)
  regions: Rect[] = []; // 마지막으로 그린 모자이크 영역 (원본 px, 패딩·클램프 후). 전체를 가렸으면 프레임 전체
  readonly renderFps = new FpsCounter();
  readonly inferenceFps = new FpsCounter();

  private readonly deps: PipelineDeps;
  private readonly now: () => number;
  private readonly gate: FrameGate;
  private readonly renderKeys: ReadonlySet<string>;
  private readonly detectorParamKeys: ReadonlySet<string>;
  private readonly tracker = new IouTracker();
  private detector: Detector | null = null;
  private detectorKey = '';
  private detectorLocation: ExecutionLocation | null = null;
  private loading: Detector | null = null; // 초기화 중인 검출기
  private latest: Result | null = null; // 마지막으로 끝난 검출
  private shown: Shown | null = null;
  private drawnResult: Result | null = null; // 화면에 그린 박스의 출처
  private drawnCover = false;
  private firstFrameMs: number | null = null;
  private readyMs: number | null = null;
  private streamId: string | null = null; // 지금 받는 프레임의 스트림
  private readonly renderLog: RenderRecord[] = [];
  private renderSeq = 0;
  private readonly inferenceLog: InferenceRecord[] = [];
  private inferenceSeq = 0;
  private session = 0;
  private inFlight = false;
  private loadToken = 0;
  private optionsQueued = false;
  private ops: Promise<void> = Promise.resolve(); // 검출기 작업(초기화, 옵션, 추론)을 한 줄로 세운다

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.gate = new FrameGate(deps.params.get('targetFps'));
    this.setTargetFps(deps.params.get('targetFps'));
    this.renderKeys = new Set([...CORE_RENDER_KEYS, ...deps.effects.list().flatMap((e) => e.params.map((s) => s.key))]);
    this.detectorParamKeys = new Set(deps.detectors.list().flatMap((e) => (e.params ?? []).map((s) => s.key)));
    deps.params.subscribe((key) => this.onParam(key));
    deps.renderer.onResize = () => this.render();
  }

  /** 화면에 그려진 프레임 id (렌더러가 기록한다) */
  get drawnFrameId(): number | null {
    return this.deps.renderer.frameId;
  }

  /** 화면에 그린 박스를 낸 검출 프레임 id. 동기 표시에서는 drawnFrameId와 같다. 전체를 가렸으면 null. */
  get detectionFrameId(): number | null {
    return this.drawnResult?.frameId ?? null;
  }

  /** 화면 전체를 가려 그렸는지 (비동기 fail-closed) */
  get coverDrawn(): boolean {
    return this.drawnCover;
  }

  get detectorId(): string | null {
    return this.detector?.id ?? null;
  }

  /** 지금 검출기를 만든 실행 위치 (레지스트리 팩토리에 넘긴 값) */
  get executionLocation(): ExecutionLocation | null {
    return this.detectorLocation;
  }

  get activeDelegate(): Detector['activeDelegate'] {
    return this.detector?.activeDelegate ?? null;
  }

  get fallbackReason(): string | null {
    return this.detector?.fallbackReason ?? null;
  }

  /** 화면에 그린 결과의 검출 (그 검출 프레임의 검출기 출력) */
  get detections(): readonly Detection[] {
    return this.drawnResult?.detections ?? [];
  }

  /** 화면에 그린 결과의 트랙과 그 검출 프레임 시각 (held 판단용). 전체를 가렸으면 트랙 없음 */
  get tracks(): { tracks: readonly Track[]; timestampMs: number | null } {
    return { tracks: this.drawnResult?.tracks ?? [], timestampMs: this.drawnResult?.timestampMs ?? null };
  }

  /** 지금 검출 결과를 믿을 수 없는 이유 (fail-closed). nowMs는 performance.now() 기준. */
  failClosedReason(nowMs: number): FailReason | null {
    const since = Math.max(this.firstFrameMs ?? -Infinity, this.readyMs ?? -Infinity);
    return failReason({
      detectorState: this.detectorState,
      nowMs,
      lastOkMs: this.latest?.timestampMs ?? null,
      sinceMs: Number.isFinite(since) ? since : null,
      limitMs: staleLimitMs(this.deps.params.get('targetFps')),
    });
  }

  /** seq가 sinceSeq보다 큰 그리기 기록 (최근 600개까지) */
  renders(sinceSeq = 0): RenderRecord[] {
    return this.renderLog.filter((r) => r.seq > sinceSeq).map((r) => ({ ...r, tracks: r.tracks.map((t) => ({ ...t })) }));
  }

  /** seq가 sinceSeq보다 큰 검출 기록 (최근 600개까지) */
  inferences(sinceSeq = 0): InferenceRecord[] {
    return this.inferenceLog.filter((r) => r.seq > sinceSeq).map((r) => ({ ...r }));
  }

  /** 검출기를 파라미터(model, location, delegate)에 맞춘다. 연달아 불리면 마지막 요청만 실행한다. */
  syncDetector(): void {
    const token = ++this.loadToken;
    // 다른 검출기로 바꿀 때는 이전 것을 바로 닫는다. 진행 중인 요청도 끊기므로 멈춘 Worker를 기다리지 않는다.
    if (this.detector && this.detectorKey !== detectorKey(this.deps.params.snapshot())) this.dropDetector();
    this.loading?.dispose();
    this.setDetectorState('loading', null);
    this.enqueue(async () => {
      if (token !== this.loadToken) return;
      const p = this.deps.params.snapshot();
      try {
        if (this.detector && this.detectorKey === detectorKey(p)) {
          await this.detector.updateOptions(this.detectorOptions(p)); // 실행 장치가 바뀌었으면 어댑터가 새로 만든다
        } else {
          this.dropDetector();
          const entry = this.deps.detectors.get(p.model);
          if (!entry) throw new Error(`Unknown model: ${p.model}`);
          const detector = entry.create(p.location);
          this.loading = detector;
          try {
            await detector.init(this.detectorOptions(p));
          } catch (err) {
            detector.dispose();
            throw err;
          } finally {
            if (this.loading === detector) this.loading = null;
          }
          detector.onError = (err) => this.failDetector(detector, 'Detector error', err);
          this.detector = detector;
          this.detectorKey = detectorKey(p);
          this.detectorLocation = entry.mainOnly ? 'main' : p.location;
        }
        if (token === this.loadToken) {
          this.readyMs = this.now();
          this.setDetectorState('ready', null);
        }
      } catch (err) {
        this.dropDetector();
        if (token !== this.loadToken) return; // 밀려난 요청 (교체하며 닫았다)
        console.warn('[pipeline] Failed to prepare the detector.', err);
        this.setDetectorState('error', `Failed to load detector: ${errorText(err)}`);
      }
    });
  }

  /** 카메라 프레임 하나를 받는다 (소유권도 넘어온다). */
  push(frame: Frame): void {
    if (frame.streamId !== this.streamId) this.streamChanged(frame.streamId);
    this.firstFrameMs ??= frame.timestampMs;
    const sync = this.deps.params.get('displayMode') === 'sync';
    if (!sync) this.show(frame, null); // 비동기: 카메라 프레임마다 그린다. 프레임은 화면이 갖는다
    const release = (): void => {
      if (sync) frame.bitmap.close();
    };
    if (this.detectorState !== 'ready' || !this.gate.due(frame.timestampMs)) return release();
    if (this.inFlight) {
      this.droppedFrames++;
      return release();
    }
    this.gate.take(frame.timestampMs);
    this.inFlight = true;
    const input = this.makeInput(frame); // 프레임이 닫히기 전에 복사를 시작한다
    const session = this.session;
    this.enqueue(async () => {
      try {
        await this.process(frame, input, sync, session);
      } finally {
        this.inFlight = false;
      }
    });
  }

  /** 시작·정지 때: 들고 있던 프레임과 통계를 버리고 화면을 비운다. 진행 중인 추론 결과도 버린다. */
  reset(): void {
    this.session++;
    this.gate.reset();
    this.clearShown();
    this.tracker.reset();
    this.latest = null;
    this.firstFrameMs = null;
    this.readyMs = null;
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.inferenceMs = 0;
    this.renderFps.reset();
    this.inferenceFps.reset();
  }

  // 카메라를 바꿨다: 화면은 그대로 두고, 이전 스트림의 검출 결과와 진행 중인 추론은 버린다.
  // 해상도가 같아도 이전 카메라의 박스는 새 화면의 얼굴과 무관하다 (비동기는 새 스트림의 첫 결과까지 전체를 가린다).
  private streamChanged(streamId: string): void {
    this.streamId = streamId;
    this.session++;
    this.gate.reset();
    this.tracker.reset();
    this.latest = null;
    this.firstFrameMs = null;
  }

  // 검출기에는 항상 따로 만든 입력(추론 해상도로 줄인 복사본)을 넘긴다. Worker로 transfer 되어도 화면용 프레임은 남는다.
  private makeInput(frame: Frame): Promise<ImageBitmap> {
    const size = fitLongSide({ width: frame.width, height: frame.height }, this.deps.params.get('inferenceSize'));
    return createImageBitmap(frame.bitmap, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
  }

  // owned: 동기 표시로 받은 프레임이라 검출이 끝나면 이 프레임을 그린다 (비동기면 이미 화면에 있다).
  private async process(frame: Frame, inputReady: Promise<ImageBitmap>, owned: boolean, session: number): Promise<void> {
    const detector = this.detector;
    const current = (): boolean => session === this.session && detector !== null && detector === this.detector;
    let input: ImageBitmap | null = null;
    let kept = false;
    try {
      input = await inputReady;
      if (!current() || this.detectorState !== 'ready') return;
      const inputSize = { width: input.width, height: input.height };
      const t0 = performance.now();
      await this.applyFault();
      if (!current()) return;
      const given = input;
      input = null; // 소유권은 검출기로
      const raw = await detector!.detect(given, frame.timestampMs);
      const ms = performance.now() - t0;
      if (!current()) return; // 그사이 정지·검출기 교체: 늦은 결과는 버린다

      const size = { width: frame.width, height: frame.height };
      const detections = mapToSource(raw, inputSize, size);
      const tracks = this.tracker.update(detections, frame.timestampMs, trackerOptions(this.deps.params.snapshot()));
      this.trigger(tracks, frame.timestampMs);
      const now = performance.now();
      this.inferenceMs = this.inferenceMs > 0 ? this.inferenceMs * 0.7 + ms * 0.3 : ms;
      this.inferenceFps.tick(now);
      this.log(this.inferenceLog, { seq: ++this.inferenceSeq, frameId: frame.id, ms, count: detections.length });
      this.latest = { frameId: frame.id, timestampMs: frame.timestampMs, size, detections, tracks };
      if (owned && this.deps.params.get('displayMode') === 'sync') {
        this.show(frame, this.latest, now); // 동기: 렌더 FPS = 추론 FPS (같은 시각으로 센다)
        kept = true;
      }
    } catch (err) {
      if (current()) this.failDetector(detector!, 'Detection failed', err);
    } finally {
      input?.close();
      if (owned && !kept) frame.bitmap.close();
    }
  }

  private async applyFault(): Promise<void> {
    const fault = this.fault;
    if (fault?.kind === 'delay') await new Promise((r) => setTimeout(r, fault.ms));
    if (this.fault?.kind === 'error') throw new Error('Simulated detection failure');
  }

  private show(frame: Frame, result: Result | null, now = performance.now()): void {
    if (this.shown && this.shown.bitmap !== frame.bitmap) this.shown.bitmap.close();
    this.shown = { frameId: frame.id, timestampMs: frame.timestampMs, bitmap: frame.bitmap, size: { width: frame.width, height: frame.height }, result };
    this.frameCount++;
    this.renderFps.tick(now);
    this.render();
  }

  // 화면의 프레임을 현재 파라미터로 그린다. 동기 프레임은 그 프레임의 결과로, 비동기 프레임은 최신 결과로 그리되
  // 최신 결과를 믿을 수 없으면(fail-closed, 크기가 다른 프레임의 결과) 화면 전체를 가린다. 다른 스트림의 결과는 streamChanged()가 버린다.
  // 패딩은 프레임으로 자르기 전 박스에 하고 그 뒤에 자른다 (가장자리에 걸린 얼굴도 안쪽 여백이 줄지 않게).
  private render(): void {
    const shown = this.shown;
    if (!shown) return;
    const p = this.deps.params.snapshot();
    let result = shown.result;
    if (!result) {
      const latest = this.latest;
      const trusted = latest !== null && sameSize(latest.size, shown.size) && this.failClosedReason(shown.timestampMs) === null;
      result = trusted ? latest : null;
    }
    const cover = result === null;
    const masked = result ? this.masks(result, shown.size, p) : [];
    try {
      this.deps.renderer.draw(shown.bitmap, shown.size, { mirror: p.mirror, frameId: shown.frameId }, (ctx) => {
        if (cover) coverFrame(ctx, shown.bitmap, shown.size);
        for (const m of masked) m.effect.apply(ctx, shown.bitmap, { kind: p.shape, rect: m.rect, unclipped: m.padded }, m.params);
        if (p.debug && result) drawDebugOverlay(ctx, result.detections, masked);
      });
    } catch (err) {
      console.error('[pipeline] Draw failed (view cleared)', err);
      this.drawnResult = null;
      this.drawnCover = false;
      this.regions = [];
      return;
    }
    this.drawnResult = result;
    this.drawnCover = cover;
    this.regions = cover ? [{ x: 0, y: 0, ...shown.size }] : masked.map((m) => m.rect);
    this.log(this.renderLog, {
      seq: ++this.renderSeq,
      frameId: shown.frameId,
      timestampMs: shown.timestampMs,
      detectionFrameId: result?.frameId ?? null,
      mode: shown.result ? 'sync' : 'async',
      fullCover: cover,
      tracks: masked.map((m) => ({ id: m.track.id, held: m.held })),
    });
  }

  private log<T>(list: T[], record: T): void {
    list.push(record);
    if (list.length > LOG_SIZE) list.shift();
  }

  private masks(result: Result, size: Size, p: ParamValues): Mask[] {
    const effect = this.deps.effects.get(p.effect);
    const rules = defaultRules(p.effect, effect ? ownParams(effect.params, p) : {});
    const out: Mask[] = [];
    for (const track of result.tracks) {
      const rule = matchRule(rules, track);
      const fx = rule && this.deps.effects.get(rule.effectId);
      if (!rule || !fx) continue;
      const padded = snapOut(padRect(track.box, p.padding));
      const rect = clampRect(padded, size);
      if (rect.width <= 0 || rect.height <= 0) continue; // 패딩해도 프레임에 걸치지 않는다
      out.push({ rect, padded, effect: fx, params: rule.params, track, held: track.lastSeenMs < result.timestampMs });
    }
    return out;
  }

  private clearShown(): void {
    this.shown?.bitmap.close();
    this.shown = null;
    this.drawnResult = null;
    this.drawnCover = false;
    this.regions = [];
    this.deps.renderer.clear();
  }

  private onParam(key: string): void {
    if (key === 'model' || key === 'delegate' || key === 'location') this.syncDetector();
    else if (key === 'minConfidence' || key === 'nmsThreshold' || this.detectorParamKeys.has(key)) this.applyDetectorOptions();
    else if (key === 'targetFps') this.setTargetFps(this.deps.params.get('targetFps'));
    else if (key === 'displayMode') {
      // 동기로 바꾸면 비동기로 그린(분석하지 않은) 프레임은 지운다. 다음 분석 프레임부터 그린다.
      if (this.deps.params.get('displayMode') === 'sync' && this.shown && !this.shown.result) this.clearShown();
    } else if (this.renderKeys.has(key)) this.render();
  }

  // 공통 옵션 + 지금 고른 검출기의 자기 파라미터
  private detectorOptions(p: ParamValues): DetectorOptions {
    const opts: DetectorOptions = { delegate: p.delegate, minConfidence: p.minConfidence, nmsThreshold: p.nmsThreshold };
    const own = this.deps.detectors.get(p.model)?.params;
    if (own?.length) opts.extra = ownParams(own, p);
    return opts;
  }

  private setTargetFps(fps: number): void {
    this.gate.setFps(fps);
    this.renderFps.setTargetFps(fps);
    this.inferenceFps.setTargetFps(fps);
  }

  // 신뢰도·NMS는 다시 만들지 않고 바로 바꾼다. 불러오는 중이면 syncDetector가 최신 값을 읽으므로 건너뛴다.
  // setOptions마다 MediaPipe가 그래프를 다시 만들므로, 줄에 하나만 세우고 실행할 때 최신 값을 읽는다.
  private applyDetectorOptions(): void {
    if (this.optionsQueued) return;
    this.optionsQueued = true;
    this.enqueue(async () => {
      this.optionsQueued = false;
      const detector = this.detector;
      if (!detector || this.detectorState !== 'ready') return;
      try {
        await detector.updateOptions(this.detectorOptions(this.deps.params.snapshot()));
      } catch (err) {
        this.failDetector(detector, 'Failed to change detector options', err);
      }
    });
  }

  // 지금 쓰는 검출기가 실패했다: 닫고 오류 상태로 (UI에 문구가 나온다). 이미 바뀐 검출기의 오류는 무시한다.
  private failDetector(detector: Detector, message: string, err: unknown): void {
    if (detector !== this.detector) return;
    console.warn(`[pipeline] ${message}`, err);
    this.dropDetector();
    this.setDetectorState('error', `${message}: ${errorText(err)}`);
  }

  private dropDetector(): void {
    const detector = this.detector;
    this.detector = null;
    this.detectorKey = '';
    this.detectorLocation = null;
    if (detector) {
      detector.onError = null;
      detector.dispose();
    }
  }

  private setDetectorState(state: DetectorState, error: string | null): void {
    this.detectorState = state;
    this.detectorError = error;
    // 비동기로 그린 프레임은 다음 카메라 프레임을 기다리지 않고 다시 판단해 그린다 (오류·불러오기 → 바로 전체를 가린다)
    if (this.shown && !this.shown.result) this.render();
    this.onDetectorState?.();
  }

  private enqueue(op: () => Promise<void>): void {
    this.ops = this.ops.then(op).catch((err: unknown) => console.error('[pipeline]', err));
  }
}
