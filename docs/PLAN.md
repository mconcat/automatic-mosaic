# 오토매틱 모자이크 PoC 구현 플랜

작성: 2026-10-31 · 상태: 플랜 확정, 구현 시작

## 확정된 결정 (2026-10-31)

- **대상 브라우저: Chrome만.** Safari·Firefox 대응 코드는 넣지 않는다.
- **입력: 웹캠만.** `FrameSource` 인터페이스는 유지하되 구현은 카메라 하나다.
- **언어: TypeScript.**
- **"수어"의 범위**: 실제 수어 인식이 아니다. 간단한 손 모양·손동작을 인식해 **트리거**(예: 모자이크 켜고 끄기)를 거는 수준이다. 시퀀스 분류 모델·수어 데이터셋은 범위 밖(오버엔지니어링)이다. 지금은 트리거가 들어갈 자리만 구조에 둔다.
- 표시 모드 2종(동기 기본/비동기)과 모자이크 누출 대비(패딩·hold·스무딩)는 그대로 간다.

## 0. 요약

| 항목 | 선택 | 이유 |
|---|---|---|
| 추론 엔진 | **MediaPipe Tasks Vision 1.2.0** (`@mediapipe/tasks-vision`) | 얼굴·손·제스처·객체·홀리스틱이 한 패키지, 같은 API 형태. 확장 로드맵을 그대로 덮음 |
| 얼굴 모델 | BlazeFace short-range (230KB) | 가볍고 빠름. full-range(1.08MB)는 비교 실험 대상 |
| 실행 위치 | Web Worker + GPU delegate (CPU 자동 폴백) | `detectForVideo()`가 동기 호출이라 메인 스레드를 막음 (공식 문서 경고) |
| 빌드 | Vite 8 + TypeScript, 프레임워크 없음 | 교체 가능한 구조를 인터페이스로 강제하기 좋음. PoC에 React는 과함 |
| 파라미터 UI | Tweakpane 4 | 슬라이더·셀렉트·FPS 그래프 모니터 내장 |
| 렌더링 | Canvas 2D (축소→확대 픽셀화) | 10 FPS 미만 목표에 충분. 무거운 이펙트는 나중에 WebGL 렌더러로 교체 |
| 로컬 전용 | 모델·WASM을 `public/`에 동봉 | 런타임 외부 요청 0. `localhost`는 보안 컨텍스트라 카메라 사용 가능 |

---

## 1. 자료 조사 결과

### 1.1 얼굴 검출 엔진 후보

| 후보 | 최신 버전 (2026-10 기준) | 평가 | 판단 |
|---|---|---|---|
| MediaPipe Tasks Vision | 1.2.0 (2026-10-27), 활발히 릴리스 중 | 전처리·후처리(앵커, NMS) 내장. Face/Hand/Gesture/Object/Holistic/Segmenter 제공. GPU/CPU delegate | **1차 채택** |
| ONNX Runtime Web | 1.31.1 | 아무 ONNX 모델(SCRFD, YOLO-face 등)이나 실행. WebGPU/WASM EP. 전·후처리를 직접 구현해야 함 | **2차 어댑터 후보** (교체 가능성 검증용, 번호판 등 커스텀 모델) |
| Transformers.js | 4.3.2 | 범용 객체 검출 파이프라인. 얼굴 특화 모델은 적고 무거움 | 범용 객체 확장 시 검토 |
| @vladmandic/human | 3.3.6 (2025-08 이후 릴리스 없음) | 올인원이지만 TF.js 기반, 유지보수 둔화 | 제외 |
| TensorFlow.js | 4.22.0 (2025-01 이후 릴리스 없음) | 정체 | 제외 |
| Shape Detection API (`FaceDetector`) | Chrome 실험 플래그 | 모델 불필요하지만 표준화·지원 불확실 | 제외 |

### 1.2 MediaPipe 1.2.0에서 직접 확인한 사항

패키지 타입 선언(`vision.d.ts`)과 README를 직접 열어 확인함.

