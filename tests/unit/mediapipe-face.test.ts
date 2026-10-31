import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toDetection } from '../../src/detectors/mediapipe-face';

describe('toDetection (MediaPipe → 공통 Detection)', () => {
  it('박스는 입력 픽셀 그대로, 키포인트는 정규화 좌표에 입력 크기를 곱한다', () => {
    const d = toDetection(
      {
        categories: [{ score: 0.92, index: 0, categoryName: '', displayName: '' }],
        boundingBox: { originX: 283, originY: 115, width: 234, height: 234, angle: 0 },
        keypoints: [
          { x: 0.5, y: 0.25 },
          { x: 0.1, y: 0.9, label: 'mouth', score: 1 },
        ],
      },
      640,
      480,
    );
    expect(d).toEqual({
      label: 'face',
      score: 0.92,
      box: { x: 283, y: 115, width: 234, height: 234 },
      keypoints: [
        { x: 320, y: 120 },
        { x: 64, y: 432 },
      ],
    });
  });

  it('점수·박스가 없으면 0', () => {
    const d = toDetection({ categories: [], keypoints: [] }, 10, 10);
    expect(d.score).toBe(0);
    expect(d.box).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(d.keypoints).toEqual([]);
  });
});

// 메인 스레드 어댑터도 Detector 계약대로 dispose()가 진행 중인 init·updateOptions를 바로 끊는지 본다.
// MediaPipe는 가짜로 바꾸고, 로더(forVisionTasks)와 태스크 만들기(createFromOptions)를 테스트가 쥔다.
const mp = vi.hoisted(() => ({
  fileset: Promise.resolve({}) as Promise<unknown>,
  create: (): Promise<unknown> => new Promise(() => {}),
  creates: 0,
}));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: () => mp.fileset },
  FaceDetector: {
    createFromOptions: () => {
      mp.creates++;
      return mp.create();
    },
  },
}));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const OPTS = { delegate: 'GPU' as const, minConfidence: 0.5, nmsThreshold: 0.3 };
const fakeTask = () => ({ close: vi.fn(), setOptions: vi.fn(async () => {}) });

describe('MediaPipeFaceDetector.dispose (메인 스레드)', () => {
  // 로더 캐시는 모듈 안에 있으므로 테스트마다 모듈을 새로 불러온다. document가 있어야 메인 스레드 경로다.
  async function load() {
    vi.resetModules();
    return (await import('../../src/detectors/mediapipe-face')).MediaPipeFaceDetector;
  }

  beforeEach(() => {
    mp.creates = 0;
    vi.stubGlobal('document', {});
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): unknown {
          return { getExtension: () => null };
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('WASM 로더가 응답하지 않아도 dispose()하면 init이 바로 거부된다', async () => {
    const MediaPipeFaceDetector = await load();
    mp.fileset = new Promise(() => {});
    const d = new MediaPipeFaceDetector('mediapipe-face-short', 'short');
    const init = d.init(OPTS);
    await flush();
    d.dispose();
    await expect(init).rejects.toThrow(/닫은 검출기입니다|closed/i);
    expect(mp.creates).toBe(0);
  });

  it('태스크를 만드는 중에 닫으면 바로 거부하고, 늦게 만들어진 태스크는 닫는다', async () => {
    const MediaPipeFaceDetector = await load();
    mp.fileset = Promise.resolve({});
    const made = deferred<ReturnType<typeof fakeTask>>();
    mp.create = () => made.promise;
    const d = new MediaPipeFaceDetector('mediapipe-face-short', 'short');
    const init = d.init(OPTS);
    await flush();
    expect(mp.creates).toBe(1);
    d.dispose();
    await expect(init).rejects.toThrow(/닫은 검출기입니다|closed/i);
    expect(mp.creates).toBe(1); // GPU 실패로 보고 CPU로 다시 만들지 않는다
    const late = fakeTask();
    made.resolve(late);
    await flush();
    expect(late.close).toHaveBeenCalledTimes(1);
  });

  it('실행 장치를 바꾸는 중(updateOptions)에도 dispose()하면 바로 거부된다', async () => {
    const MediaPipeFaceDetector = await load();
    mp.fileset = Promise.resolve({});
    const first = fakeTask();
    mp.create = async () => first;
    const d = new MediaPipeFaceDetector('mediapipe-face-short', 'short');
    await d.init(OPTS);
    expect(d.activeDelegate).toBe('GPU');
    mp.create = () => new Promise(() => {}); // 새 태스크가 끝나지 않는다
    const update = d.updateOptions({ delegate: 'CPU' });
    await flush();
    expect(first.close).toHaveBeenCalledTimes(1);
    d.dispose();
    await expect(update).rejects.toThrow(/닫은 검출기입니다|closed/i);
    expect(d.activeDelegate).toBeNull();
  });
});
