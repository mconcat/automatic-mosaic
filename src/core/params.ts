import type { Delegate, DisplayMode, ExecutionLocation, ParamSpec, ParamValue, RegionShape } from './types';

// PLAN §4 파라미터 중 이펙트와 무관한 것. 모든 단계가 ParamStore를 구독해 재시작 없이 바로 반영한다.
// 이펙트 파라미터(키·범위·기본값)는 각 이펙트의 params 스키마에 있고, 스토어는 받은 스키마에서 키를 모은다.
export type Params = {
  deviceId: string; // '' = 기본 카메라
  mirror: boolean;
  model: string; // Detector 레지스트리 id
  location: ExecutionLocation; // 검출기를 돌릴 곳
  delegate: Delegate;
  minConfidence: number;
  nmsThreshold: number;
  inferenceSize: number; // 추론 입력의 긴 변 px. 0 = 원본
  targetFps: number;
  holdMs: number; // 검출이 끊긴 트랙을 유지하는 시간
  smoothing: boolean; // 트랙 박스 One Euro 스무딩
  minCutoff: number; // One Euro minCutoff (Hz)
  beta: number; // One Euro beta
  iouThreshold: number; // 트랙 매칭 IoU 임계
  effect: string; // Effect 레지스트리 id
  shape: RegionShape; // 모자이크 영역 모양
  padding: number; // 박스 확장 배율
  displayMode: DisplayMode;
  debug: boolean;
};

export type ParamKey = keyof Params;

/** 스토어의 모든 값: 코어 파라미터 + 등록된 이펙트의 파라미터 */
export type ParamValues = Params & Record<string, ParamValue>;

export const DEFAULT_PARAMS: Readonly<Params> = {
  deviceId: '',
  mirror: true,
  model: 'mediapipe-face-short',
  location: 'worker',
  delegate: 'GPU',
  minConfidence: 0.5,
  nmsThreshold: 0.3,
  inferenceSize: 640,
  targetFps: 8,
  holdMs: 400,
  smoothing: true,
  minCutoff: 1,
  beta: 0.01,
  iouThreshold: 0.3,
  effect: 'pixelate',
  shape: 'rect',
  padding: 1.3,
  displayMode: 'sync',
  debug: false,
};

export interface Choice {
  id: string;
  label: string;
}

// 이펙트와 무관한 파라미터의 스키마. 모델·이펙트 선택지는 레지스트리에서 온다.
// 카메라 장치(deviceId)는 선택지가 실행 중에 바뀌므로 스키마 없이 패널이 따로 다룬다.
export function coreParamSpecs(models: readonly Choice[], effects: readonly Choice[]): ParamSpec[] {
  return [
    { key: 'mirror', label: 'Mirror', type: 'boolean', default: DEFAULT_PARAMS.mirror },
    { key: 'model', label: 'Model', type: 'select', options: models.map((m) => ({ label: m.label, value: m.id })), default: DEFAULT_PARAMS.model },
    {
      key: 'location',
      label: 'Run on',
      type: 'select',
      options: [
        { label: 'Worker', value: 'worker' },
        { label: 'Main thread', value: 'main' },
      ],
      default: DEFAULT_PARAMS.location,
    },
    {
      key: 'delegate',
      label: 'Delegate',
      type: 'select',
      options: [
        { label: 'GPU', value: 'GPU' },
        { label: 'CPU', value: 'CPU' },
      ],
      default: DEFAULT_PARAMS.delegate,
    },
    // PLAN은 0.1–0.9지만 "0.99면 검출 0개" 확인을 UI로도 할 수 있게 0.99까지 둔다.
    // 신뢰도·NMS는 바꿀 때마다 MediaPipe 그래프를 다시 만들므로 슬라이더를 놓을 때만 반영한다.
    { key: 'minConfidence', label: 'Min confidence', type: 'number', min: 0.1, max: 0.99, step: 0.01, default: DEFAULT_PARAMS.minConfidence, applyOnRelease: true },
    { key: 'nmsThreshold', label: 'NMS threshold', type: 'number', min: 0.1, max: 0.9, step: 0.01, default: DEFAULT_PARAMS.nmsThreshold, applyOnRelease: true },
    {
      key: 'inferenceSize',
      label: 'Inference size',
      type: 'select',
      options: [
        { label: '320', value: 320 },
        { label: '480', value: 480 },
        { label: '640', value: 640 },
        { label: 'Original', value: 0 },
      ],
      default: DEFAULT_PARAMS.inferenceSize,
    },
    { key: 'targetFps', label: 'Target FPS', type: 'number', min: 1, max: 15, step: 1, default: DEFAULT_PARAMS.targetFps },
    { key: 'holdMs', label: 'Hold (ms)', type: 'number', min: 0, max: 2000, step: 50, default: DEFAULT_PARAMS.holdMs },
    { key: 'smoothing', label: 'Smoothing', type: 'boolean', default: DEFAULT_PARAMS.smoothing },
    { key: 'minCutoff', label: 'minCutoff', type: 'number', min: 0.05, max: 5, step: 0.05, default: DEFAULT_PARAMS.minCutoff, visibleIf: { key: 'smoothing', equals: true } },
    { key: 'beta', label: 'beta', type: 'number', min: 0, max: 0.2, step: 0.001, default: DEFAULT_PARAMS.beta, visibleIf: { key: 'smoothing', equals: true } },
    { key: 'iouThreshold', label: 'IoU threshold', type: 'number', min: 0.05, max: 0.95, step: 0.05, default: DEFAULT_PARAMS.iouThreshold },
    { key: 'effect', label: 'Effect', type: 'select', options: effects.map((e) => ({ label: e.label, value: e.id })), default: DEFAULT_PARAMS.effect },
    {
      key: 'shape',
      label: 'Shape',
      type: 'select',
      options: [
        { label: 'Rectangle', value: 'rect' },
        { label: 'Ellipse', value: 'ellipse' },
      ],
      default: DEFAULT_PARAMS.shape,
    },
    { key: 'padding', label: 'Padding', type: 'number', min: 1, max: 2, step: 0.05, default: DEFAULT_PARAMS.padding },
    {
      key: 'displayMode',
      label: 'Display mode',
      type: 'select',
      options: [
        { label: 'Sync', value: 'sync' },
        { label: 'Async', value: 'async' },
      ],
      default: DEFAULT_PARAMS.displayMode,
    },
    { key: 'debug', label: 'Debug overlay', type: 'boolean', default: DEFAULT_PARAMS.debug },
  ];
}

