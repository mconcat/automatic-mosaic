import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockedRequests } from '../../src/core/local-only';
import type { WorkerReply, WorkerRequest } from '../../src/detectors/worker/protocol';
import { crashDetectorWorkers, DetectorProxy, workerStats } from '../../src/detectors/worker/proxy';

// DetectorProxy의 RPC를 가짜 Worker로 확인한다: 요청 id, transfer, 오류 전달, dispose, 늦은 응답.

type Listener = (ev: unknown) => void;

class FakeWorker {
  posted: { msg: WorkerRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, l: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: Listener): void {
    this.listeners.get(type)?.delete(l);
  }
  postMessage(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.posted.push({ msg, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  // Worker → 메인
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  reply(data: WorkerReply): void {
    this.emit('message', { data });
  }
  ok(id: number, extra: Partial<Extract<WorkerReply, { type: 'result' }>> = {}): void {
    this.reply({ type: 'result', id, ok: true, activeDelegate: 'GPU', fallbackReason: null, ...extra });
  }
  last(): WorkerRequest {
    return this.posted.at(-1)!.msg;
  }
  lastId(): number {
    return (this.last() as { id: number }).id;
  }
}

const bitmap = (): ImageBitmap & { close: ReturnType<typeof vi.fn> } => ({ width: 64, height: 48, close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const OPTS = { delegate: 'GPU' as const, minConfidence: 0.5, nmsThreshold: 0.3 };

async function initialized(): Promise<{ proxy: DetectorProxy; worker: FakeWorker }> {
  const worker = new FakeWorker();
  const proxy = new DetectorProxy('mediapipe-face-short', ['face'], { kind: 'mediapipe-face', model: 'short' }, () => worker as unknown as Worker);
  const init = proxy.init(OPTS);
  expect(worker.last()).toMatchObject({ type: 'init', detectorId: 'mediapipe-face-short', spec: { kind: 'mediapipe-face', model: 'short' }, opts: OPTS });
  worker.ok(worker.lastId());
  await init;
  return { proxy, worker };
}

describe('DetectorProxy', () => {
  let live0 = 0;
  beforeEach(() => {
    live0 = workerStats.live;
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init은 Worker를 만들고 실행 장치 상태를 응답에서 받는다', async () => {
    const created = workerStats.created;
    const { proxy } = await initialized();
    expect(proxy.activeDelegate).toBe('GPU');
    expect(workerStats.created).toBe(created + 1);
    expect(workerStats.live).toBe(live0 + 1);
    proxy.dispose();
    expect(workerStats.live).toBe(live0);
  });

  it('detect는 프레임을 복사하지 않고 transfer 하고, 응답을 id로 짝짓는다', async () => {
    const { proxy, worker } = await initialized();
    const a = bitmap();
    const b = bitmap();
    const pa = proxy.detect(a, 10);
    const pb = proxy.detect(b, 20);
    const [ma, mb] = worker.posted.slice(-2);
    expect(ma!.msg).toMatchObject({ type: 'detect', frame: a, timestampMs: 10 });
    expect(ma!.transfer).toEqual([a]);
    expect(mb!.transfer).toEqual([b]);
    const ida = (ma!.msg as { id: number }).id;
    const idb = (mb!.msg as { id: number }).id;
    expect(ida).not.toBe(idb);
    // 순서를 바꿔 응답해도 각자의 결과를 받는다
    const box = { x: 1, y: 2, width: 3, height: 4 };
    worker.ok(idb, { detections: [{ label: 'face', score: 0.8, box }] });
    worker.ok(ida, { detections: [], activeDelegate: 'CPU', fallbackReason: 'FP16 없음' });
    expect(await pb).toEqual([{ label: 'face', score: 0.8, box }]);
    expect(await pa).toEqual([]);
    expect(proxy.activeDelegate).toBe('CPU');
    expect(proxy.fallbackReason).toBe('FP16 없음');
    proxy.dispose();
  });

  it('Worker 안의 오류는 그 요청의 거부로 전달된다', async () => {
    const { proxy, worker } = await initialized();
    const p = proxy.updateOptions({ delegate: 'CPU' });
    expect(worker.last()).toMatchObject({ type: 'update', patch: { delegate: 'CPU' } });
    worker.reply({ type: 'result', id: worker.lastId(), ok: false, error: 'WebGL2를 쓸 수 없습니다.', activeDelegate: null, fallbackReason: null });
    await expect(p).rejects.toThrow('WebGL2를 쓸 수 없습니다.');
    proxy.dispose();
  });

  it('dispose는 Worker를 끝내고 기다리던 요청을 거부하며, 그 뒤 늦게 온 응답은 무시한다', async () => {
    const { proxy, worker } = await initialized();
    const onError = vi.fn();
    proxy.onError = onError;
    const p = proxy.detect(bitmap(), 1);
    const id = worker.lastId();
    proxy.dispose();
    expect(worker.terminated).toBe(true);
    await expect(p).rejects.toThrow('Detector closed.');
    worker.ok(id, { detections: [{ label: 'face', score: 1, box: { x: 0, y: 0, width: 1, height: 1 } }] }); // 늦은 응답
    expect(onError).not.toHaveBeenCalled();
    expect(workerStats.live).toBe(live0);
    // 닫은 뒤의 요청은 보내지 않고 거부한다 (넘겨받은 프레임은 닫는다)
    const late = bitmap();
    const posted = worker.posted.length;
    await expect(proxy.detect(late, 2)).rejects.toThrow('Detector closed.');
    expect(late.close).toHaveBeenCalled();
    expect(worker.posted).toHaveLength(posted);
    proxy.dispose(); // 두 번 불러도 괜찮다
    expect(workerStats.live).toBe(live0);
  });

  it('잡히지 않은 Worker 오류는 기다리던 요청을 거부하고, Worker를 끝내고, onError로 알린다', async () => {
    const { proxy, worker } = await initialized();
    const onError = vi.fn();
    proxy.onError = onError;
    const p = proxy.detect(bitmap(), 1);
    const ev = { message: 'Uncaught Error: boom', preventDefault: vi.fn() };
    worker.emit('error', ev);
    await expect(p).rejects.toThrow('Detection worker error: Uncaught Error: boom');
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toBe('Detection worker error: Uncaught Error: boom');
    expect(worker.terminated).toBe(true);
    expect(proxy.activeDelegate).toBeNull();
    expect(workerStats.live).toBe(live0);
    await expect(proxy.updateOptions({})).rejects.toThrow('boom');
  });

  it('Worker 스크립트를 불러오지 못하면 init이 거부된다', async () => {
    const worker = new FakeWorker();
    const proxy = new DetectorProxy('x', ['face'], { kind: 'mediapipe-face', model: 'full' }, () => worker as unknown as Worker);
    const init = proxy.init(OPTS);
    worker.emit('error', { message: '', preventDefault: () => {} });
    await expect(init).rejects.toThrow('Failed to start the detection worker.');
    expect(workerStats.live).toBe(live0);
  });

  it('Worker가 막은 외부 요청은 메인의 blockedRequests에 남는다', async () => {
    const { proxy, worker } = await initialized();
    worker.reply({ type: 'blocked', url: 'https://odml.pa.googleapis.com/v1/log' });
    expect(blockedRequests.at(-1)).toBe('https://odml.pa.googleapis.com/v1/log');
    proxy.dispose();
  });

  it('crashDetectorWorkers는 살아 있는 Worker에만 crash를 보낸다 (시험용)', async () => {
    const a = await initialized();
    const b = await initialized();
    b.proxy.dispose();
    expect(crashDetectorWorkers()).toBe(1);
    expect(a.worker.last()).toEqual({ type: 'crash' });
    expect(b.worker.last()).not.toEqual({ type: 'crash' });
    a.proxy.dispose();
    expect(crashDetectorWorkers()).toBe(0);
    await flush();
  });
});
