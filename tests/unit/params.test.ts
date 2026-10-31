import { describe, expect, it, vi } from 'vitest';
import { coreParamSpecs, DEFAULT_PARAMS, normalizeParam, ParamStore } from '../../src/core/params';
import type { ParamSpec } from '../../src/core/types';
import { pixelate } from '../../src/effects/pixelate';
import { solid } from '../../src/effects/solid';

const models = [
  { id: 'mediapipe-face-short', label: 'short' },
  { id: 'mediapipe-face-full', label: 'full' },
];
const effects = [
  { id: 'pixelate', label: 'Pixelate' },
  { id: 'solid', label: '단색' },
];
const specs: ParamSpec[] = [...coreParamSpecs(models, effects), ...pixelate.params, ...solid.params];
// 스토어의 기본값: 코어 + 이펙트 스키마의 기본값
const defaults = { ...DEFAULT_PARAMS, blockMode: 'relative', blockCells: 10, blockSize: 16, strength: 1, solidColor: '#000000' };

function store(): ParamStore {
  return new ParamStore(specs);
}

describe('normalizeParam', () => {
  const num: ParamSpec = { key: 'n', label: 'n', type: 'number', min: 0.1, max: 0.99, step: 0.01, default: 0.5 };

  it('숫자는 범위로 자르고 step에 맞춘다', () => {
    expect(normalizeParam(num, 0.5, 0)).toBe(0.5);
    expect(normalizeParam(num, 0.123, 0)).toBe(0.12);
    expect(normalizeParam(num, 0.99, 0)).toBe(0.99);
    expect(normalizeParam(num, 5, 0)).toBe(0.99);
    expect(normalizeParam(num, -1, 0)).toBe(0.1);
  });

  it('정수 step', () => {
    const fps: ParamSpec = { key: 'f', label: 'f', type: 'number', min: 1, max: 15, step: 1, default: 8 };
    expect(normalizeParam(fps, 7.6, 0)).toBe(8);
  });

  it('타입이 다르거나 NaN이면 거부한다', () => {
    expect(normalizeParam(num, '0.5', 0)).toBeUndefined();
    expect(normalizeParam(num, Number.NaN, 0)).toBeUndefined();
    expect(normalizeParam(undefined, 1, true)).toBeUndefined();
  });

  it('선택지는 목록에 있는 값만 받는다', () => {
    const sel: ParamSpec = { key: 's', label: 's', type: 'select', options: [{ label: 'a', value: 320 }], default: 320 };
    expect(normalizeParam(sel, 320, 0)).toBe(320);
    expect(normalizeParam(sel, 321, 0)).toBeUndefined();
  });

  it('색은 #rrggbb만 받고 소문자로 바꾼다', () => {
    const color: ParamSpec = { key: 'c', label: 'c', type: 'color', default: '#000000' };
    expect(normalizeParam(color, '#AbCdEf', '')).toBe('#abcdef');
    expect(normalizeParam(color, 'red', '')).toBeUndefined();
  });
});

