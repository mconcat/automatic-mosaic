import { installLocalOnlyFetch } from '../../core/local-only';
import type { Detection, Detector } from '../../core/types';
import { MediaPipeFaceDetector } from '../mediapipe-face';
import { MediaPipeFaceLandmarker } from '../mediapipe-face-landmarker';
import type { HostedSpec, WorkerReply, WorkerRequest } from './protocol';

// 검출 Worker (module). DetectorProxy가 보낸 요청을 받은 순서대로 처리한다.
// MediaPipe는 여기서 ES 모듈 WASM으로 불러오고, GPU delegate는 OffscreenCanvas(WebGL2)를 쓴다.

interface Scope {
  postMessage(message: WorkerReply): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WorkerRequest>) => void): void;
}
const scope = self as unknown as Scope;

// MediaPipe 사용 지표 전송도 Worker 안에서 막는다. 막은 요청은 메인으로 알린다.
installLocalOnlyFetch(
  globalThis,
  (url) => scope.postMessage({ type: 'blocked', url }),
  (progress) => scope.postMessage({ type: 'download', progress }),
);

// Worker에서 돌 수 있는 검출기 (main.ts의 레지스트리 항목이 HostedSpec으로 고른다)
function createHosted(id: string, spec: HostedSpec): Detector {
  switch (spec.kind) {
    case 'mediapipe-face':
      return new MediaPipeFaceDetector(id, spec.model);
    case 'mediapipe-face-landmarker':
      return new MediaPipeFaceLandmarker(id);
  }
}

let detector: Detector | null = null;
let queue: Promise<void> = Promise.resolve();

function need(): Detector {
  if (!detector) throw new Error('The worker detector is not ready.');
  return detector;
}

async function handle(msg: Exclude<WorkerRequest, { type: 'crash' }>): Promise<void> {
  let detections: Detection[] | undefined;
  let error: string | undefined;
  try {
    switch (msg.type) {
      case 'init':
        detector?.dispose();
        detector = createHosted(msg.detectorId, msg.spec);
        try {
          await detector.init(msg.opts);
        } catch (err) {
          detector.dispose();
          detector = null;
          throw err;
        }
        break;
      case 'update':
        await need().updateOptions(msg.patch);
        break;
      case 'detect':
        if (!detector) msg.frame.close();
        detections = await need().detect(msg.frame, msg.timestampMs); // frame은 검출기가 닫는다
        break;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  scope.postMessage({
    type: 'result',
    id: msg.id,
    ok: error === undefined,
    detections,
    error,
    activeDelegate: detector?.activeDelegate ?? null,
    fallbackReason: detector?.fallbackReason ?? null,
  });
}

scope.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg.type === 'crash') {
    setTimeout(() => {
      throw new Error('Simulated worker error');
    });
    return;
  }
  queue = queue.then(() => handle(msg));
});
