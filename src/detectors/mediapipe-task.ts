import { withReloadHint } from '../core/chunk-error';
import type { Delegate, Detection, Detector, DetectorOptions } from '../core/types';

// MediaPipe Tasks 어댑터 공용 부분 (FaceDetector, FaceLandmarker). 메인 스레드에서도, 검출 Worker 안에서도 그대로 쓴다.
// - 모델은 Google 공식 저장소, WASM은 npm 패키지(jsDelivr, 버전 고정)에서 실행 중에 받는다. Worker(module) 안에서는 ES 모듈 WASM을 쓴다.
// - GPU를 요청하면 GPU로 먼저 만들고, 만들 때나 추론할 때 실패하면 CPU로 다시 만든다.
// - dispose()는 진행 중인 init·updateOptions도 바로 거부한다 (느린 초기화가 다음 교체를 막지 않게).
// 하위 클래스는 태스크 만들기·옵션 바꾸기·추론 결과 변환만 구현한다.

export const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/';
// package.json의 @mediapipe/tasks-vision 버전과 같아야 한다
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm';

export type Vision = typeof import('@mediapipe/tasks-vision');
export type WasmFileset = Awaited<ReturnType<Vision['FilesetResolver']['forVisionTasks']>>;
type ModuleFactory = (...args: unknown[]) => Promise<unknown>;
interface Loaded {
  lib: Vision;
  fileset: WasmFileset;
  moduleFactory: ModuleFactory | null; // Worker(ES 모듈 WASM)에서만
}
let vision: Promise<Loaded> | null = null;
const IN_WORKER = typeof document === 'undefined';

// MediaPipe 번들(빌드 후 약 154KB 청크)은 처음 쓸 때 불러온다 (앱 셸이 먼저 뜬다).
// MediaPipe는 태스크를 만들 때마다 WASM 로더를 다시 실행해 self.ModuleFactory를 얻고, 쓴 뒤 지운다.
// ES 모듈 로더는 다시 import 해도 캐시라 다시 실행되지 않으므로, 기본 export를 들고 있다가 만들 때마다 넣어 준다.
function loadVision(): Promise<Loaded> {
  vision ??= import('@mediapipe/tasks-vision')
    .then(async (lib) => {
      const fileset = await lib.FilesetResolver.forVisionTasks(WASM_BASE, IN_WORKER);
      const moduleFactory = IN_WORKER ? ((await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: ModuleFactory }).default : null;
      return { lib, fileset, moduleFactory };
    })
    .catch((err: unknown) => {
      vision = null; // 다음에 다시 시도
      throw withReloadHint(err);
    });
  return vision;
}

