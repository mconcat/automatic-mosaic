// E2E 테스트용 훅 (window.__am). 상태 스냅숏과 파라미터 getter/setter만 둔다. README 참고.
import type { FailReason } from './core/fail-closed';
import type { DetectorState, InferenceRecord, RenderRecord } from './core/pipeline';
import type { ParamValues } from './core/params';
import type { Delegate, DisplayMode, ExecutionLocation, ParamValue, Point, Rect } from './core/types';
import type { LongTask } from './ui/long-tasks';

export type AppState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export type AmParams = ParamValues; // 코어 파라미터 + 등록된 이펙트의 파라미터

export interface AmDetection {
  label: string;
  score: number;
  box: Rect; // 원본 프레임 px (미러링 전). 프레임 밖으로 나갈 수 있다
  keypoints: Point[];
}

export interface AmTrack {
  id: number; // 트랙 id (같은 얼굴이면 프레임이 바뀌어도 같다. 시작·정지·카메라 전환 때 1부터 다시)
  label: string;
  box: Rect; // 트랙 박스 (스무딩 적용, 패딩 전). 마지막 검출 박스를 항상 덮는다
  rawBox: Rect; // 마지막으로 매칭된 검출 박스
  held: boolean; // 그 검출 프레임에서는 검출되지 않고 유지 중
  lastSeenMs: number; // 마지막으로 검출된 프레임 시각 (performance.now 기준)
}

export interface AmSnapshot {
  state: AppState;
  error: string | null; // 화면에 보이는 카메라 오류 문구 (영어)
  errorCode: string | null; // CameraErrorCode
  frameCount: number; // 새로 그린 프레임 수 (시작마다 0부터). 동기: 분석한 프레임, 비동기: 카메라 프레임
  renderFps: number; // 화면 갱신 FPS (동기 표시면 추론 FPS와 같다)
  videoWidth: number;
  videoHeight: number;
  mirror: boolean;
  deviceId: string | null;
  // 마지막으로 연 스트림의 트랙들 (정지 후에도 남겨 두어 readyState를 확인할 수 있다)
  tracks: { kind: string; label: string; readyState: MediaStreamTrackState }[];
  devices: { deviceId: string; label: string }[]; // 카메라 선택지 (권한을 얻은 뒤 채워진다)

  detectorState: DetectorState;
  detectorError: string | null;
  detectorId: string | null; // 지금 불러와 있는 Detector 레지스트리 id
  location: ExecutionLocation | null; // 지금 검출기가 도는 곳 (불러오기 전·오류면 null)
  activeDelegate: Delegate | null; // 실제로 쓰는 실행 장치
  delegateFallback: string | null; // GPU를 요청했지만 CPU로 대체했을 때 그 이유
  displayMode: DisplayMode;
  detections: AmDetection[]; // 화면에 그린 결과의 검출 (그 검출 프레임의 검출기 출력)
  tracked: AmTrack[]; // 화면에 그린 결과의 트랙 (검출 없이 유지 중인 트랙 포함). 모자이크는 이 박스에 그린다
  regions: Rect[]; // 화면에 그려진 모자이크 영역 (원본 px, 패딩·클램프 후). 전체를 가렸으면 프레임 전체
  drawnFrameId: number | null; // 화면에 그려진 프레임 id (렌더러가 기록)
  detectionFrameId: number | null; // 화면에 그린 박스를 낸 검출 프레임 id (전체를 가렸으면 null)
  failReason: FailReason | null; // 실행 중 검출 결과를 믿을 수 없는 이유
  failClosed: boolean; // 실행 중이고 failReason이 있다 (원본 대신 가린 화면·마지막 분석 프레임을 보여 준다)
  fullCover: boolean; // 화면에 그린 프레임이 전체를 가린 것인지 (비동기 fail-closed)
  inferenceFps: number;
  inferenceMs: number; // detect() 시간 (지수 이동 평균, Worker면 왕복)
  droppedFrames: number; // 추론 중이라 버린 프레임 수 (시작마다 0부터)
  workers: { created: number; live: number }; // 검출 Worker를 만든 수, 살아 있는 수
  longTasks: { count: number; maxMs: number; recent: LongTask[] }; // 메인 스레드 롱태스크 (페이지를 연 뒤)
  viewRect: Rect; // 캔버스 버퍼 안에서 프레임이 그려진 영역 (기기 픽셀)
  blockedRequests: string[]; // 앱이 막은 localhost 밖 요청 (MediaPipe 사용 지표, Worker 포함)
}

export type AmFault = 'none' | 'delay' | 'error' | 'crash';

export interface AmHook {
  snapshot(): AmSnapshot;
  get(key: string): ParamValue | undefined;
  /** 모르는 키나 맞지 않는 값이면 false를 돌려주고 아무것도 바꾸지 않는다. 숫자는 범위·step에 맞춰진다. */
  set(key: string, value: ParamValue): boolean;
  params(): AmParams;
  start(): Promise<void>;
  stop(): void;
  /** 그린 프레임마다 남는 기록 (seq가 sinceSeq보다 큰 것, 최근 600개까지) */
  renders(sinceSeq?: number): RenderRecord[];
  /** 검출마다 남는 기록 { seq, frameId, ms, count } (seq가 sinceSeq보다 큰 것, 최근 600개까지. 측정용) */
  inferences(sinceSeq?: number): InferenceRecord[];
  /**
   * 시험용 고장. delay: 검출마다 ms(기본 3000) 늦춘다. error: 검출이 실패한다. crash: 검출 Worker 안에서 잡히지 않는 오류
   * (Worker가 없으면 false). none: 고장을 없애고, 검출기가 오류 상태면 다시 불러온다.
   */
  fault(kind: AmFault, ms?: number): boolean;
}

declare global {
  interface Window {
    __am: AmHook;
  }
}
