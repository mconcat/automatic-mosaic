import type { DownloadProgress } from '../../core/local-only';
import type { Delegate, Detection, DetectorOptions } from '../../core/types';
import type { FaceModel } from '../mediapipe-face';

// 메인 ↔ 검출 Worker 메시지 (DetectorProxy ↔ detector.worker.ts).

/** Worker 안에서 만들 수 있는 검출기 종류와 생성 인자 */
export type HostedSpec = { kind: 'mediapipe-face'; model: FaceModel } | { kind: 'mediapipe-face-landmarker' };

export type WorkerRequest =
  | { type: 'init'; id: number; detectorId: string; spec: HostedSpec; opts: DetectorOptions }
  | { type: 'update'; id: number; patch: Partial<DetectorOptions> }
  | { type: 'detect'; id: number; frame: ImageBitmap; timestampMs: number } // frame은 transfer
  | { type: 'crash' }; // 시험용: Worker 안에서 잡히지 않는 오류를 낸다

export type WorkerReply =
  | {
      type: 'result';
      id: number;
      ok: boolean;
      detections?: Detection[];
      error?: string;
      // 응답마다 실행 장치 상태를 함께 보낸다 (추론 중 GPU → CPU 대체가 일어날 수 있다)
      activeDelegate: Delegate | null;
      fallbackReason: string | null;
    }
  | { type: 'blocked'; url: string } // Worker 안에서 막은 텔레메트리 요청
  | { type: 'download'; progress: DownloadProgress }; // Worker 안의 모델·WASM 다운로드 진행률 (진행 표시줄)