// MediaPipe는 CPU 실행 장치여도 입력 이미지를 WebGL2 텍스처로 올린다. WebGL2가 없으면 검출 자체가 안 된다.
let webgl2: boolean | null = null;
function hasWebGL2(): boolean {
  if (webgl2 === null) {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    webgl2 = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return webgl2;
}

export interface VisionTask {
  close(): void;
}

export abstract class MediaPipeTaskDetector<T extends VisionTask> implements Detector {
  readonly id: string;
  abstract readonly labels: string[];
  activeDelegate: Delegate | null = null;
  fallbackReason: string | null = null;

  protected opts: DetectorOptions = { delegate: 'GPU', minConfidence: 0.5, nmsThreshold: 0.3 };
  private task: T | null = null;
  private lastTimestamp = -1;
  private disposed = false;
  private readonly closed: Promise<never>; // dispose()하면 거부된다
  private rejectClosed: (err: Error) => void = () => {};

  constructor(id: string) {
    this.id = id;
    this.closed = new Promise<never>((_, reject) => (this.rejectClosed = reject));
    this.closed.catch(() => {}); // 기다리는 요청이 없어도 처리되지 않은 거부로 남지 않게
  }

  /** 지금 옵션(this.opts)으로 태스크를 만든다 (runningMode VIDEO) */
  protected abstract createTask(lib: Vision, fileset: WasmFileset, delegate: Delegate): Promise<T>;
  /** 실행 장치 말고 다른 옵션이 바뀌었을 때 태스크를 다시 만들지 않고 바꾼다. 바꿀 것이 없으면 null */
  protected abstract changeOptions(task: T, next: DetectorOptions, prev: DetectorOptions): Promise<void> | null;
  /** 동기 추론. 결과 좌표는 frame 픽셀 */
  protected abstract runTask(task: T, frame: ImageBitmap, timestampMs: number): Detection[];

  async init(opts: DetectorOptions): Promise<void> {
    this.opts = { ...opts };
    await this.create();
  }

  // 실행 장치가 바뀌면 태스크를 새로 만들고, 나머지는 하위 클래스가 바로 바꾼다.
  async updateOptions(patch: Partial<DetectorOptions>): Promise<void> {
    const next = { ...this.opts, ...patch };
    const prev = this.opts;
    this.opts = next;
    if (!this.task || next.delegate !== prev.delegate) {
      await this.create();
      return;
    }
    const pending = this.changeOptions(this.task, next, prev);
    if (pending) await this.untilClosed(pending);
  }

  /** frame의 소유권을 넘겨받는다 (다 쓰면 닫는다). */
  async detect(frame: ImageBitmap, timestampMs: number): Promise<Detection[]> {
    try {
      if (!this.task) throw new Error('Detector is not ready.');
      try {
        return this.run(this.task, frame, timestampMs);
      } catch (err) {
        if (this.activeDelegate !== 'GPU') throw err;
        // GPU 실행 중 실패하면 CPU로 다시 만들어 한 번 더 시도한다.
        console.warn(`[${this.id}] GPU inference failed, switching to CPU.`, err);
        await this.create('CPU', err);
        return this.run(this.task!, frame, timestampMs);
      }
    } finally {
      frame.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rejectClosed(closedError());
    this.closeTask();
  }

  private untilClosed<U>(p: Promise<U>): Promise<U> {
    return Promise.race([p, this.closed]);
  }

  private closeTask(): void {
    this.task?.close();
    this.task = null;
    this.activeDelegate = null;
  }

  private run(task: T, frame: ImageBitmap, timestampMs: number): Detection[] {
    // VIDEO 모드는 타임스탬프가 단조 증가해야 한다.
    const ts = Math.max(Math.round(timestampMs), this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    return this.runTask(task, frame, ts);
  }

  // GPU를 요청했으면 GPU로 먼저 만들고, 실패하면 CPU로 대체한다.
  private async create(force?: Delegate, gpuError?: unknown): Promise<void> {
    this.closeTask();
    if (this.disposed) throw closedError();
    const { lib, fileset, moduleFactory } = await this.untilClosed(loadVision());
    if (!hasWebGL2()) throw new Error('WebGL2 is not available. Check that hardware acceleration is enabled (chrome://gpu).');
    const make = async (delegate: Delegate): Promise<void> => {
      if (moduleFactory) (globalThis as { ModuleFactory?: ModuleFactory }).ModuleFactory = moduleFactory;
      const pending = this.createTask(lib, fileset, delegate);
      let task: T;
      try {
        task = await this.untilClosed(pending);
      } catch (err) {
        // 만드는 사이 닫혔다 (검출기 교체): 나중에 만들어지는 태스크도 닫는다
        if (this.disposed) pending.then((t) => t.close(), () => {});
        throw err;
      }
      if (this.disposed) {
        task.close();
        throw closedError();
      }
      this.task = task;
      this.activeDelegate = delegate;
    };
    const want = force ?? this.opts.delegate;
    this.fallbackReason = gpuError === undefined ? null : errorText(gpuError);
    if (want === 'GPU') {
      try {
        await make('GPU');
        return;
      } catch (err) {
        if (this.disposed) throw err;
        console.warn(`[${this.id}] Could not create the GPU delegate, falling back to CPU.`, err);
        this.fallbackReason = errorText(err);
      }
    }
    await make('CPU');
  }
}

function closedError(): Error {
  return new Error('Detector was closed.');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