- 0.10.x 시절과 API 형태가 같다: `FilesetResolver.forVisionTasks(basePath, useModule?)` → `FaceDetector.createFromOptions(fileset, options)`.
- `useModule` 인자와 `vision_wasm_module_internal.*` 파일이 있어 **ES 모듈 Worker**에서 로드할 수 있다.
- 옵션: `runningMode: "IMAGE" | "VIDEO"`, `minDetectionConfidence`(기본 0.5), `minSuppressionThreshold`(기본 0.3), `baseOptions.delegate: "CPU" | "GPU"`.
- 결과: `detectForVideo(frame, timestampMs)` → `detections[]`. 각 항목은 `boundingBox {originX, originY, width, height}`(픽셀), `categories[].score`, 키포인트 6개(정규화 좌표: 두 눈, 코끝, 입, 양쪽 귀 옆).
- 입력 타입 `ImageSource = TexImageSource`라서 Worker 안에서 `ImageBitmap`, `VideoFrame`, `OffscreenCanvas`를 바로 넘길 수 있다.
- 용량: WASM 한 벌이 약 14.5MB(SIMD/non-SIMD/module 3종 중 필요한 것만 복사), JS 번들 156KB.

모델 파일 (Google Storage에서 HEAD 요청으로 존재·크기 확인):

| 모델 | 크기 | 용도 |
|---|---|---|
| `blaze_face_short_range.tflite` | 230KB | 얼굴 검출 (셀피 거리, 약 2m 이내) |
| `blaze_face_full_range.tflite` | 1.08MB | 먼 얼굴. **공식 문서에 없음, Tasks API에서 동작하는지 PoC에서 검증** |
| `face_landmarker.task` | 3.8MB | 얼굴 메시 478점 (윤곽 마스크, 추적 안정성 비교용) |
| `hand_landmarker.task` | 7.8MB | 손 21점 |
| `gesture_recognizer.task` | 8.4MB | 기본 제스처 8종 (None, Closed_Fist, Open_Palm, Pointing_Up, Thumb_Down, Thumb_Up, Victory, ILoveYou) |
| `efficientdet_lite0.tflite` (int8) | 4.6MB | COCO 80종 객체 |

### 1.3 모자이크 기법

- **픽셀화(기본)**: 영역을 `(w / 블록크기) × (h / 블록크기)`로 `drawImage` 축소한 뒤 `imageSmoothingEnabled = false`로 원래 크기로 확대한다. 모든 브라우저에서 동작하고 비용은 무시할 수준이다.
- **블러**: `ctx.filter = 'blur(...)'`는 Safari 지원 상황이 버전마다 엇갈린다. 블러는 확장 단계에서 WebGL 셰이더로 구현한다.
- **보안 메모**: 블록이 큰 픽셀화는 복원 공격에 상대적으로 약하다고 알려져 있다. 실제 개인정보 보호 용도라면 단색 채움이나 강한 블러+노이즈 이펙트를 선택지로 둔다 (지금은 이펙트 인터페이스만 열어 둠).

### 1.4 트래킹·안정화

검출기는 프레임마다 독립적으로 판단하므로 박스가 떨리고 가끔 사라진다. 가리는 용도에서는 **놓치는 쪽이 더 나쁜 실패**이므로 다음을 둔다.

- **패딩**: BlazeFace 박스는 이마와 턱을 빠듯하게 잡는다. 기본 1.3배로 확장한다.
- **유지(hold)**: 검출이 끊겨도 마지막 박스를 일정 시간(기본 400ms) 유지한다.
- **ID 매칭**: IoU 기반 그리디 매칭(SORT의 단순화 버전)으로 트랙 ID를 부여한다. 다중 얼굴과 대상별 규칙의 기반이 된다.
- **스무딩**: One Euro Filter로 박스 좌표를 보정한다. 느릴 때는 떨림을 잡고 빠를 때는 지연을 줄인다.

