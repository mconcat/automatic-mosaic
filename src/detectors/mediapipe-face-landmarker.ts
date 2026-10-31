import type { FaceLandmarker, FaceLandmarkerOptions, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Delegate, Detection, DetectorOptions, ParamSpec } from '../core/types';
import { MediaPipeTaskDetector, MODEL_BASE, type Vision, type WasmFileset } from './mediapipe-task';

// 두 번째 검출기: MediaPipe FaceLandmarker (얼굴 메시 478점). 박스는 랜드마크를 감싸는 사각형이고 라벨은 'face'다.
// 파이프라인·트래커·이펙트는 이 검출기를 FaceDetector와 똑같이 쓴다 (교체 가능성 검증, PLAN M6).

const MODEL_URL = `${MODEL_BASE}face_landmarker/face_landmarker/float16/1/face_landmarker.task`;

// FaceDetector 키포인트와 비슷한 자리: 두 눈동자 중심, 코끝, 윗입술 안쪽, 양쪽 볼 끝 (디버그 오버레이용)
const KEYPOINTS = [468, 473, 1, 13, 234, 454];

/** 이 검출기만 쓰는 파라미터 (레지스트리 항목의 params). 값은 DetectorOptions.extra로 온다. */
export const LANDMARKER_PARAMS: ParamSpec[] = [
  // setOptions가 그래프를 다시 만들므로 슬라이더를 놓을 때만 반영한다
  { key: 'numFaces', label: 'Max faces', type: 'number', min: 1, max: 8, step: 1, default: 4, applyOnRelease: true },
];

function numFaces(o: DetectorOptions): number {
  const n = o.extra?.numFaces;
  return typeof n === 'number' && n >= 1 ? Math.round(n) : 4;
}

// 신뢰도는 얼굴 검출과 얼굴 존재(랜드마크 모델) 두 단계에 같이 건다. NMS 임계는 쓰지 않는다.
function taskOptions(o: DetectorOptions): FaceLandmarkerOptions {
  return { numFaces: numFaces(o), minFaceDetectionConfidence: o.minConfidence, minFacePresenceConfidence: o.minConfidence };
}

// 정규화 랜드마크 한 얼굴 → 공통 Detection (입력 픽셀). FaceLandmarker는 얼굴마다 점수를 내지 않아 1로 둔다.
export function landmarksToDetection(points: readonly NormalizedLandmark[], width: number, height: number): Detection | null {
  if (points.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return {
    label: 'face',
    score: 1,
    box: { x: x0 * width, y: y0 * height, width: (x1 - x0) * width, height: (y1 - y0) * height },
    keypoints: KEYPOINTS.filter((i) => i < points.length).map((i) => ({ x: points[i]!.x * width, y: points[i]!.y * height })),
  };
}

export class MediaPipeFaceLandmarker extends MediaPipeTaskDetector<FaceLandmarker> {
  readonly labels = ['face'];

  protected override createTask(lib: Vision, fileset: WasmFileset, delegate: Delegate): Promise<FaceLandmarker> {
    return lib.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      ...taskOptions(this.opts),
    });
  }

  protected override changeOptions(task: FaceLandmarker, next: DetectorOptions, prev: DetectorOptions): Promise<void> | null {
    if (next.minConfidence === prev.minConfidence && numFaces(next) === numFaces(prev)) return null;
    return task.setOptions(taskOptions(next));
  }

  protected override runTask(task: FaceLandmarker, frame: ImageBitmap, timestampMs: number): Detection[] {
    const out: Detection[] = [];
    for (const face of task.detectForVideo(frame, timestampMs).faceLandmarks) {
      const d = landmarksToDetection(face, frame.width, frame.height);
      if (d) out.push(d);
    }
    return out;
  }
}
