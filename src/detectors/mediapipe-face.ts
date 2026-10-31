import type { Detection as MpDetection, FaceDetector } from '@mediapipe/tasks-vision';
import type { Delegate, Detection, DetectorOptions } from '../core/types';
import { MediaPipeTaskDetector, MODEL_BASE, type Vision, type WasmFileset } from './mediapipe-task';

// MediaPipe FaceDetector (BlazeFace) 어댑터. 공용 부분(WASM 로드, GPU→CPU 대체, dispose)은 MediaPipeTaskDetector에 있다.

export type FaceModel = 'short' | 'full';

const MODEL_URL: Record<FaceModel, string> = {
  short: `${MODEL_BASE}face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
  full: `${MODEL_BASE}face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite`,
};

// MediaPipe 결과 → 공통 Detection. 박스는 입력 픽셀, 키포인트는 정규화 좌표라 입력 크기를 곱한다.
export function toDetection(d: MpDetection, width: number, height: number): Detection {
  const b = d.boundingBox;
  return {
    label: 'face',
    score: d.categories[0]?.score ?? 0,
    box: b ? { x: b.originX, y: b.originY, width: b.width, height: b.height } : { x: 0, y: 0, width: 0, height: 0 },
    keypoints: d.keypoints.map((k) => ({ x: k.x * width, y: k.y * height })),
  };
}

export class MediaPipeFaceDetector extends MediaPipeTaskDetector<FaceDetector> {
  readonly labels = ['face'];
  private readonly model: FaceModel;

  constructor(id: string, model: FaceModel) {
    super(id);
    this.model = model;
  }

  protected override createTask(lib: Vision, fileset: WasmFileset, delegate: Delegate): Promise<FaceDetector> {
    return lib.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL[this.model], delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: this.opts.minConfidence,
      minSuppressionThreshold: this.opts.nmsThreshold,
    });
  }

  // 신뢰도·NMS는 setOptions로 바로 바꾼다.
  protected override changeOptions(task: FaceDetector, next: DetectorOptions, prev: DetectorOptions): Promise<void> | null {
    if (next.minConfidence === prev.minConfidence && next.nmsThreshold === prev.nmsThreshold) return null;
    return task.setOptions({ minDetectionConfidence: next.minConfidence, minSuppressionThreshold: next.nmsThreshold });
  }

  protected override runTask(task: FaceDetector, frame: ImageBitmap, timestampMs: number): Detection[] {
    return task.detectForVideo(frame, timestampMs).detections.map((d) => toDetection(d, frame.width, frame.height));
  }
}