### 1.5 확장 관련 조사

- **손·제스처**: `HandLandmarker`, `GestureRecognizer`가 같은 패키지에 있다. 커스텀 제스처는 MediaPipe Model Maker로 학습해 `custom_gestures_classifier`로 쓸 수 있다.
- **손 모양·손동작 트리거**: `GestureRecognizer`의 기본 8종(주먹, 편 손, 브이, 엄지 위 등)이면 "특정 손 모양을 0.5초 유지하면 모자이크 토글" 같은 트리거에 충분하다. 실제 수어 인식(시퀀스 모델)은 범위 밖이다.
- **다른 객체**: `ObjectDetector`(COCO 80종)에는 번호판이 없다. 번호판 같은 대상은 커스텀 모델(Model Maker 또는 ONNX YOLO 계열)이 필요하므로 ONNX 어댑터 자리를 비워 둔다.

---

## 2. 아키텍처

### 2.1 파이프라인

```
 ┌──────────┐   ImageBitmap+ts   ┌───────────────────┐  Detection[]  ┌─────────┐  Track[]  ┌──────────┐
 │  Source  │ ─────────────────▶ │ Detector (Worker) │ ────────────▶ │ Tracker │ ────────▶ │  Rules   │
 │ 웹캠     │                    │ MediaPipe Face    │               │ IoU+1€  │           │ 라벨→효과 │
 │          │                    │ (교체 가능)        │               │ +hold   │           └────┬─────┘
 │          │                    └───────────────────┘               └─────────┘                │
 └────┬─────┘                                                                                    ▼
      │ 같은 프레임                                                                        ┌──────────┐
      └──────────────────────────────────────────────────────────────────────────────────▶│ Renderer │──▶ <canvas>
                                                                                           │ + Effect │
                                    ParamStore (Tweakpane) ── 모든 단계가 구독 ──────────────▶└──────────┘
```

- 각 단계는 인터페이스로만 연결한다. 엔진·모델·이펙트·렌더러를 바꿔도 다른 단계는 그대로다.
- `Trigger` 단계(Tracker 뒤, Rules 앞)를 **빈 훅으로 예약**한다. 나중에 "손 모양 X를 N ms 유지 → 액션(모자이크 토글 등)" 같은 트리거가 여기 들어간다. 트랙 목록을 받아 이벤트를 내는 단순한 형태면 충분하다.

### 2.2 핵심 타입 (초안)

```ts
// 엔진과 무관한 공통 검출 결과
interface Detection {
  label: string;               // 'face' | 'hand' | 'person' | ...
  score: number;
  box: Rect;                   // 원본 프레임 픽셀 좌표
  keypoints?: Point[];         // 얼굴 6점 등
  landmarks?: Point3[];        // 손 21점, 얼굴 메시 등
  attributes?: Record<string, unknown>; // gesture, handedness 등
}

interface Detector {
  readonly id: string;         // 'mediapipe-face-short'
  readonly labels: string[];
  init(opts: DetectorOptions): Promise<void>;
  updateOptions(opts: Partial<DetectorOptions>): Promise<void>;
  detect(frame: ImageBitmap, timestampMs: number): Promise<Detection[]>;
  dispose(): void;
}

interface Track {
  id: number;
  label: string;
  box: Rect;                   // 스무딩·패딩 적용 후
  lastSeenMs: number;
  source: Detection;
}

// 처음부터 사각형 외 모양을 받는 구조로 둠 (타원, 메시 윤곽, 세그멘테이션 마스크)
type Region =
  | { kind: 'rect'; rect: Rect }
  | { kind: 'ellipse'; rect: Rect }
  | { kind: 'polygon'; points: Point[] }
  | { kind: 'mask'; mask: ImageBitmap; rect: Rect };

interface Effect<P = Record<string, unknown>> {
  readonly id: string;         // 'pixelate' | 'solid' | 'blur' | ...
  readonly params: ParamSpec[];// UI 자동 생성용 스키마
  apply(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, region: Region, params: P): void;
}

interface Rule {               // 어떤 트랙에 어떤 이펙트를 쓸지
  match: { label?: string; trackIds?: number[] };
  effectId: string;
  params: Record<string, unknown>;
}
```

