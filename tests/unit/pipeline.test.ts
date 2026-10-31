import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreParamSpecs, ParamStore } from '../../src/core/params';
import { Pipeline } from '../../src/core/pipeline';
import { Registry, type DetectorEntry } from '../../src/core/registry';
import type { Delegate, Detection, Detector, DetectorOptions, DrawOptions, Effect, ExecutionLocation, Frame, ParamSpec, Region, Size, Track } from '../../src/core/types';
import { pixelate } from '../../src/effects/pixelate';
import { solid } from '../../src/effects/solid';

// 파이프라인 로직(동기·비동기 표시, fail-closed, 백프레셔, 검출기 교체)을 가짜 검출기·렌더러로 확인한다.

// fail-closed 덮개는 OffscreenCanvas를 쓰므로 호출만 기록한다
const covers: unknown[] = [];
vi.mock('../../src/effects/cover', () => ({
  coverFrame: (_ctx: unknown, frame: unknown) => covers.push(frame),
}));

class FakeBitmap {
  closed = false;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close(): void {
    this.closed = true;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

class FakeDetector implements Detector {
  readonly labels = ['face'];
  activeDelegate: Delegate | null = null;
  fallbackReason: string | null = null;
  onError: ((err: Error) => void) | null = null;
  inits: DetectorOptions[] = [];
  updates: Partial<DetectorOptions>[] = [];
  inputs: { frame: ImageBitmap; ts: number }[] = [];
  disposed = false;
  block: Promise<void> | null = null; // 있으면 detect가 기다린다
  initBlock: Promise<void> | null = null;
  failInit = false;
  result: Detection[] = [{ label: 'face', score: 0.9, box: { x: 100, y: 100, width: 100, height: 100 } }];
  readonly id: string;
  readonly location: ExecutionLocation;
  private closing = deferred(); // dispose()하면 기다리던 요청이 거부된다 (DetectorProxy처럼)
  constructor(id: string, location: ExecutionLocation) {
    this.id = id;
    this.location = location;
  }
  async init(opts: DetectorOptions): Promise<void> {
    this.inits.push(opts);
    if (this.initBlock) await this.wait(this.initBlock);
    if (this.failInit) throw new Error('모델 없음');
    this.activeDelegate = opts.delegate;
  }
  async updateOptions(patch: Partial<DetectorOptions>): Promise<void> {
    this.updates.push(patch);
    if (patch.delegate) this.activeDelegate = patch.delegate;
  }
  // 입력의 소유권을 넘겨받으므로 다 쓰면 닫는다
  async detect(frame: ImageBitmap, ts: number): Promise<Detection[]> {
    this.inputs.push({ frame, ts });
    try {
      if (this.block) await this.wait(this.block);
      return this.result.map((d) => ({ ...d, box: { ...d.box } }));
    } finally {
      frame.close();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.closing.resolve();
  }
  private async wait(p: Promise<void>): Promise<void> {
    await Promise.race([p, this.closing.promise]);
    if (this.disposed) throw new Error('Detector closed.');
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// extraDetector: 자기 파라미터(params)를 들고 오는 세 번째 검출기 항목 (FaceLandmarker의 numFaces처럼)
function setup(extraEffects: Effect[] = [], extraDetector?: { id: string; params: ParamSpec[] }) {
  const created: FakeDetector[] = [];
  const next: { configure?: (d: FakeDetector) => void } = {};
  const entry = (id: string): DetectorEntry => ({
    id,
    label: id,
    create: (location) => {
      const d = new FakeDetector(id, location);
      next.configure?.(d);
      created.push(d);
      return d;
    },
  });
  const detectors = new Registry<DetectorEntry>().register(entry('mediapipe-face-short')).register(entry('mediapipe-face-full'));
  if (extraDetector) detectors.register({ ...entry(extraDetector.id), params: extraDetector.params });

  const applied: { effect: string; frame: CanvasImageSource; region: Region; params: Record<string, unknown> }[] = [];
  const fake = (base: Effect): Effect => ({ ...base, apply: (_ctx, frame, region, params) => applied.push({ effect: base.id, frame, region, params }) });
  const effects = new Registry<Effect>().register(fake(pixelate as Effect)).register(fake(solid as Effect));
  for (const e of extraEffects) effects.register(fake(e));

  const params = new ParamStore([
    ...coreParamSpecs(detectors.list(), effects.list()),
    ...effects.list().flatMap((e) => e.params),
    ...detectors.list().flatMap((d) => d.params ?? []),
  ]);
  const draws: { image: CanvasImageSource; mirror: boolean }[] = [];
  const renderer = {
    frameId: null as number | null,
    onResize: null as (() => void) | null,
    draw(image: CanvasImageSource, _size: Size, opts: DrawOptions, paint?: (ctx: CanvasRenderingContext2D) => void): void {
      renderer.frameId = opts.frameId;
      draws.push({ image, mirror: opts.mirror });
      paint?.({} as CanvasRenderingContext2D);
    },
    clear: vi.fn((): void => {
      renderer.frameId = null;
    }),
  };
  const clock = { now: 0 };
  const pipeline = new Pipeline({ renderer, params, detectors, effects, now: () => clock.now });
  return { pipeline, params, created, next, applied, draws, renderer, clock };
}

let frameId = 0;
function frame(ts: number, width = 640, height = 480, streamId = 'cam-a'): Frame & { bitmap: ImageBitmap & FakeBitmap } {
  return { id: ++frameId, timestampMs: ts, streamId, bitmap: new FakeBitmap(width, height) as unknown as ImageBitmap & FakeBitmap, width, height };
}

async function ready(t: ReturnType<typeof setup>): Promise<FakeDetector> {
  t.pipeline.syncDetector();
  await flush();
  expect(t.pipeline.detectorState).toBe('ready');
  return t.created[t.created.length - 1]!;
}

// 검출기 입력은 파이프라인이 createImageBitmap으로 따로 만든다 (추론 해상도로 줄인 복사본)
let resized: { w: number; h: number }[] = [];
function stubCreateImageBitmap(): void {
  resized = [];
  vi.stubGlobal('createImageBitmap', async (_src: unknown, o: ImageBitmapOptions) => {
    resized.push({ w: o.resizeWidth!, h: o.resizeHeight! });
    return new FakeBitmap(o.resizeWidth!, o.resizeHeight!);
  });
}

describe('Pipeline', () => {
  beforeEach(() => {
    frameId = 0;
    covers.length = 0;
    stubCreateImageBitmap();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('검출기가 준비되기 전 프레임은 그리지 않고 닫는다', async () => {
    const t = setup();
    const f = frame(0);
    t.pipeline.push(f);
    t.pipeline.syncDetector();
    expect(t.pipeline.detectorState).toBe('loading');
    const g = frame(10);
    t.pipeline.push(g);
    await flush();
    expect(f.bitmap.closed && g.bitmap.closed).toBe(true);
    expect(t.draws).toHaveLength(0);
    expect(t.pipeline.detectorState).toBe('ready');
    expect(t.created[0]!.inits[0]).toEqual({ delegate: 'GPU', minConfidence: 0.5, nmsThreshold: 0.3 });
  });

  it('동기 모드: 분석한 바로 그 프레임을 그 검출 결과(패딩 적용)와 함께 그린다', async () => {
    const t = setup();
    const det = await ready(t);
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    // 검출기에는 따로 만든 입력을 넘기고(소유권도), 화면에는 원본 프레임을 그린다
    const input = det.inputs[0]!.frame as unknown as FakeBitmap;
    expect(input).not.toBe(f.bitmap);
    expect([input.width, input.height, input.closed]).toEqual([640, 480, true]);
    expect(t.draws).toHaveLength(1);
    expect(t.draws[0]!.image).toBe(f.bitmap);
    expect(t.pipeline.drawnFrameId).toBe(f.id);
    expect(t.pipeline.detectionFrameId).toBe(f.id);
    expect(t.pipeline.frameCount).toBe(1);
    // 100x100 박스 × 패딩 1.3 → 130x130, 중심 유지
    expect(t.pipeline.regions).toEqual([{ x: 85, y: 85, width: 130, height: 130 }]);
    expect(t.applied).toHaveLength(1);
    expect(t.applied[0]).toMatchObject({ effect: 'pixelate', frame: f.bitmap, region: { kind: 'rect', rect: { x: 85, y: 85, width: 130, height: 130 } } });
    expect(t.applied[0]!.params).toEqual({ blockMode: 'relative', blockCells: 10, blockSize: 16, strength: 1 });
    expect(f.bitmap.closed).toBe(false); // 다시 그리기용으로 들고 있다
  });

  it('백프레셔: 추론 중에는 차례가 온 프레임도 버리고 센다', async () => {
    const t = setup();
    const det = await ready(t);
    const gate = deferred();
    det.block = gate.promise;
    const f1 = frame(0);
    const f2 = frame(200);
    const f3 = frame(400);
    t.pipeline.push(f1);
    await flush();
    t.pipeline.push(f2);
    t.pipeline.push(f3);
    expect(t.pipeline.droppedFrames).toBe(2);
    expect(f2.bitmap.closed && f3.bitmap.closed).toBe(true);
    expect(det.inputs).toHaveLength(1);
    gate.resolve();
    await flush();
    expect(t.pipeline.drawnFrameId).toBe(f1.id);
    // 끝난 뒤에는 다시 받는다
    det.block = null;
    const f4 = frame(600);
    t.pipeline.push(f4);
    await flush();
    expect(t.pipeline.drawnFrameId).toBe(f4.id);
    expect(f1.bitmap.closed).toBe(true); // 이전 분석 프레임은 닫힌다
  });

  it('목표 FPS 차례가 아닌 프레임은 세지 않고 건너뛴다', async () => {
    const t = setup();
    await ready(t); // 목표 8fps → 125ms 간격
    const frames = [0, 66, 133, 200, 266].map((ts) => frame(ts));
    for (const f of frames) {
      t.pipeline.push(f);
      await flush();
    }
    expect(t.draws.map((d) => d.image)).toEqual([frames[0]!.bitmap, frames[2]!.bitmap, frames[4]!.bitmap]);
    expect(t.pipeline.droppedFrames).toBe(0);
  });

  it('reset: 진행 중인 추론 결과를 버리고 화면과 통계를 비운다', async () => {
    const t = setup();
    const det = await ready(t);
    const gate = deferred();
    det.block = gate.promise;
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    t.pipeline.reset();
    gate.resolve();
    await flush();
    expect(t.draws).toHaveLength(0);
    expect(f.bitmap.closed).toBe(true);
    expect(t.pipeline.frameCount).toBe(0);
    expect(t.pipeline.drawnFrameId).toBeNull();
    expect(t.renderer.clear).toHaveBeenCalled();
  });

  it('모델을 바꾸면 불러오는 동안 새 프레임을 그리지 않고 마지막 분석 프레임만 남긴다', async () => {
    const t = setup();
    const short = await ready(t);
    const f1 = frame(0);
    t.pipeline.push(f1);
    await flush();
    const load = deferred();
    t.next.configure = (d) => (d.initBlock = load.promise);
    t.params.set('model', 'mediapipe-face-full');
    expect(t.pipeline.detectorState).toBe('loading');
    const f2 = frame(500);
    t.pipeline.push(f2);
    await flush();
    expect(f2.bitmap.closed).toBe(true);
    expect(t.pipeline.drawnFrameId).toBe(f1.id);
    // 불러오는 동안 바꾼 표시 파라미터도 마지막 분석 프레임으로 다시 그린다
    t.params.set('mirror', false);
    expect(t.draws.at(-1)).toEqual({ image: f1.bitmap, mirror: false });
    expect(f1.bitmap.closed).toBe(false);

    load.resolve();
    await flush();
    expect(short.disposed).toBe(true);
    expect(t.pipeline.detectorState).toBe('ready');
    expect(t.pipeline.detectorId).toBe('mediapipe-face-full');
    const f3 = frame(1000);
    t.pipeline.push(f3);
    await flush();
    expect(t.created[1]!.inputs).toHaveLength(1);
    expect(t.pipeline.drawnFrameId).toBe(f3.id);
  });

  it('연달아 바꾸면 마지막 모델만 만든다', async () => {
    const t = setup();
    await ready(t);
    t.params.set('model', 'mediapipe-face-full');
    t.params.set('model', 'mediapipe-face-short');
    t.params.set('model', 'mediapipe-face-full');
    await flush();
    expect(t.created.map((d) => d.id)).toEqual(['mediapipe-face-short', 'mediapipe-face-full']);
    expect(t.pipeline.detectorState).toBe('ready');
  });

  it('신뢰도·NMS는 다시 만들지 않고 updateOptions, 실행 장치는 loading을 거쳐 updateOptions', async () => {
    const t = setup();
    const det = await ready(t);
    t.params.set('minConfidence', 0.99);
    expect(t.pipeline.detectorState).toBe('ready');
    await flush();
    expect(det.updates.at(-1)).toEqual({ delegate: 'GPU', minConfidence: 0.99, nmsThreshold: 0.3 });
    t.params.set('delegate', 'CPU');
    expect(t.pipeline.detectorState).toBe('loading');
    await flush();
    expect(t.pipeline.detectorState).toBe('ready');
    expect(det.updates.at(-1)).toMatchObject({ delegate: 'CPU' });
    expect(t.pipeline.activeDelegate).toBe('CPU');
    expect(t.created).toHaveLength(1);
    expect(det.inits).toHaveLength(1);
  });

  it('추론 해상도: 줄인 입력으로 검출하고 박스를 원본 좌표로 되돌린다', async () => {
    const t = setup();
    const det = await ready(t);
    t.params.set('inferenceSize', 320);
    t.params.set('padding', 1);
    det.result = [{ label: 'face', score: 0.9, box: { x: 50, y: 40, width: 60, height: 60 }, keypoints: [{ x: 80, y: 70 }] }];
    t.pipeline.push(frame(0));
    await flush();
    expect(resized).toEqual([{ w: 320, h: 240 }]);
    expect((det.inputs[0]!.frame as unknown as FakeBitmap).width).toBe(320);
    expect((det.inputs[0]!.frame as unknown as FakeBitmap).closed).toBe(true); // 축소본은 검출기가 닫는다
    expect(t.pipeline.detections[0]!.box).toEqual({ x: 100, y: 80, width: 120, height: 120 });
    expect(t.pipeline.detections[0]!.keypoints).toEqual([{ x: 160, y: 140 }]);
    expect(t.pipeline.regions).toEqual([{ x: 100, y: 80, width: 120, height: 120 }]);
  });

  it('표시 파라미터를 바꾸면 같은 프레임·같은 검출 결과로 다시 그린다', async () => {
    const t = setup();
    await ready(t);
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    t.params.set('padding', 2);
    expect(t.draws).toHaveLength(2);
    expect(t.draws[1]!.image).toBe(f.bitmap);
    expect(t.pipeline.regions).toEqual([{ x: 50, y: 50, width: 200, height: 200 }]);
    t.params.set('effect', 'solid');
    expect(t.applied.at(-1)).toMatchObject({ effect: 'solid', params: { solidColor: '#000000' } });
    expect(t.pipeline.frameCount).toBe(1); // 다시 그리기는 새 프레임으로 세지 않는다
    expect(t.pipeline.drawnFrameId).toBe(f.id);
  });

  it('모자이크 영역은 프레임 밖으로 나가지 않는다', async () => {
    const t = setup();
    const det = await ready(t);
    det.result = [{ label: 'face', score: 0.9, box: { x: 0, y: 0, width: 100, height: 100 } }];
    t.pipeline.push(frame(0));
    await flush();
    expect(t.pipeline.regions).toEqual([{ x: 0, y: 0, width: 115, height: 115 }]);
  });

  it('프레임 가장자리에 걸친 박스는 자르기 전에 패딩한다 (안쪽 여백 = 0.15 × 실제 얼굴 크기)', async () => {
    const t = setup();
    const det = await ready(t);
    // 640×480 프레임, 패딩 1.3. 오른쪽 아래로 나간 얼굴과 왼쪽 위로 나간 얼굴.
    det.result = [
      { label: 'face', score: 0.9, box: { x: 540, y: 380, width: 200, height: 200 } },
      { label: 'face', score: 0.9, box: { x: -100, y: -80, width: 200, height: 200 } },
    ];
    t.pipeline.push(frame(0));
    await flush();
    // 자른 뒤 패딩하면 {525, 365, 115, 115}, {0, 0, 115, 138}이 되어 안쪽 여백이 줄어든다
    expect(t.pipeline.regions).toEqual([
      { x: 510, y: 350, width: 130, height: 130 },
      { x: 0, y: 0, width: 130, height: 150 },
    ]);
    expect(540 - t.pipeline.regions[0]!.x).toBe(0.15 * 200);
    // 이펙트는 그릴 영역(잘림)과 자르기 전 영역을 함께 받는다 (상대 블록 크기 기준)
    expect(t.applied.map((a) => a.region)).toEqual([
      { kind: 'rect', rect: { x: 510, y: 350, width: 130, height: 130 }, unclipped: { x: 510, y: 350, width: 260, height: 260 } },
      { kind: 'rect', rect: { x: 0, y: 0, width: 130, height: 150 }, unclipped: { x: -130, y: -110, width: 260, height: 260 } },
    ]);
    // 검출 결과는 자르지 않은 원본 박스 그대로
    expect(t.pipeline.detections.map((d) => d.box)).toEqual(det.result.map((d) => d.box));
  });

  it('패딩한 영역이 프레임에 걸치면 박스가 밖에 있어도 가리고, 걸치지 않으면 건너뛴다', async () => {
    const t = setup();
    const det = await ready(t);
    t.params.set('padding', 2);
    det.result = [
      { label: 'face', score: 0.9, box: { x: -110, y: 100, width: 100, height: 100 } }, // 패딩하면 -160..40
      { label: 'face', score: 0.9, box: { x: 800, y: 100, width: 50, height: 50 } }, // 패딩해도 775..875
    ];
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    expect(t.pipeline.regions).toEqual([{ x: 0, y: 50, width: 40, height: 200 }]);
    expect(t.applied).toHaveLength(1);
    expect(t.draws.at(-1)!.image).toBe(f.bitmap);
  });

  it('새 이펙트의 파라미터도 코어를 고치지 않고 이펙트에 전달되고, 바꾸면 다시 그린다', async () => {
    const blur: Effect = {
      id: 'blur',
      label: '블러',
      params: [{ key: 'blurRadius', label: '반경', type: 'number', min: 1, max: 20, step: 1, default: 5 }],
      apply: () => {},
    };
    const t = setup([blur]);
    await ready(t);
    expect(t.params.set('effect', 'blur')).toBe(true);
    t.pipeline.push(frame(0));
    await flush();
    expect(t.applied.at(-1)).toMatchObject({ effect: 'blur', params: { blurRadius: 5 } });
    const draws = t.draws.length;
    expect(t.params.set('blurRadius', 9)).toBe(true);
    expect(t.draws).toHaveLength(draws + 1);
    expect(t.applied.at(-1)).toMatchObject({ effect: 'blur', params: { blurRadius: 9 } });
  });

  it('신뢰도·NMS를 연달아 바꾸면 updateOptions는 한 번만, 최신 값으로', async () => {
    const t = setup();
    const det = await ready(t);
    t.params.set('minConfidence', 0.6);
    t.params.set('minConfidence', 0.7);
    t.params.set('nmsThreshold', 0.4);
    await flush();
    expect(det.updates).toEqual([{ delegate: 'GPU', minConfidence: 0.7, nmsThreshold: 0.4 }]);
    // 추론 중에 바꾼 값도 하나로 모인다
    const gate = deferred();
    det.block = gate.promise;
    t.pipeline.push(frame(0));
    await flush();
    for (const v of [0.8, 0.85, 0.9]) t.params.set('minConfidence', v);
    gate.resolve();
    await flush();
    expect(det.updates).toHaveLength(2);
    expect(det.updates[1]).toEqual({ delegate: 'GPU', minConfidence: 0.9, nmsThreshold: 0.4 });
  });

  it('FPS 측정 창은 목표 FPS를 따른다 (1fps에서도 0으로 읽히지 않게)', () => {
    const t = setup();
    const inference = vi.spyOn(t.pipeline.inferenceFps, 'setTargetFps');
    const render = vi.spyOn(t.pipeline.renderFps, 'setTargetFps');
    t.params.set('targetFps', 1);
    expect(inference).toHaveBeenCalledWith(1);
    expect(render).toHaveBeenCalledWith(1);
  });

  it('drawnFrameId는 렌더러가 마지막으로 그린 프레임이다', async () => {
    const t = setup();
    await ready(t);
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    expect(t.pipeline.drawnFrameId).toBe(f.id);
    // 다른 경로로 그리면 검출이 끝난 프레임과 달라진다
    t.renderer.draw(f.bitmap, { width: 640, height: 480 }, { mirror: false, frameId: 999 });
    expect(t.pipeline.drawnFrameId).toBe(999);
    expect(t.pipeline.detectionFrameId).toBe(f.id);
    t.pipeline.reset();
    expect(t.pipeline.drawnFrameId).toBeNull();
  });

  it('검출기를 만들지 못하면 error 상태이고 프레임을 그리지 않는다. 설정을 바꾸면 다시 시도한다', async () => {
    const t = setup();
    t.next.configure = (d) => (d.failInit = true);
    t.pipeline.syncDetector();
    await flush();
    expect(t.pipeline.detectorState).toBe('error');
    expect(t.pipeline.detectorError).toMatch(/Failed to load detector.*모델 없음/);
    expect(t.created[0]!.disposed).toBe(true);
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    expect(f.bitmap.closed).toBe(true);
    expect(t.draws).toHaveLength(0);

    t.next.configure = undefined;
    t.params.set('delegate', 'CPU');
    await flush();
    expect(t.pipeline.detectorState).toBe('ready');
  });

  it('추론이 실패하면 error 상태가 된다', async () => {
    const t = setup();
    const det = await ready(t);
    det.detect = async () => {
      throw new Error('GL lost');
    };
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    expect(t.pipeline.detectorState).toBe('error');
    expect(t.pipeline.detectorError).toMatch(/GL lost/);
    expect(f.bitmap.closed).toBe(true);
    expect(det.disposed).toBe(true);
  });

  it('트리거 훅은 분석한 프레임마다 트랙 목록을 받는다', async () => {
    const t = setup();
    await ready(t);
    const trigger = vi.fn(() => []);
    t.pipeline.trigger = trigger;
    t.pipeline.push(frame(5));
    await flush();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith([expect.objectContaining({ id: 1, label: 'face' })], 5);
  });

  it('캔버스 크기가 바뀌면 마지막 분석 프레임을 다시 그린다', async () => {
    const t = setup();
    await ready(t);
    const f = frame(0);
    t.pipeline.push(f);
    await flush();
    t.renderer.onResize?.();
    expect(t.draws).toHaveLength(2);
    expect(t.draws[1]!.image).toBe(f.bitmap);
  });
});

describe('Pipeline: 비동기 표시·fail-closed·실행 위치', () => {
  beforeEach(() => {
    frameId = 0;
    covers.length = 0;
    stubCreateImageBitmap();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 비동기 표시로 준비된 파이프라인. 시계는 프레임 시각을 따라간다.
  async function asyncReady() {
    const t = setup();
    t.params.set('displayMode', 'async');
    const det = await ready(t);
    const push = async (ts: number, streamId?: string): Promise<Frame & { bitmap: ImageBitmap & FakeBitmap }> => {
      t.clock.now = ts;
      const f = frame(ts, 640, 480, streamId);
      t.pipeline.push(f);
      await flush();
      return f;
    };
    return { t, det, push };
  }

  it('카메라 프레임마다 그리고, 박스는 최신 검출 결과를 쓴다 (첫 결과 전에는 전체를 가린다)', async () => {
    const { t, det, push } = await asyncReady();
    const f1 = await push(0); // 결과 전: 전체를 가리고, 검출을 시작
    const f2 = await push(66); // 목표 8fps라 차례가 아님: f1의 결과로 그린다
    const f3 = await push(133); // 차례: f1 결과로 그리고 f3 검출
    const f4 = await push(200);
    expect(t.pipeline.renders().map((r) => [r.frameId, r.detectionFrameId, r.mode, r.fullCover])).toEqual([
      [f1.id, null, 'async', true],
      [f2.id, f1.id, 'async', false],
      [f3.id, f1.id, 'async', false],
      [f4.id, f3.id, 'async', false],
    ]);
    expect(covers).toEqual([f1.bitmap]);
    expect(t.draws.map((d) => d.image)).toEqual([f1.bitmap, f2.bitmap, f3.bitmap, f4.bitmap]);
    expect(t.pipeline.frameCount).toBe(4);
    expect(det.inputs).toHaveLength(2); // 검출은 목표 FPS대로
    expect(t.pipeline.regions).toEqual([{ x: 85, y: 85, width: 130, height: 130 }]); // 패딩도 적용
    expect(t.applied.at(-1)!.frame).toBe(f4.bitmap);
    expect([f1, f2, f3].every((f) => f.bitmap.closed)).toBe(true); // 화면에서 밀려난 프레임은 닫는다
    expect(f4.bitmap.closed).toBe(false);
    expect(t.pipeline.detectionFrameId).toBe(f3.id);
    expect(t.pipeline.drawnFrameId).toBe(f4.id);
  });

  it('검출 결과가 제한 시간(1초)보다 오래되면 화면 전체를 가리고, 새 결과가 오면 되돌아온다', async () => {
    const { t, det, push } = await asyncReady();
    await push(0);
    const gate = deferred();
    det.block = gate.promise; // 다음 검출이 멈춘다
    await push(125);
    for (let ts = 200; ts <= 1000; ts += 100) await push(ts);
    expect(t.pipeline.renders().at(-1)).toMatchObject({ fullCover: false, detectionFrameId: 1 }); // 1000ms: 아직 믿는다
    expect(t.pipeline.failClosedReason(1000)).toBeNull();
    await push(1100);
    expect(t.pipeline.renders().at(-1)).toMatchObject({ fullCover: true, detectionFrameId: null });
    expect(t.pipeline.failClosedReason(1100)).toBe('stalled');
    expect(t.pipeline.coverDrawn).toBe(true);
    expect(t.pipeline.regions).toEqual([{ x: 0, y: 0, width: 640, height: 480 }]);
    // 멈췄던 검출(125ms 프레임)이 늦게 끝나도 결과가 오래되어 계속 가린다
    det.block = null;
    gate.resolve();
    await flush();
    await push(1200);
    expect(t.pipeline.renders().at(-1)!.fullCover).toBe(true);
    // 그 다음 차례 프레임의 결과는 새롭다
    const fresh = t.pipeline.renders().at(-1)!.frameId; // 1200ms 프레임은 차례라 검출했다
    await push(1266);
    expect(t.pipeline.renders().at(-1)).toMatchObject({ fullCover: false, detectionFrameId: fresh });
  });

  it('검출기를 불러오는 중이거나 오류면 전체를 가린다', async () => {
    const { t, det, push } = await asyncReady();
    await push(0);
    await push(66);
    const load = deferred();
    t.next.configure = (d) => (d.initBlock = load.promise);
    t.params.set('model', 'mediapipe-face-full');
    expect(t.pipeline.failClosedReason(100)).toBe('loading');
    await push(100);
    expect(t.pipeline.renders().at(-1)).toMatchObject({ fullCover: true, mode: 'async' });
    load.resolve();
    await flush();
    expect(det.disposed).toBe(true);
    await push(200);
    await push(266);
    expect(t.pipeline.renders().at(-1)!.fullCover).toBe(false);

    t.created[1]!.detect = async (f) => {
      f.close();
      throw new Error('GL lost');
    };
    await push(400);
    expect(t.pipeline.detectorState).toBe('error');
    expect(t.pipeline.failClosedReason(400)).toBe('error');
    await push(466);
    expect(t.pipeline.renders().at(-1)!.fullCover).toBe(true);
  });

  it('카메라 해상도가 바뀌면 이전 크기의 결과로 박스를 그리지 않는다', async () => {
    const { t, push } = await asyncReady();
    await push(0);
    t.clock.now = 66;
    t.pipeline.push(frame(66, 1280, 720));
    await flush();
    expect(t.pipeline.renders().at(-1)!.fullCover).toBe(true);
  });

  it('같은 해상도의 다른 카메라로 바꾸면 이전 카메라의 결과(진행 중이던 것 포함)를 쓰지 않고, 새 카메라의 첫 결과까지 전체를 가린다', async () => {
    const { t, det, push } = await asyncReady();
    await push(0);
    await push(66);
    const gate = deferred();
    det.block = gate.promise;
    await push(133); // 이전 카메라 프레임의 검출이 멈춰 있다
    expect(t.pipeline.renders().at(-1)).toMatchObject({ fullCover: false, detectionFrameId: 1 });
    const b1 = await push(200, 'cam-b');
    expect(t.pipeline.renders().at(-1)).toMatchObject({ frameId: b1.id, fullCover: true, detectionFrameId: null });
    expect(t.pipeline.failClosedReason(200)).toBe('waiting');
    expect(t.pipeline.drawnFrameId).toBe(b1.id); // 화면은 비우지 않는다
    // 이전 카메라 프레임의 검출이 늦게 끝나도 버린다
    det.block = null;
    gate.resolve();
    await flush();
    const b2 = await push(266, 'cam-b');
    expect(t.pipeline.renders().at(-1)).toMatchObject({ frameId: b2.id, fullCover: true });
    const b3 = await push(333, 'cam-b');
    expect(t.pipeline.renders().at(-1)).toMatchObject({ frameId: b3.id, fullCover: false, detectionFrameId: b2.id });
  });

  it('동기 표시: 카메라를 바꾸면 진행 중이던 이전 카메라 프레임은 그리지 않는다', async () => {
    const t = setup();
    const det = await ready(t);
    t.pipeline.push(frame(0));
    await flush();
    const gate = deferred();
    det.block = gate.promise;
    const a = frame(133);
    t.pipeline.push(a);
    await flush();
    t.pipeline.push(frame(200, 640, 480, 'cam-b')); // 추론 중이라 버린다
    gate.resolve();
    await flush();
    expect(a.bitmap.closed).toBe(true);
    expect(t.pipeline.drawnFrameId).toBe(1); // 마지막 분석 프레임(이전 카메라) 그대로
    const b = frame(266, 640, 480, 'cam-b');
    t.pipeline.push(b);
    await flush();
    expect(t.pipeline.renders().at(-1)).toMatchObject({ frameId: b.id, detectionFrameId: b.id, mode: 'sync' });
  });

  it('동기로 바꾸면 비동기로 그린 프레임을 지우고, 이후 그린 프레임은 모두 그 프레임의 검출 결과로 그린다', async () => {
    const { t, push } = await asyncReady();
    for (const ts of [0, 66, 133]) await push(ts);
    const before = t.pipeline.renders().at(-1)!.seq;
    t.params.set('displayMode', 'sync');
    expect(t.pipeline.drawnFrameId).toBeNull();
    expect(t.renderer.clear).toHaveBeenCalled();
    for (const ts of [266, 333, 400, 466, 533]) await push(ts);
    const after = t.pipeline.renders(before);
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const r of after) expect([r.mode, r.frameId, r.fullCover]).toEqual(['sync', r.detectionFrameId, false]);
  });

  it('시험용 고장: delay는 검출을 늦추고, error는 검출기를 오류 상태로 만든다', async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const det = await (async () => {
        t.pipeline.syncDetector();
        await vi.advanceTimersByTimeAsync(0);
        return t.created[0]!;
      })();
      t.pipeline.fault = { kind: 'delay', ms: 3000 };
      t.pipeline.push(frame(0));
      await vi.advanceTimersByTimeAsync(2900);
      expect(t.draws).toHaveLength(0);
      expect(det.inputs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(t.draws).toHaveLength(1);
      expect(t.pipeline.inferenceMs).toBeGreaterThanOrEqual(3000);

      t.pipeline.fault = { kind: 'error' };
      const f = frame(5000);
      t.pipeline.push(f);
      await vi.advanceTimersByTimeAsync(0);
      expect(t.pipeline.detectorState).toBe('error');
      expect(t.pipeline.detectorError).toMatch(/Simulated detection failure/);
      expect(f.bitmap.closed).toBe(true);
      expect(det.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('요청 밖의 검출기 오류(onError)도 오류 상태가 된다. 이미 바꾼 검출기의 오류는 무시한다', async () => {
    const t = setup();
    const det = await ready(t);
    expect(det.onError).toBeTypeOf('function');
    t.params.set('location', 'main');
    await flush();
    const next = t.created[1]!;
    det.onError?.(new Error('예전 Worker'));
    expect(t.pipeline.detectorState).toBe('ready');
    next.onError?.(new Error('Worker가 죽었습니다'));
    expect(t.pipeline.detectorState).toBe('error');
    expect(t.pipeline.detectorError).toBe('Detector error: Worker가 죽었습니다');
    expect(next.disposed).toBe(true);
    expect(t.pipeline.executionLocation).toBeNull();
  });

  it('실행 위치를 바꾸면 팩토리에 위치를 넘겨 새로 만들고, 멈춘 요청을 기다리지 않고 이전 검출기를 바로 닫는다', async () => {
    const t = setup();
    const worker = await ready(t);
    expect(worker.location).toBe('worker');
    expect(t.pipeline.executionLocation).toBe('worker');
    worker.block = new Promise(() => {}); // 영원히 끝나지 않는 추론 (멈춘 Worker)
    const f1 = frame(0);
    t.pipeline.push(f1);
    await flush();
    t.params.set('location', 'main');
    expect(worker.disposed).toBe(true); // 바로 닫는다
    await flush();
    expect(t.pipeline.detectorState).toBe('ready');
    expect(t.created.map((d) => d.location)).toEqual(['worker', 'main']);
    expect(t.pipeline.executionLocation).toBe('main');
    expect(f1.bitmap.closed).toBe(true); // 끊긴 요청의 프레임은 그리지 않고 닫는다
    expect(t.draws).toHaveLength(0);
    t.pipeline.push(frame(500));
    await flush();
    expect(t.draws).toHaveLength(1);
    // 같은 위치에서 실행 장치만 바꾸면 다시 만들지 않는다
    t.params.set('delegate', 'CPU');
    await flush();
    expect(t.created).toHaveLength(2);
  });

  it('초기화가 멈춘 검출기도 다시 바꾸면 닫고 새로 만든다', async () => {
    const t = setup();
    t.next.configure = (d) => (d.initBlock = new Promise(() => {}));
    t.pipeline.syncDetector();
    await flush();
    expect(t.pipeline.detectorState).toBe('loading');
    t.next.configure = undefined;
    t.params.set('location', 'main');
    await flush();
    expect(t.created[0]!.disposed).toBe(true);
    expect(t.pipeline.detectorState).toBe('ready');
    expect(t.pipeline.detectorId).toBe('mediapipe-face-short');
    expect(t.pipeline.executionLocation).toBe('main');
  });

  it('failClosedReason: 시작 직후 waiting → 제한 시간이 지나도 결과가 없으면 stalled', async () => {
    const t = setup();
    expect(t.pipeline.failClosedReason(0)).toBe('loading');
    t.clock.now = 0;
    await ready(t);
    const gate = deferred();
    t.created[0]!.block = gate.promise;
    t.pipeline.push(frame(50));
    await flush();
    expect(t.pipeline.failClosedReason(500)).toBe('waiting');
    expect(t.pipeline.failClosedReason(1100)).toBe('stalled');
    t.params.set('targetFps', 1); // 1fps면 제한 시간이 2초
    expect(t.pipeline.failClosedReason(1100)).toBe('waiting');
    gate.resolve();
    await flush();
    expect(t.pipeline.failClosedReason(1100)).toBeNull();
    // 정지 뒤 다시 시작하면 첫 프레임이 올 때까지 waiting (검출기가 오래전에 준비됐어도 stalled가 아니다)
    t.pipeline.reset();
    expect(t.pipeline.failClosedReason(9000)).toBe('waiting');
  });

  it('그리기 기록은 seq로 이어 받을 수 있고 최근 600개만 남는다', async () => {
    const t = setup();
    await ready(t);
    t.pipeline.push(frame(0));
    await flush();
    const first = t.pipeline.renders();
    expect(first).toHaveLength(1);
    for (let i = 0; i < 700; i++) t.params.set('padding', i % 2 ? 1.5 : 1.6); // 다시 그리기도 기록된다
    const all = t.pipeline.renders();
    expect(all).toHaveLength(600);
    expect(all.at(-1)!.seq).toBe(701);
    expect(t.pipeline.renders(699).map((r) => r.seq)).toEqual([700, 701]);
  });
});

describe('Pipeline: 비동기 프레임은 검출기 상태가 바뀌면 바로 다시 그린다', () => {
  beforeEach(() => {
    frameId = 0;
    covers.length = 0;
    stubCreateImageBitmap();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('오류가 나면 다음 카메라 프레임을 기다리지 않고 화면 전체를 가린다', async () => {
    const t = setup();
    t.params.set('displayMode', 'async');
    const det = await ready(t);
    for (const ts of [0, 66]) {
      t.clock.now = ts;
      t.pipeline.push(frame(ts));
      await flush();
    }
    expect(t.pipeline.coverDrawn).toBe(false);
    det.onError?.(new Error('Worker가 죽었습니다'));
    expect(t.pipeline.coverDrawn).toBe(true);
    expect(t.pipeline.renders().at(-1)).toMatchObject({ frameId: 2, fullCover: true, detectionFrameId: null });
  });
});

describe('Pipeline: 트래커 (P4)', () => {
  beforeEach(() => {
    frameId = 0;
    covers.length = 0;
    stubCreateImageBitmap();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 목표 8fps 차례에 맞춰 프레임을 하나씩 넣고 처리가 끝날 때까지 기다린다
  async function pushAt(t: ReturnType<typeof setup>, ts: number, streamId = 'cam-a'): Promise<Frame> {
    const f = frame(ts, 640, 480, streamId);
    t.clock.now = ts;
    t.pipeline.push(f);
    await flush();
    return f;
  }

  it('동기 모드: 검출이 끊겨도 유지 시간 동안 마지막 박스로 가리고, 지나면 없앤다', async () => {
    const t = setup();
    const det = await ready(t);
    await pushAt(t, 0);
    expect(t.pipeline.renders().at(-1)!.tracks).toEqual([{ id: 1, held: false }]);
    det.result = [];
    for (const ts of [125, 250, 375]) {
      await pushAt(t, ts);
      expect(t.pipeline.detections, `${ts}ms`).toEqual([]);
      expect(t.pipeline.regions, `${ts}ms`).toEqual([{ x: 85, y: 85, width: 130, height: 130 }]);
      expect(t.pipeline.renders().at(-1)).toMatchObject({ timestampMs: ts, tracks: [{ id: 1, held: true }] });
    }
    await pushAt(t, 500); // 마지막 검출(0ms) 뒤 400ms가 지났다
    expect(t.pipeline.regions).toEqual([]);
    expect(t.pipeline.renders().at(-1)!.tracks).toEqual([]);
  });

  it('유지 시간 파라미터를 따른다 (0이면 검출이 끊긴 프레임에 바로 없앤다)', async () => {
    const t = setup();
    const det = await ready(t);
    t.params.set('holdMs', 0);
    await pushAt(t, 0);
    det.result = [];
    await pushAt(t, 125);
    expect(t.pipeline.regions).toEqual([]);
  });

  it('트랙 id는 움직여도 유지되고, 트리거 훅은 트래커를 거친 트랙을 받는다. reset 뒤에는 1부터', async () => {
    const t = setup();
    const det = await ready(t);
    const seen: Track[][] = [];
    t.pipeline.trigger = (tracks) => {
      seen.push([...tracks]);
      return [];
    };
    for (let i = 0; i < 6; i++) {
      det.result = [
        { label: 'face', score: 0.9, box: { x: 100 + 8 * i, y: 100, width: 100, height: 100 } },
        { label: 'face', score: 0.9, box: { x: 400 - 8 * i, y: 150, width: 90, height: 90 } },
      ];
      await pushAt(t, i * 125);
    }
    expect(seen.map((tracks) => tracks.map((x) => x.id))).toEqual(Array.from({ length: 6 }, () => [1, 2]));
    expect(t.pipeline.tracks.tracks.map((x) => x.id)).toEqual([1, 2]);
    t.pipeline.reset();
    det.result = [{ label: 'face', score: 0.9, box: { x: 300, y: 300, width: 50, height: 50 } }];
    await pushAt(t, 2000);
    expect(t.pipeline.tracks.tracks.map((x) => x.id)).toEqual([1]);
  });

  it('카메라를 바꾸면 이전 카메라의 트랙을 유지하지 않는다', async () => {
    const t = setup();
    const det = await ready(t);
    await pushAt(t, 0, 'cam-a');
    det.result = [];
    await pushAt(t, 125, 'cam-b');
    expect(t.pipeline.tracks.tracks).toEqual([]);
    expect(t.pipeline.regions).toEqual([]);
  });

  it('스무딩한 트랙 박스로 가린다: 박스가 떨려도 모자이크 영역은 그 프레임의 검출 박스(패딩)를 덮는다', async () => {
    const t = setup();
    const det = await ready(t);
    const xs = [100, 104, 97, 103, 99, 105, 96];
    for (const [i, x] of xs.entries()) {
      det.result = [{ label: 'face', score: 0.9, box: { x, y: 100, width: 100, height: 100 } }];
      await pushAt(t, i * 125);
      const r = t.pipeline.regions[0]!;
      const padded = { x: x - 15, y: 85, width: 130, height: 130 };
      expect(r.x <= padded.x && r.x + r.width >= padded.x + padded.width && r.y <= padded.y && r.y + r.height >= padded.y + padded.height, `frame ${i}`).toBe(true);
    }
    // 스무딩을 끄면 검출 박스 그대로
    t.params.set('smoothing', false);
    det.result = [{ label: 'face', score: 0.9, box: { x: 110, y: 100, width: 100, height: 100 } }];
    await pushAt(t, 7 * 125);
    expect(t.pipeline.regions).toEqual([{ x: 95, y: 85, width: 130, height: 130 }]);
  });

  it('모양을 타원으로 바꾸면 이펙트가 ellipse 영역을 받고, 같은 프레임을 다시 그린다', async () => {
    const t = setup();
    await ready(t);
    const f = await pushAt(t, 0);
    t.params.set('shape', 'ellipse');
    expect(t.draws.at(-1)!.image).toBe(f.bitmap);
    expect(t.applied.at(-1)!.region).toEqual({ kind: 'ellipse', rect: { x: 85, y: 85, width: 130, height: 130 }, unclipped: { x: 85, y: 85, width: 130, height: 130 } });
    expect(t.pipeline.frameCount).toBe(1);
  });

  it('검출마다 inferences() 기록을 남긴다 (프레임, 시간, 검출 수)', async () => {
    const t = setup();
    const det = await ready(t);
    await pushAt(t, 0);
    det.result = [];
    await pushAt(t, 125);
    const log = t.pipeline.inferences();
    expect(log.map((r) => [r.seq, r.frameId, r.count])).toEqual([
      [1, 1, 1],
      [2, 2, 0],
    ]);
    expect(log.every((r) => r.ms >= 0)).toBe(true);
    expect(t.pipeline.inferences(1).map((r) => r.seq)).toEqual([2]);
  });

  it('검출기가 들고 온 파라미터는 extra로 넘어가고, 바꾸면 다시 만들지 않고 updateOptions로 넘긴다', async () => {
    const params: ParamSpec[] = [{ key: 'numFaces', label: '최대 얼굴 수', type: 'number', min: 1, max: 8, step: 1, default: 4 }];
    const t = setup([], { id: 'landmarker', params });
    t.params.set('model', 'landmarker');
    const det = await ready(t);
    expect(det.id).toBe('landmarker');
    expect(det.inits[0]).toEqual({ delegate: 'GPU', minConfidence: 0.5, nmsThreshold: 0.3, extra: { numFaces: 4 } });
    t.params.set('numFaces', 2);
    await flush();
    expect(det.updates.at(-1)).toEqual({ delegate: 'GPU', minConfidence: 0.5, nmsThreshold: 0.3, extra: { numFaces: 2 } });
    expect(t.created).toHaveLength(1);
    // 그 파라미터가 없는 검출기로 바꾸면 extra도 없다
    t.params.set('model', 'mediapipe-face-short');
    await flush();
    expect(t.created.at(-1)!.inits[0]).toEqual({ delegate: 'GPU', minConfidence: 0.5, nmsThreshold: 0.3 });
  });
});
