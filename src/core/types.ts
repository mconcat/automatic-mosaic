// 파이프라인 단계 사이의 공통 타입. 각 단계는 이 인터페이스로만 연결한다 (PLAN §2.2).

export interface Point {
  x: number;
  y: number;
}

export interface Point3 extends Point {
  z: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

// 소스가 내보내는 한 프레임. bitmap은 받은 쪽이 다 쓰고 close() 한다.
export interface Frame {
  id: number; // 소스 안에서 단조 증가
  timestampMs: number; // performance.now() 기준, 단조 증가
  streamId: string; // 프레임을 낸 스트림. 카메라를 바꾸면 바뀐다 (다른 스트림의 검출 결과는 믿지 않는다)
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface FrameSource {
  readonly kind: string; // 'camera'
  start(): Promise<void>;
  stop(): void;
  // 소비자는 하나(파이프라인). 받은 bitmap의 소유권도 넘어간다.
  onFrame(listener: (frame: Frame) => void): () => void;
}

// 엔진과 무관한 공통 검출 결과
export interface Detection {
  label: string; // 'face' | ...
  score: number;
  box: Rect; // 원본 프레임 픽셀 좌표 (미러링 전). 프레임 밖으로 나갈 수 있다 (자르는 것은 패딩 뒤)
  keypoints?: Point[];
  landmarks?: Point3[];
  attributes?: Record<string, unknown>;
}

export type Delegate = 'GPU' | 'CPU';

/** 검출기를 돌릴 곳. 파이프라인은 어느 쪽인지 모른다 (레지스트리 팩토리가 고른다). */
export type ExecutionLocation = 'worker' | 'main';

/** 동기: 분석이 끝난 프레임만 그린다. 비동기: 카메라 프레임마다 최신 검출 결과로 그린다 (PLAN §2.3). */
export type DisplayMode = 'sync' | 'async';

export interface DetectorOptions {
  delegate: Delegate;
  minConfidence: number;
  nmsThreshold: number;
  /** 그 검출기만 쓰는 파라미터 값 (레지스트리 항목의 params 키 → 값). 예: FaceLandmarker의 numFaces */
  extra?: Record<string, ParamValue>;
}

export interface Detector {
  readonly id: string; // 'mediapipe-face-short'
  readonly labels: string[];
  /** 실제로 쓰는 실행 장치 (GPU를 요청해도 실패하면 CPU). 초기화 전에는 null. */
  readonly activeDelegate: Delegate | null;
  /** GPU를 요청했지만 CPU로 대체했을 때 그 이유. 아니면 null. */
  readonly fallbackReason: string | null;
  /** 요청 밖에서 난 복구할 수 없는 오류 (예: Worker가 죽음). 호출부가 넣는다. */
  onError?: ((err: Error) => void) | null;
  init(opts: DetectorOptions): Promise<void>;
  updateOptions(opts: Partial<DetectorOptions>): Promise<void>;
  /**
   * frame의 소유권을 넘긴다 (검출기가 닫거나 Worker로 transfer 한다).
   * 결과 좌표는 넘겨받은 frame의 픽셀 좌표다 (원본 프레임으로 되돌리는 것은 호출부).
   */
  detect(frame: ImageBitmap, timestampMs: number): Promise<Detection[]>;
  /** 진행 중인 요청도 끊는다 (기다리던 detect 등은 거부된다). */
  dispose(): void;
}

export interface Track {
  id: number; // 같은 대상이면 프레임이 바뀌어도 같은 값
  label: string;
  box: Rect; // 스무딩 적용 후. 마지막 검출 박스(source.box)를 항상 덮는다 (패딩은 렌더 단계에서)
  lastSeenMs: number; // 마지막으로 검출된 프레임 시각. 이 프레임보다 이르면 검출 없이 유지 중인 트랙이다
  source: Detection; // 마지막으로 매칭된 검출
}

/** 모자이크 영역 모양 (Region.kind 중 패널에서 고를 수 있는 것) */
export type RegionShape = 'rect' | 'ellipse';

// 사각형 외 모양도 받는 구조 (타원, 메시 윤곽, 세그멘테이션 마스크). 원본 프레임 px, 프레임 안으로 잘린 영역이다.
// unclipped: 프레임으로 자르기 전 영역. 가장자리에 걸린 얼굴도 얼굴 크기 기준(상대 블록 크기 등)으로 다루게 한다.
// ellipse는 unclipped(없으면 rect)에 내접하는 타원을 rect 안에서만 그린다.
export type Region = (
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ellipse'; rect: Rect }
  | { kind: 'polygon'; points: Point[] }
  | { kind: 'mask'; mask: ImageBitmap; rect: Rect }
) & { unclipped?: Rect };

export type ParamValue = string | number | boolean;

// UI 자동 생성과 값 검사에 쓰는 파라미터 스키마. 이펙트는 자기 파라미터의 스키마(기본값 포함)를 params로 들고 온다.
interface ParamSpecBase {
  key: string;
  label: string;
  /** 다른 파라미터가 이 값일 때만 패널에 보인다 */
  visibleIf?: { key: string; equals: ParamValue };
  /** 패널 슬라이더를 놓을 때만 반영한다 (바꾸는 비용이 큰 값) */
  applyOnRelease?: boolean;
}

export type ParamSpec = ParamSpecBase &
  (
    | { type: 'number'; min: number; max: number; step: number; default: number }
    | { type: 'boolean'; default: boolean }
    | { type: 'select'; options: { label: string; value: string | number }[]; default: string | number }
    | { type: 'color'; default: string }
    | { type: 'text'; default: string }
  );

export interface Effect<P = Record<string, unknown>> {
  readonly id: string; // 'pixelate' | 'solid' | ...
  readonly label: string; // UI 표시 이름
  readonly params: ParamSpec[];
  /** ctx에는 프레임 좌표 → 캔버스 좌표 변환이 걸려 있다. region과 frame은 원본 프레임 픽셀 좌표. */
  apply(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, region: Region, params: P): void;
}

export interface DrawOptions {
  mirror: boolean;
  frameId: number; // 그리는 프레임의 id (renderer.frameId로 남는다)
}

// 프레임을 캔버스에 그린다 (지금은 Canvas2DRenderer). 미러링은 여기서만 한다.
export interface Renderer {
  /** 마지막으로 그린 프레임 id. 지운 뒤에는 null */
  readonly frameId: number | null;
  /** 캔버스 크기가 바뀌어 내용이 지워진 뒤 (마지막 프레임을 다시 그릴 기회) */
  onResize: (() => void) | null;
  /** paint는 프레임을 그린 직후, 프레임 좌표 → 캔버스 좌표 변환이 걸린 채로 불린다 (이펙트, 오버레이). */
  draw(image: CanvasImageSource, size: Size, opts: DrawOptions, paint?: (ctx: CanvasRenderingContext2D) => void): void;
  clear(): void;
}

// 어떤 트랙에 어떤 이펙트를 쓸지
export interface Rule {
  match: { label?: string; trackIds?: number[] };
  effectId: string;
  params: Record<string, unknown>;
}

// Tracker 뒤, Rules 앞에 들어갈 트리거 훅 (예: 손 모양 유지 → 모자이크 토글). 지금은 자리만 둔다.
export interface TriggerEvent {
  type: string;
  atMs: number;
  data?: unknown;
}

export type Trigger = (tracks: readonly Track[], nowMs: number) => TriggerEvent[];