- `Detector`, `Effect`는 레지스트리에 id로 등록하고, UI 드롭다운이 레지스트리 목록을 보여 준다.
- Worker 경계는 `DetectorProxy`가 감춘다. 메인 스레드에서도 같은 `Detector` 인터페이스로 보이므로 Worker 사용 여부를 바꿔도 호출부는 바뀌지 않는다.

### 2.3 프레임 스케줄링

- **백프레셔**: 추론 중인 프레임은 항상 1개만 둔다. 바쁘면 새 프레임은 버린다. 목표 FPS 상한(기본 8)으로 캡처 간격을 정한다.
- **표시 모드 2종** (파라미터로 전환):
  - **동기 모드(기본)**: 검출이 끝난 바로 그 프레임만 그린다. 출력 FPS는 추론 FPS와 같고, 박스와 화면이 정확히 일치하므로 얼굴이 새지 않는다. 요구사항(10 FPS 미만)에 맞는다.
  - **비동기 모드**: 영상은 원래 FPS로 그리고 박스는 최신 결과를 쓴다. 부드럽지만 빠르게 움직이면 얼굴이 순간 노출될 수 있다. 비교 실험용이다.
- **좌표계**: 검출은 항상 미러링하지 않은 원본으로 하고, 미러링은 렌더 단계에서만 한다. 미러링한 영상을 넣으면 손의 좌우(handedness)가 뒤집힌다(공식 문서 주의사항).
- **추론 해상도**: 긴 변을 640px로 축소해 넣고, 결과 좌표를 원본 비율로 되돌린다.

---

## 3. 디렉터리 구조 (예정)

```
automatic-mosaic/
├─ index.html
├─ package.json  tsconfig.json  vite.config.ts
├─ scripts/
│  └─ fetch-assets.mjs        # 개발 시 1회: 모델 다운로드 + node_modules에서 WASM 복사
├─ public/
│  ├─ models/                 # .gitignore (fetch-assets로 재생성)
│  └─ wasm/                   # .gitignore
├─ src/
│  ├─ main.ts                 # 조립 지점: 레지스트리 등록, 파이프라인 생성
│  ├─ core/                   # types.ts, pipeline.ts, registry.ts, params.ts, geometry.ts
│  ├─ sources/                # camera.ts (FrameSource 구현은 웹캠 하나)
│  ├─ detectors/
│  │  ├─ mediapipe-face.ts
│  │  └─ worker/              # detector.worker.ts, proxy.ts (RPC)
│  ├─ tracking/               # iou-tracker.ts, one-euro.ts
│  ├─ effects/                # pixelate.ts, solid.ts
│  ├─ render/                 # canvas2d-renderer.ts, debug-overlay.ts
│  └─ ui/                     # panel.ts (Tweakpane), stats.ts
├─ tests/                     # Vitest(단위), Playwright(E2E, 가짜 카메라)
└─ docs/PLAN.md
```

---

## 4. 조절 파라미터 (PoC 패널)

