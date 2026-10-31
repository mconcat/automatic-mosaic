# 오토매틱 모자이크 (PoC)

웹캠 영상에서 얼굴을 찾아 모자이크하는 브라우저 전용 PoC입니다. 검출과 모자이크는 모두 브라우저 안에서 합니다. 바깥으로 나가는 요청은 처음 실행할 때 모델과 WASM을 공식 저장소에서 받는 것뿐이고, 받은 파일은 브라우저 캐시에 남습니다. 서버 쪽 처리는 없어서 빌드 결과물(`dist/`)을 정적 호스팅(GitHub Pages 등)에 올려도 동작합니다. 설계는 [docs/PLAN.md](docs/PLAN.md), 진행 기록은 [docs/PROGRESS.md](docs/PROGRESS.md)에 있습니다.

> 현재 단계: P4 (트래킹·스무딩·박스 유지, 타원 모양, 두 번째 검출기 FaceLandmarker). P1~P3는 구현 → 3관점 리뷰 → 검증 → 수정 → QA를 모두 거쳤고, P4는 발표 일정 때문에 구현과 자동 테스트까지만 했습니다(리뷰·QA 사이클 생략, [PROGRESS](docs/PROGRESS.md) P4 참고).

## 데모 (실제 웹캠)

```sh
npm install
npm run dev        # Chrome에서 http://localhost:5317
```

1. **Start** → 카메라 권한을 허용하면 얼굴에 모자이크가 덮입니다. 모델을 받거나 불러오는 동안은 화면 위에 진행 표시줄이 나옵니다.
2. **간단 조작줄**(머리글 아래)에 자주 쓰는 것만 있습니다.
   - **Face mosaic | Text targets** 토글로 얼굴 모자이크와 텍스트 대상 지정을 오갑니다.
   - **Text targets**를 고르면 **Hide:** 입력창이 나옵니다. 영어 대상 이름을 쉼표로 넣고 Enter(또는 Apply)를 누르면 OWL-ViT가 그 대상들을 가립니다. 예: `human face`, `a tie, a flag`, `cell phone, laptop`, `wrist watch, suit jacket`. 잘 안 잡히면 `a tie`처럼 관사를 붙이거나 Advanced settings의 `Text threshold`를 0.05 정도로 낮춥니다.
   - **Mosaic blocks**(영역 폭을 나눌 칸 수, 작을수록 굵게), **Effect**(Pixelate/Solid), **Shape**(Rectangle/Ellipse), **Show boxes**(검출 박스·점수·트랙 ID)도 여기 있습니다.
3. 나머지 설정은 오른쪽 **Advanced settings** 패널에 접혀 있습니다. 카메라, 미러, 검출 모델·실행 위치·실행 장치, 신뢰도, 추론 해상도, 목표 FPS, 트래킹(유지 시간·스무딩), 패딩, 강도, 표시 모드(Sync/Async), 모니터가 여기 있고, 기능은 하나도 빠지지 않았습니다.
   - 실행 위치를 `Main thread`로 바꾸면 롱태스크 수가 늘어나는 것을 비교할 수 있습니다.
   - 검출 모델을 `FaceLandmarker`로 바꿔도 트래커·이펙트는 그대로 동작합니다(교체 가능한 구조 시연).
4. **표시 모드**: `Sync`(기본, 분석한 프레임만 표시해 누출 없음) ↔ `Async`(카메라 속도로 부드럽게, 빠르게 움직이면 박스가 늦음).

### 텍스트 대상 검출기 (OWL-ViT)

