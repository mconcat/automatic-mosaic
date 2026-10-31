import { noteBlocked, noteProgress } from '../../core/local-only';
import type { Delegate, Detection, Detector, DetectorOptions } from '../../core/types';
import type { HostedSpec, WorkerReply, WorkerRequest } from './protocol';

// Worker 경계를 감추는 Detector (PLAN §2.2). 파이프라인은 메인 스레드 검출기와 똑같이 쓴다.
// 요청마다 id를 붙여 응답과 짝을 맞추고, 프레임(ImageBitmap)은 복사하지 않고 transfer 한다.
// dispose()는 Worker를 끝내고 기다리던 요청을 모두 거부한다. 그 뒤에 오는 응답은 무시한다.

/** 만든 Worker 수와 아직 살아 있는 Worker 수 (모니터·테스트용) */
export const workerStats = { created: 0, live: 0 };
const liveWorkers = new Set<Worker>();

export type WorkerFactory = () => Worker;

const spawnDetectorWorker: WorkerFactory = () => new Worker(new URL('./detector.worker.ts', import.meta.url), { type: 'module', name: 'detector' });

type ResultReply = Extract<WorkerReply, { type: 'result' }>;

interface Pending {
  resolve: (reply: ResultReply) => void;
  reject: (err: Error) => void;
}

export class DetectorProxy implements Detector {
  readonly id: string;
  readonly labels: string[];
  activeDelegate: Delegate | null = null;
  fallbackReason: string | null = null;
  onError: ((err: Error) => void) | null = null;

  private readonly spec: HostedSpec;
  private readonly spawn: WorkerFactory;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed: Error | null = null; // dispose 또는 Worker 오류로 닫힌 이유

  constructor(id: string, labels: string[], spec: HostedSpec, spawn: WorkerFactory = spawnDetectorWorker) {
    this.id = id;
    this.labels = labels;
    this.spec = spec;
    this.spawn = spawn;
  }

  async init(opts: DetectorOptions): Promise<void> {
    if (this.worker || this.closed) throw new Error('Detector already initialized or closed.');
    const worker = this.spawn();
    this.worker = worker;
    workerStats.created++;
    workerStats.live++;
    liveWorkers.add(worker);
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onWorkerError);
    worker.addEventListener('messageerror', this.onMessageError);
    await this.request((id) => ({ type: 'init', id, detectorId: this.id, spec: this.spec, opts }));
  }

  async updateOptions(patch: Partial<DetectorOptions>): Promise<void> {
    await this.request((id) => ({ type: 'update', id, patch }));
  }

  /** frame은 Worker로 transfer 된다 (호출 뒤에는 쓸 수 없다). */
  async detect(frame: ImageBitmap, timestampMs: number): Promise<Detection[]> {
    const reply = await this.request((id) => ({ type: 'detect', id, frame, timestampMs }), frame);
    return reply.detections ?? [];
  }

  dispose(): void {
    this.shutdown(new Error('Detector closed.'));
  }

  private request(make: (id: number) => WorkerRequest, frame?: ImageBitmap): Promise<ResultReply> {
    const worker = this.worker;
    if (this.closed || !worker) {
      frame?.close();
      return Promise.reject(this.closed ?? new Error('Detector not initialized.'));
    }
    const id = this.nextId++;
    return new Promise<ResultReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage(make(id), frame ? [frame] : []);
      } catch (err) {
        this.pending.delete(id);
        frame?.close();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage = (ev: MessageEvent<WorkerReply>): void => {
    if (this.closed) return; // 닫은 뒤 늦게 온 응답
    const msg = ev.data;
    if (msg.type === 'blocked') {
      noteBlocked(msg.url);
      return;
    }
    if (msg.type === 'download') {
      noteProgress(msg.progress);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    this.activeDelegate = msg.activeDelegate;
    this.fallbackReason = msg.fallbackReason;
    if (msg.ok) pending.resolve(msg);
    else pending.reject(new Error(msg.error ?? 'Detection worker error'));
  };

  private onWorkerError = (ev: ErrorEvent): void => {
    ev.preventDefault();
    this.crash(new Error(ev.message ? `Detection worker error: ${ev.message}` : 'Failed to start the detection worker.'));
  };

  private onMessageError = (): void => {
    this.crash(new Error('Failed to read a detection worker message.'));
  };

  // 잡히지 않은 Worker 오류: 기다리던 요청을 거부하고 Worker를 끝낸 뒤 호출부에 알린다 (조용히 묻히지 않게).
  private crash(err: Error): void {
    if (this.closed) return;
    this.shutdown(err);
    this.onError?.(err);
  }

  private shutdown(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    const worker = this.worker;
    if (worker) {
      worker.removeEventListener('message', this.onMessage);
      worker.removeEventListener('error', this.onWorkerError);
      worker.removeEventListener('messageerror', this.onMessageError);
      worker.terminate();
      liveWorkers.delete(worker);
      workerStats.live--;
    }
    this.worker = null;
    this.activeDelegate = null;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }
}

/** 시험용: 살아 있는 검출 Worker마다 잡히지 않는 오류를 내게 한다. 보낸 Worker 수를 돌려준다. */
export function crashDetectorWorkers(): number {
  const msg: WorkerRequest = { type: 'crash' };
  for (const worker of liveWorkers) worker.postMessage(msg);
  return liveWorkers.size;
}