| 그룹 | 파라미터 | 기본값 | 범위·선택지 |
|---|---|---|---|
| 입력 | 카메라 장치 | 기본 장치 | 연결된 웹캠 목록 |
| 입력 | 미러 표시 | 켬 | on/off |
| 검출 | 모델 | short-range | short-range / full-range |
| 검출 | delegate | GPU | GPU / CPU |
| 검출 | 최소 신뢰도 | 0.5 | 0.1–0.9 |
| 검출 | NMS 임계 | 0.3 | 0.1–0.9 |
| 검출 | 추론 해상도(긴 변) | 640 | 320 / 480 / 640 / 원본 |
| 검출 | 목표 FPS | 8 | 1–15 |
| 트래킹 | 유지 시간 | 400ms | 0–2000ms |
| 트래킹 | 스무딩 (1€ minCutoff / beta) | 1.0 / 0.01 | 범위 조정 가능 |
| 모자이크 | 블록 크기 방식 | 상대 | 절대(px) / 상대(얼굴 폭 대비 블록 수) |
| 모자이크 | 블록 크기 | 16px · 상대 10칸 | 4–64px · 4–32칸 |
| 모자이크 | 패딩 배율 | 1.3 | 1.0–2.0 |
| 모자이크 | 모양 | 사각형 | 사각형 / 타원 |
| 모자이크 | 강도(원본과 혼합) | 1.0 | 0–1 |
| 표시 | 표시 모드 | 동기 | 동기 / 비동기 |
| 표시 | 디버그 오버레이 | 끔 | 박스·점수·트랙 ID·키포인트 |
| 모니터 | 추론 FPS, 추론 시간(ms), 검출 수 | — | 그래프 표시 |

"상대" 블록 크기는 얼굴이 멀어지든 가까워지든 같은 정도로 가리기 위한 것이다. 고정 px이면 먼 얼굴은 블록 1–2개로 뭉개지고 가까운 얼굴은 덜 가려진다.

---

## 5. 마일스톤

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **M0** 스캐폴딩 | Vite+TS 생성, `git init`, `fetch-assets` 스크립트, 린트·Vitest 설정 | `npm run dev` 실행, 네트워크를 끊어도 정적 자산이 모두 로컬에서 로드됨 |
| **M1** 입력·출력 | 웹캠 소스(장치 선택, 권한 거부·장치 없음 처리), Canvas 렌더러, FPS 표시 | 웹캠 영상이 캔버스에 출력되고, 권한 거부 시 안내 문구가 나옴 |
| **M2** 얼굴 검출 | 메인 스레드에서 MediaPipe FaceDetector 어댑터, 디버그 박스 | 정면 얼굴에 박스와 점수가 표시됨 |
| **M3** 모자이크 + 패널 | 픽셀화 이펙트, Tweakpane 패널, ParamStore | 모든 파라미터가 재시작 없이 즉시 반영됨 |
| **M4** Worker 이전 | Detector를 Worker로, DetectorProxy, 백프레셔, 동기/비동기 모드 | 추론 중 메인 스레드 롱태스크(>50ms) 없음, GPU 실패 시 CPU 자동 폴백 |
| **M5** 안정화 | IoU 트래커, One Euro 스무딩, hold, 타원 모양 | 테스트 영상에서 박스 깜빡임(1프레임 소실)이 체감상 사라짐 |
| **M6** 교체성 검증·측정 | 두 번째 Detector 어댑터(FaceLandmarker 기반 박스)를 런타임에 전환, 성능 측정 기록 | 코드 수정 없이 UI에서 엔진 전환 가능, 측정표 작성 |

M2를 먼저 메인 스레드에서 돌리고 M4에서 Worker로 옮긴다. 처음부터 Worker로 시작하면 모델 로딩 문제와 Worker 문제가 섞여 디버깅이 어렵다.

---

## 6. 검증 계획

- **기능**: 1–3명 정면 얼굴, 측면·기울어진 얼굴, 2m 이상 먼 얼굴, 역광. short-range와 full-range를 비교한다.
- **성능**: 대상 기기(이 Mac, Chrome)에서 추론 시간, 추론 FPS, 메인 스레드 점유를 측정한다. 목표는 추론 8 FPS 이상 안정 유지다.
- **오프라인**: DevTools에서 오프라인으로 전환한 뒤 새로고침해 동작을 확인한다 (dev 서버는 로컬). 런타임 외부 요청 0건.
- **단위 테스트(Vitest)**: geometry(좌표 변환·패딩·클램프), IoU 트래커, One Euro Filter. 모두 순수 함수로 분리한다.
- **E2E(Playwright)**: Chrome `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<y4m>`로 고정 테스트 영상을 카메라처럼 넣어, 사람이 없어도 회귀를 확인한다.
- **테스트 영상**: MediaPipe 공식 테스트 이미지 `https://storage.googleapis.com/mediapipe-assets/portrait.jpg`(820×1024, 미국 정부 공식 초상 사진이라 퍼블릭 도메인)를 받아 ffmpeg로 y4m 영상을 만든다. 정지 1인, 좌우로 움직이는 1인, 나란히 놓은 2인처럼 시나리오별로 만든다. 생성 스크립트만 커밋하고 영상과 이미지는 `.gitignore`에 넣는다.
- **실제 웹캠 확인**: 자동화할 수 없으므로 마지막에 사용자가 직접 확인한다.