- **OWL-ViT**(`Xenova/owlvit-base-patch32`, 오픈 어휘 객체 검출, [Transformers.js](https://github.com/huggingface/transformers.js) 3.8.1): 텍스트로 준 대상의 박스를 매 프레임 찾습니다. M 시리즈 Mac Chrome WebGPU(fp16)에서 약 70ms, 8 FPS입니다. 처음 고를 때 모델(약 300MB)을 불러오느라 10초 정도 걸립니다.
- OWL-ViT가 알아듣는 것은 **짧은 영어 명사구**입니다. 한국어 명령문("~만 가려줘")은 이해하지 못합니다. 문구에 민감해서 `necktie`보다 `a tie`가 잘 잡히기도 합니다.
- 모델은 Hugging Face(`Xenova/owlvit-base-patch32`)에서, ONNX Runtime WASM은 jsDelivr(Transformers.js 기본값)에서 처음 고를 때 받습니다. WebGPU가 필요하고 메인 스레드에서만 돕니다(실행 위치를 Worker로 둬도 메인에서 돕니다).
- Transformers.js 4.x(onnxruntime-web 1.31 개발판)에서는 OWL-ViT 세션 생성이 `/class_head/Where` 노드 배정 오류로 실패해 3.8.1로 고정했습니다.

### 텔레메트리 차단

MediaPipe Tasks 1.2.0은 사용 지표를 `https://odml.pa.googleapis.com/v1/log`로 보냅니다(태스크마다 60초 간격, 검출기를 닫을 때). 앱은 메인 스레드와 검출 Worker에서 `fetch`를 감싸 이 요청만 보내기 전에 거부합니다(`src/core/local-only.ts`). 모델·WASM 다운로드는 막지 않습니다.

## 요구 사항

- 데스크톱 Chrome (다른 브라우저는 대상이 아닙니다)
- Node.js 22.12 이상 (개발 환경: Node 25, npm 11)
- E2E 테스트용 영상을 만들 때만: `ffmpeg`, `ffprobe` (PATH에 있거나 `FFMPEG`, `FFPROBE` 환경 변수로 지정)

## 설치와 실행

```sh
npm install
npm run dev        # http://localhost:5317
```

별도 설치 단계는 없습니다. 모델과 WASM은 실행 중에 공식 출처에서 받습니다(처음 한 번, 이후 브라우저 캐시).

| 파일 | 출처 |
|---|---|
| MediaPipe 모델 (`blaze_face_short_range.tflite`, `blaze_face_full_range.tflite`, `face_landmarker.task`) | `https://storage.googleapis.com/mediapipe-models/` (Google 공식) |
| MediaPipe WASM (`vision_wasm_internal.*`, Worker용 `vision_wasm_module_internal.*`) | `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm` (npm 패키지, `package.json`과 같은 버전) |
| OWL-ViT 모델 | `https://huggingface.co/Xenova/owlvit-base-patch32` |
| ONNX Runtime WASM (OWL-ViT용) | `https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/` |

카메라는 보안 컨텍스트에서만 열리므로 `localhost` 주소로 엽니다.


## 명령

| 명령 | 내용 |
|---|---|
| `npm run dev` | 개발 서버 (포트 5317 고정) |
| `npm run build` | 프로덕션 빌드 → `dist/` |
| `npm run preview` | 빌드 결과 서버 (포트 5318 고정) |
| `npm run typecheck` | `tsc -b` (strict). `tsconfig.app.json`(`src/`, 브라우저 타입만)과 `tsconfig.node.json`(테스트·설정 파일, Node 타입)을 따로 검사 |
| `npm test` | Vitest 단위 테스트 (`tests/unit`) |
| `npm run e2e` | Playwright E2E (`tests/e2e`). 빌드 후 5318에서 preview 서버를 띄워 헤드리스 Chrome으로 검사 |
| `npm run demo` | 빌드 후 `127.0.0.1:5320`에서 preview (다른 기기에서는 `tailscale serve --bg 5320` 등 HTTPS로 연다) |
| `npm run fixtures` | E2E용 가짜 카메라 영상 생성 → `tests/fixtures/` (`--force`로 재생성) |

### E2E와 가짜 카메라

`npm run e2e`는 시작할 때 `npm run fixtures`와 같은 스크립트를 실행해 영상이 없으면 만듭니다. 원본은 MediaPipe 테스트 이미지 `portrait.jpg`(퍼블릭 도메인 초상)이고, 640×480·15fps·4초 y4m 클립 4개를 만듭니다.

| 파일 | 내용 |
|---|---|
| `still-1face.y4m` | 얼굴 하나, 정지 |
| `moving-1face.y4m` | 회색 배경 위에서 얼굴이 좌우로 왕복 |
| `two-faces.y4m` | 같은 인물 두 명이 나란히 |
| `no-face.y4m` | 얼굴 없음 (커튼과 깃발) |

P2부터는 각 클립을 검출 테스트에도 씁니다: `still-1face`는 얼굴 1개, `two-faces`는 2개, `no-face`는 0개가 나와야 합니다(P3부터는 기본 실행 위치 Worker에서). `moving-1face`로는 그려진 프레임마다 모자이크 영역이 그 프레임의 얼굴 위에 있는지 픽셀로 확인합니다(`sync-moving.spec.ts`, 동기 표시 검사).

P3 E2E: `worker.spec.ts`(기본 Worker, 프레임 transfer, 롱태스크 Worker/메인 비교, 실행 위치·장치 3번 전환과 Worker 수, Worker 오류 전달), `display.spec.ts`(동기 drawn = detection, 비동기 렌더 FPS > 추론 FPS), `fail-closed.spec.ts`(지연·실패·Worker 오류·다시 불러오기 때 원본을 보이지 않음과 회복), `switching.spec.ts`(GPU 실패·WebGL 없음을 Worker와 메인 양쪽에서). `addInitScript`는 Worker에 걸리지 않으므로 Worker 안의 고장은 `patchWorkers()`(`helpers.ts`, Playwright `worker.evaluate`)로 심습니다.

Chrome은 `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<y4m>`로 이 영상을 카메라처럼 씁니다. 테스트 파일마다 맨 위에서 `useFakeCamera('<파일>')`(`tests/e2e/helpers.ts`)로 영상을 고릅니다. 권한 거부는 `useFakeCamera(파일, { deny: true })`로 흉내 내고, Chrome 플래그를 더할 때는 `{ args: [...] }`를 씁니다(예: `hidpi.spec.ts`의 `--force-device-scale-factor=2`). 파일 영상은 장치가 1대뿐이라, 카메라 전환 테스트(`devices.spec.ts`)만 Chrome 합성 가짜 카메라 2대(`--use-fake-device-for-media-stream=device-count=2`)를 씁니다. 브라우저는 항상 헤드리스로 띄우고 실제 웹캠은 쓰지 않습니다.

## 테스트 훅 `window.__am`

E2E 테스트가 앱 상태를 읽고 파라미터를 바꾸는 작은 훅입니다. 프로덕션 빌드에도 들어 있습니다. 타입은 `src/test-hook.ts`에 있습니다.

| 멤버 | 설명 |
|---|---|
| `snapshot()` | 현재 상태를 담은 객체를 돌려줍니다 (아래 표) |
| `get(key)` / `set(key, value)` | 파라미터 읽기·쓰기 (아래 파라미터 표). `set`은 패널도 함께 바꾸고, 모르는 키이거나 맞지 않는 값이면 `false`를 돌려주며 아무것도 바꾸지 않습니다(모르는 키의 `get`은 `undefined`). 숫자는 범위로 자르고 step에 맞춥니다 |
| `params()` | 모든 파라미터 값 |
| `start()` | 시작 버튼과 같습니다 (Promise) |
| `stop()` | 정지 버튼과 같습니다 |
| `renders(sinceSeq?)` | 그린 프레임마다 남는 기록 `{ seq, frameId, detectionFrameId, mode, fullCover }[]` (최근 600개, `seq`가 `sinceSeq`보다 큰 것). `frameId`는 그린 카메라 프레임, `detectionFrameId`는 박스를 낸 검출 프레임(전체를 가렸으면 `null`), `mode`는 `'sync'`/`'async'`, `fullCover`는 화면 전체를 가려 그렸는지(스냅숏의 `fullCover`와 같은 뜻. 동기 표시가 멈춰 화면을 갱신하지 않는 상태는 기록이 아니라 스냅숏의 `failClosed`로 봅니다). 파라미터 변경·창 크기 변경으로 다시 그린 것도 남습니다. 동기 표시에서는 모든 기록이 `frameId === detectionFrameId`입니다 |
| `fault(kind, ms?)` | **시험용 고장.** `'delay'`: 검출마다 `ms`(기본 3000) 늦춥니다. `'error'`: 검출이 실패합니다(검출기 오류 상태). `'crash'`: 검출 Worker 안에서 잡히지 않는 오류를 냅니다(Worker가 없으면 `false`). `'none'`: 고장을 없애고, 검출기가 오류 상태면 다시 불러옵니다. 메인 스레드·Worker 어느 쪽이든 같은 경로(파이프라인)에서 걸립니다 |

`snapshot()` 필드:

| 필드 | 설명 |
|---|---|
| `state` | `'idle'` 처음 · `'starting'` 카메라 여는 중 · `'running'` 실행 중 · `'stopped'` 정지됨 · `'error'` 카메라 오류 |
| `error`, `errorCode` | 화면에 보이는 한국어 카메라 오류 문구와 코드(`not-allowed`, `not-found`, `not-readable`, `overconstrained`, `unsupported`, `disconnected`, `unknown`). 없으면 `null` |
| `frameCount` | 시작한 뒤 새로 그린 프레임 수 (동기: 분석한 프레임, 비동기: 카메라 프레임. 다시 그리기는 세지 않음) |
| `renderFps` | 최근 1초 화면 갱신 FPS (동기 표시면 추론 FPS와 같고, 멈추면 0으로 떨어짐). 목표 FPS가 2 이하면 창을 `2.5초 / 목표 FPS`로 늘려 1fps도 0으로 읽히지 않게 합니다 (`inferenceFps`도 같음) |
| `videoWidth`, `videoHeight` | 카메라 프레임 크기 |
| `mirror` | 미러 표시 여부 |
| `deviceId` | 열려 있는 카메라 장치 ID. 열린 스트림이 없으면 `deviceId` 파라미터(기본 카메라면 `null`)이고, 다음 시작은 이 장치를 엽니다 |
| `tracks` | 마지막으로 연 스트림의 트랙 `{ kind, label, readyState }[]`. 정지 후에도 남아 있어 `readyState === 'ended'`를 확인할 수 있습니다 |
| `devices` | 카메라 선택지 `{ deviceId, label }[]` (권한을 얻은 뒤 채워짐). 패널의 선택 상자는 이름만 보여 주므로 ID는 여기서 읽습니다 |
| `detectorState` | `'idle'` · `'loading'` 불러오는 중 · `'ready'` · `'error'` |
| `detectorError` | 검출기 오류 문구 (한국어). 없으면 `null` |
| `detectorId` | 지금 불러와 있는 Detector 레지스트리 id (`mediapipe-face-short` / `mediapipe-face-full`) |
| `location` | 지금 검출기가 도는 곳 `'worker'`/`'main'` (불러오기 전·오류면 `null`). 요청한 값은 `get('location')` |
| `activeDelegate` | 실제로 쓰는 실행 장치 `'GPU'`/`'CPU'` |
| `delegateFallback` | GPU를 요청했지만 CPU로 대체했을 때 그 이유. 아니면 `null` |
| `displayMode` | `'sync'`/`'async'` |
| `detections` | 화면에 그린 박스의 검출 결과 `{ label, score, box, keypoints }[]` (비동기면 최신 검출, 전체를 가렸으면 `[]`). 좌표는 원본 프레임 픽셀(미러링 전)이고, 얼굴이 가장자리에 걸리면 박스가 프레임 밖으로 나갈 수 있습니다 (자르지 않음) |
| `tracked` | 트래커가 내보낸 트랙 `{ id, label, box, rawBox, held, lastSeenMs }[]`. `box`는 스무딩·합집합 후 박스, `rawBox`는 마지막 검출 박스, `held`는 이번 프레임에 검출되지 않고 유지 중인지 |
| `regions` | 화면에 그려진 모자이크 영역 (원본 픽셀). 자르지 않은 박스를 패딩한 뒤 프레임 안으로 자른 것이라, 가장자리에 걸린 얼굴도 안쪽 여백은 실제 얼굴 크기 기준입니다. 전체를 가렸으면 프레임 전체 하나 |
| `drawnFrameId` | 렌더러가 마지막으로 그린 프레임 id (지우면 `null`) |
| `detectionFrameId` | 화면에 그린 박스를 낸 검출 프레임 id (전체를 가렸으면 `null`). 동기 표시에서는 `drawnFrameId`와 같습니다. 그린 프레임과 검출 결과가 짝이 맞는지는 `sync-moving.spec.ts`의 픽셀 검사도 확인합니다 |
| `failReason` | 실행 중 검출 결과를 믿을 수 없는 이유: `'loading'` 불러오는 중 · `'error'` 오류 · `'waiting'` 첫 결과 대기 · `'stalled'` 결과가 1초(목표 FPS 1이면 2초)보다 오래됨 · 믿을 수 있으면 `null` |
| `failClosed` | 실행 중이고 `failReason`이 있다 (비동기: 화면 전체를 가림, 동기: 새 프레임을 그리지 않음). 지금 화면이 전체를 가린 것인지는 `fullCover` |
| `fullCover` | 화면에 그린 프레임이 전체를 가린 것인지 (비동기 fail-closed) |
| `inferenceFps`, `inferenceMs` | 추론 FPS, `detect()` 시간(ms, 지수 이동 평균. Worker면 메시지 왕복 포함) |
| `droppedFrames` | 차례가 왔지만 추론 중이라 버린 프레임 수 (시작마다 0부터) |
| `workers` | 검출 Worker `{ created, live }`: 페이지를 연 뒤 만든 수, 지금 살아 있는 수 (Worker 실행 중이면 1, 메인이면 0) |
| `longTasks` | 메인 스레드 롱태스크(>50ms, `PerformanceObserver('longtask')`) `{ count, maxMs, recent: { startMs, durationMs }[] }` (페이지를 연 뒤, `recent`는 최근 50개) |
| `viewRect` | 캔버스 버퍼 안에서 프레임이 그려진 영역 (기기 픽셀). 원본 좌표 → 캔버스 좌표: `x' = viewRect.x + x·viewRect.width/videoWidth` (미러면 `viewRect.x + viewRect.width − (x+w)·…`) |
| `blockedRequests` | 앱이 막은 텔레메트리 요청 URL (메인 + Worker) |

파라미터 (`get`/`set`, PLAN §4 중 지금까지 구현한 것). `blockMode`부터 `solidColor`까지는 이펙트 파라미터로, 키·범위·기본값이 각 이펙트의 `params` 스키마(`src/effects/*.ts`)에 있습니다. 새 이펙트를 레지스트리에 등록하면 그 이펙트의 키가 스토어·패널·`get`/`set`에 그대로 생깁니다.

| 키 | 기본값 | 값 |
|---|---|---|
| `deviceId` | `''` | 카메라 장치 ID (`''` = 기본). 실행 중에 바꾸면 그 장치로 전환 |
| `mirror` | `true` | 미러 표시 |
| `model` | `'mediapipe-face-short'` | `'mediapipe-face-short'` / `'mediapipe-face-full'` / `'mediapipe-face-landmarker'` / `'owlvit'` (Detector 레지스트리 id) |
| `prompt` | `'human face, cell phone'` | 텍스트 대상 검출기의 가릴 대상 (쉼표로 구분한 영어 이름, 200자까지) |
| `owlThreshold` | `0.1` | 0.02–0.5. OWL-ViT 점수 임계 |
| `numFaces` | `4` | 1–8. FaceLandmarker 전용 (검출기가 들고 온 파라미터) |
| `holdMs` | `400` | 0–2000. 검출이 끊긴 트랙을 마지막 박스로 유지하는 시간 |
| `smoothing` | `true` | 트랙 박스 One Euro 스무딩. 내보내는 박스는 항상 그 프레임의 검출 박스를 덮습니다(스무딩 박스와 합집합) |
| `minCutoff`, `beta` | `1`, `0.01` | One Euro 파라미터 |
| `iouThreshold` | `0.3` | 트랙 매칭 IoU 임계 |
| `shape` | `'rect'` | `'rect'`(사각형) / `'ellipse'`(타원) |
| `location` | `'worker'` | 실행 위치 `'worker'` / `'main'`. 바꾸면 검출기를 새로 만들고 이전 Worker는 끝냅니다 |
| `delegate` | `'GPU'` | `'GPU'` / `'CPU'` |
| `minConfidence` | `0.5` | 0.1–0.99 (step 0.01). 패널 슬라이더는 놓을 때 반영 (바꿀 때마다 MediaPipe 그래프를 다시 만듦) |
| `nmsThreshold` | `0.3` | 0.1–0.9 (step 0.01). 패널 슬라이더는 놓을 때 반영 |
| `inferenceSize` | `640` | 추론 입력의 긴 변: `320` / `480` / `640` / `0`(원본) |
| `targetFps` | `8` | 1–15 |
| `effect` | `'pixelate'` | `'pixelate'` / `'solid'` (Effect 레지스트리 id) |
| `padding` | `1.3` | 1.0–2.0 (step 0.05) |
| `displayMode` | `'sync'` | 표시 모드 `'sync'`(동기) / `'async'`(비동기) |
| `blockMode` | `'relative'` | `'relative'`(영역 폭 대비 칸 수) / `'absolute'`(px) |
| `blockSize` | `16` | 4–64 (절대, 원본 프레임 px) |
| `blockCells` | `10` | 4–32 (상대, 영역 폭을 나눌 칸 수) |
| `strength` | `1` | 0–1 (픽셀화 전용, 원본과 혼합. 0이면 픽셀화를 그리지 않음. 단색은 무시) |
| `solidColor` | `'#000000'` | `#rrggbb` (단색 이펙트) |
| `debug` | `false` | 디버그 오버레이 (검출 박스·점수·키포인트, 모자이크 영역 점선) |

예:

```js
await window.__am.start();
window.__am.set('blockMode', 'absolute');
window.__am.set('blockSize', 32);
window.__am.set('minConfidence', 0.99); // 다음 분석 프레임부터 검출 0개
const s = window.__am.snapshot();
s.detections; // [{ label: 'face', score: 0.92, box: { x: 215, y: 119, width: 224, height: 224 }, keypoints: [...] }]
s.drawnFrameId === s.detectionFrameId; // true (동기 표시)
window.__am.set('displayMode', 'async');
window.__am.fault('delay', 3000); // 1초 뒤부터 화면 전체를 가린다 (s.failReason === 'stalled', s.fullCover)
window.__am.fault('none');
window.__am.renders().at(-1); // { seq, frameId, detectionFrameId, mode: 'async', fullCover: false }
```

## 디렉터리

```
scripts/          make-fixtures.mjs
src/main.ts       조립 지점 (레지스트리 등록, 파이프라인·패널 생성, 카메라 상태, 테스트 훅)
src/core/         types.ts, geometry.ts, params.ts (ParamStore), registry.ts, pipeline.ts,
                  frame-gate.ts (목표 FPS), fps-counter.ts, detections.ts (좌표 되돌리기), rules.ts, local-only.ts,
                  fail-closed.ts (검출 결과를 믿을 수 있는지)
src/tracking/     iou-tracker.ts (IoU 그리디 매칭, 트랙 ID, 박스 유지, 스무딩), one-euro.ts
src/detectors/    mediapipe-task.ts (MediaPipe 태스크 공통: WASM 로딩, GPU→CPU 대체),
                  mediapipe-face.ts (FaceDetector 어댑터), mediapipe-face-landmarker.ts (FaceLandmarker 어댑터),
                  owlvit.ts (텍스트 대상 검출기, Transformers.js OWL-ViT)
src/detectors/worker/  detector.worker.ts (검출 Worker), proxy.ts (DetectorProxy, RPC), protocol.ts (메시지 타입)
src/effects/      pixelate.ts, solid.ts, cover.ts (fail-closed 전체 덮개), clip.ts (타원 모양 자르기)
src/sources/      camera.ts (웹캠 FrameSource)
src/render/       canvas2d-renderer.ts, debug-overlay.ts
src/ui/           panel.ts (Tweakpane), stats.ts (헤더 통계 표시), status-text.ts (화면 위 안내), long-tasks.ts (롱태스크 수)
tests/unit/       Vitest
tests/e2e/        Playwright (pixels.ts: 캔버스 픽셀 분석 헬퍼)
```