describe('ParamStore', () => {
  it('기본값은 PLAN §4 값(코어 + 이펙트 스키마)이고 스키마를 통과한다', () => {
    const s = store();
    expect(s.snapshot()).toEqual(defaults);
    for (const spec of specs) expect(normalizeParam(spec, spec.default, spec.default), spec.key).toBe(spec.default);
    for (const spec of coreParamSpecs(models, effects)) expect(spec.default, spec.key).toBe(DEFAULT_PARAMS[spec.key as keyof typeof DEFAULT_PARAMS]);
    expect(s.snapshot()).toMatchObject({
      mirror: true,
      delegate: 'GPU',
      minConfidence: 0.5,
      nmsThreshold: 0.3,
      inferenceSize: 640,
      targetFps: 8,
      blockMode: 'relative',
      blockSize: 16,
      blockCells: 10,
      padding: 1.3,
      strength: 1,
      debug: false,
    });
  });

  it('바뀐 값만 구독자에게 알린다', () => {
    const s = store();
    const listener = vi.fn();
    s.subscribe(listener);
    expect(s.set('blockSize', 32)).toBe(true);
    expect(s.set('blockSize', 32)).toBe(true); // 같은 값: 알리지 않는다
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('blockSize');
    expect(s.get('blockSize')).toBe(32);
  });

  it('맞지 않는 값은 거부하고 그대로 둔다', () => {
    const s = store();
    const listener = vi.fn();
    s.subscribe(listener);
    expect(s.set('model', 'nope')).toBe(false);
    expect(s.set('effect', 'blur')).toBe(false);
    expect(s.set('delegate', 'TPU' as never)).toBe(false);
    expect(s.set('inferenceSize', 300)).toBe(false);
    expect(s.set('mirror', 'yes' as never)).toBe(false);
    expect(s.set('nothing', 1)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(s.snapshot()).toEqual(defaults);
  });

  it('상속된 키(__proto__, toString, constructor)는 모르는 키로 거부한다', () => {
    const s = store();
    for (const key of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
      expect(s.set(key, { mirror: false } as never), key).toBe(false);
      expect(s.get(key), key).toBeUndefined();
    }
    expect(Object.getPrototypeOf(s.snapshot())).toBe(Object.prototype);
    expect(s.snapshot()).toEqual(defaults);
  });

  it('새 이펙트의 파라미터는 코어를 고치지 않고 스키마만으로 붙는다 (기본값·검사·알림)', () => {
    const blur: ParamSpec = { key: 'blurRadius', label: '반경', type: 'number', min: 1, max: 20, step: 1, default: 5 };
    const s = new ParamStore([...specs, blur]);
    const listener = vi.fn();
    s.subscribe(listener);
    expect(s.get('blurRadius')).toBe(5);
    expect(s.snapshot().blurRadius).toBe(5);
    expect(s.set('blurRadius', 7.4)).toBe(true);
    expect(s.get('blurRadius')).toBe(7);
    expect(listener).toHaveBeenCalledWith('blurRadius');
    expect(s.set('blurRadius', 'x')).toBe(false);
    expect(s.set('blurRadius', 99)).toBe(true);
    expect(s.get('blurRadius')).toBe(20);
  });

  it('레지스트리 선택지와 넓힌 신뢰도 범위(0.99)를 받는다', () => {
    const s = store();
    expect(s.set('model', 'mediapipe-face-full')).toBe(true);
    expect(s.set('effect', 'solid')).toBe(true);
    expect(s.set('minConfidence', 0.99)).toBe(true);
    expect(s.get('minConfidence')).toBe(0.99);
    expect(s.set('inferenceSize', 0)).toBe(true); // 원본
  });

  it('숫자는 범위·step에 맞춰 저장한다', () => {
    const s = store();
    s.set('padding', 1.333);
    expect(s.get('padding')).toBe(1.35);
    s.set('targetFps', 100);
    expect(s.get('targetFps')).toBe(15);
    s.set('strength', -2);
    expect(s.get('strength')).toBe(0);
  });

  it('카메라 장치는 스키마 없이 문자열이면 받는다', () => {
    const s = store();
    expect(s.set('deviceId', 'abc')).toBe(true);
    expect(s.get('deviceId')).toBe('abc');
  });

  it('구독을 해제할 수 있다', () => {
    const s = store();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    off();
    s.set('debug', true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('초기값도 검사한다', () => {
    const s = new ParamStore(specs, { targetFps: 99, model: 'nope' });
    expect(s.get('targetFps')).toBe(15);
    expect(s.get('model')).toBe(DEFAULT_PARAMS.model);
  });
});

describe('coreParamSpecs', () => {
  it('모델·이펙트 선택지는 레지스트리 목록에서 온다', () => {
    const core = coreParamSpecs(models, effects);
    const model = core.find((s) => s.key === 'model');
    const effect = core.find((s) => s.key === 'effect');
    expect(model?.type === 'select' && model.options.map((o) => o.value)).toEqual(['mediapipe-face-short', 'mediapipe-face-full']);
    expect(effect?.type === 'select' && effect.options.map((o) => o.value)).toEqual(['pixelate', 'solid']);
  });

  it('스키마 키가 겹치지 않고, 코어 스키마는 코어 키·이펙트 스키마는 이펙트 키만 쓴다', () => {
    const keys = specs.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const spec of coreParamSpecs(models, effects)) expect(Object.hasOwn(DEFAULT_PARAMS, spec.key), spec.key).toBe(true);
    for (const spec of [...pixelate.params, ...solid.params]) expect(Object.hasOwn(DEFAULT_PARAMS, spec.key), spec.key).toBe(false);
  });

  it('신뢰도·NMS 슬라이더는 놓을 때만 반영한다 (MediaPipe 그래프를 다시 만든다)', () => {
    const release = coreParamSpecs(models, effects).filter((s) => s.applyOnRelease).map((s) => s.key);
    expect(release).toEqual(['minConfidence', 'nmsThreshold']);
  });

  it('실행 위치는 Worker(기본)/메인, 표시 모드는 동기(기본)/비동기만 받는다', () => {
    const s = new ParamStore(specs);
    expect([s.get('location'), s.get('displayMode')]).toEqual(['worker', 'sync']);
    expect(s.set('location', 'main')).toBe(true);
    expect(s.set('location', 'gpu')).toBe(false);
    expect(s.set('displayMode', 'async')).toBe(true);
    expect(s.set('displayMode', 'fast')).toBe(false);
    expect([s.get('location'), s.get('displayMode')]).toEqual(['main', 'async']);
  });
});