---

## 7. 확장 로드맵 (지금은 구조만)

| 확장 | 들어갈 자리 | 비고 |
|---|---|---|
| 다중 얼굴 | 이미 지원 (`Detection[]` + 트랙 ID) | 특정 인물만 제외하려면 얼굴 임베딩이 필요하다 (생체정보 처리이므로 별도 검토) |
| 다른 객체 | `ObjectDetector` 어댑터, ONNX 어댑터 | Rule의 `label` 매칭으로 대상별 이펙트 지정 |
| 손 트래킹 | `HandLandmarker` 어댑터 → `landmarks` | 손 영역 모자이크도 같은 경로 |
| 제스처 | `GestureRecognizer` 어댑터 → `attributes.gesture` | 예: 제스처로 모자이크 켜고 끄기 |
| 손 모양 트리거 | `GestureRecognizer` 어댑터 + `Trigger` 단계 | 손 모양을 일정 시간 유지하면 액션. 실제 수어 인식은 범위 밖 |
| 다른 이펙트 | `Effect` 구현 추가 (단색, 블러, 스티커, 색 반전) | 무거운 것은 WebGL 렌더러에서 |
| 정밀 마스크 | `Region`의 polygon/mask | FaceLandmarker 윤곽, ImageSegmenter |
| 결과 녹화 | `canvas.captureStream()` + `MediaRecorder` | 렌더러 뒤에 붙이기만 하면 됨 |

---

## 8. 리스크와 열린 질문

**리스크**

- **먼 얼굴·측면 얼굴 미검출**: short-range 모델의 특성이다. full-range 모델과 FaceLandmarker를 비교하고, 패딩과 hold로 보완한다.
- **Worker 안 GPU delegate**: OffscreenCanvas + WebGL2가 필요하다. 헤드리스 Chrome처럼 GPU가 없는 환경을 위해 CPU 자동 폴백을 둔다.
- **모자이크 누출**: 검출이 실패한 프레임은 그대로 노출된다. 동기 모드, hold, 패딩으로 줄이고, 필요하면 "검출 신뢰가 낮으면 화면 전체를 가리는" fail-closed 옵션을 둔다.
- **패키지 변동**: MediaPipe가 1.x에서 거의 매일 RC를 낸다. 버전을 정확히 고정한다 (`1.2.0`).

**확인할 것 (사용자)**: 모두 해결됨. 문서 맨 위 "확정된 결정"을 본다.

---

## 참고 자료

- MediaPipe Face Detector Web 가이드: https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js
- MediaPipe Gesture Recognizer Web 가이드: https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js
- MediaPipe Hand Landmarker Web 가이드: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- `@mediapipe/tasks-vision` npm: https://npmjs.com/package/@mediapipe/tasks-vision
- ONNX Runtime Web 실전 가이드 (Worker, 프레임 스킵): https://dev.to/pranjulrathour/running-ml-models-in-the-browser-with-onnx-runtime-web-a-practical-guide-2gpp
- Kaggle Isolated Sign Language Recognition 정리: https://github.com/JosephZahar/Google-Isolated-Sign-Language-Recognition-Kaggle
- WebKit canvas filter 버그: https://bugs.webkit.org/show_bug.cgi?id=198416