function decimals(step: number): number {
  const s = String(step);
  return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
}

// 스키마에 맞는 값으로 바꾼다. 타입은 현재 값(current)과 같아야 하고, 숫자는 범위로 자르고 step에 맞춘다
// (UI 슬라이더와 같은 값이 되게). 맞지 않으면 undefined.
export function normalizeParam(spec: ParamSpec | undefined, value: unknown, current: unknown): unknown {
  if (typeof value !== typeof current) return undefined;
  if (!spec) return value;
  switch (spec.type) {
    case 'number': {
      const n = value as number;
      if (!Number.isFinite(n)) return undefined;
      const clamped = Math.min(spec.max, Math.max(spec.min, n));
      const snapped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
      return Number(Math.min(spec.max, snapped).toFixed(decimals(spec.step)));
    }
    case 'select':
      return spec.options.some((o) => o.value === value) ? value : undefined;
    case 'color':
      return /^#[0-9a-f]{6}$/i.test(value as string) ? (value as string).toLowerCase() : undefined;
    case 'text':
      return (value as string).slice(0, 200);
    case 'boolean':
      return value;
  }
}

type Listener = (key: string) => void; // 새 값은 store.get(key)로 읽는다

export class ParamStore {
  private readonly values: ParamValues;
  private readonly specs = new Map<string, ParamSpec>();
  private readonly listeners = new Set<Listener>();

  // 키는 DEFAULT_PARAMS와 받은 스키마(코어 + 이펙트)의 키다. 기본값은 스키마의 default.
  constructor(specs: readonly ParamSpec[], initial: Partial<ParamValues> = {}) {
    this.values = { ...DEFAULT_PARAMS };
    for (const spec of specs) {
      this.specs.set(spec.key, spec);
      this.values[spec.key] = spec.default;
    }
    for (const [key, value] of Object.entries(initial)) if (value !== undefined) this.set(key, value);
  }

  get<K extends ParamKey>(key: K): Params[K];
  get(key: string): ParamValue | undefined;
  get(key: string): ParamValue | undefined {
    return Object.hasOwn(this.values, key) ? this.values[key] : undefined;
  }

  snapshot(): ParamValues {
    return { ...this.values };
  }

  /** 받아들였으면(값이 같아도) true. 모르는 키이거나 맞지 않는 값이면 false이고 아무것도 바꾸지 않는다. */
  set(key: string, value: unknown): boolean {
    if (!Object.hasOwn(this.values, key)) return false;
    const next = normalizeParam(this.specs.get(key), value, this.values[key]);
    if (next === undefined) return false;
    if (this.values[key] === next) return true;
    this.values[key] = next as ParamValue;
    for (const listener of this.listeners) listener(key);
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
