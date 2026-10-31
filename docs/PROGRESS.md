# 진행 기록

단계별로 만든 것, PLAN과 달라진 점, 알려진 문제를 적는다. 설계는 [PLAN.md](PLAN.md)가 기준이다.

## P1 스캐폴딩 + 웹캠 (M0 + M1) — 2026-10-31

### 만든 것

- **스캐폴딩**: Vite 8 + TypeScript(strict) + Vitest + Playwright. UI 프레임워크 없음. `package.json` 스크립트 `dev`(5317 고정) `build` `preview`(5318 고정) `typecheck` `test` `e2e` `assets` `fixtures`. `.gitignore`에 `node_modules`, `dist`, `public/models`, `public/wasm`, `tests/fixtures`, `tests/artifacts`, `test-results`, `playwright-report`, `*.part`.
- **`scripts/fetch-assets.mjs`**: 모델 3종을 `public/models/`에 받고 WASM 4개(`vision_wasm_internal.{js,wasm}`, `vision_wasm_module_internal.{js,wasm}`)를 `public/wasm/`에 복사한다. 있는 파일은 건너뛰고(WASM은 크기가 다르면 다시 복사), `*.part`에 받은 뒤 `Content-Length`를 확인하고 rename 한다. `predev`, `prebuild` 훅으로 걸려 있어 `npm install && npm run dev`만으로 동작한다.
- **`scripts/make-fixtures.mjs`**: `portrait.jpg`를 받아 640×480·15fps·60프레임(4초)·yuv420p y4m 4개를 만든다. `still-1face`(원본 크기 그대로 얼굴 주변 crop), `moving-1face`(회색 배경 위 240×240 머리가 사인 곡선으로 왕복, 얼굴 중심 x≈80→560, 주기 4초라 반복 재생이 이어짐), `two-faces`(같은 crop 두 장 hstack), `no-face`(오른쪽 위 커튼·깃발 부분). 결과를 ffprobe로 크기·pix_fmt·fps·프레임 수까지 검증하고, 통과한 파일은 다음 실행에서 건너뛴다. `--force`로 재생성.
- **`src/core/types.ts`**: PLAN §2.2 타입(`Detection`, `Detector`, `DetectorOptions`, `Track`, `Region`, `Effect`, `ParamSpec`, `Rule`)과 `Point`/`Point3`/`Size`/`Rect`, `Frame`, `FrameSource`, `Trigger`/`TriggerEvent`.
- **`src/core/geometry.ts`**: `clamp`, `scaleRect`, `padRect`, `clampRect`, `area`, `iou`, `mirrorRect`, `mirrorPoint`, `fitContain`(레터박스).
- **`src/sources/camera.ts`**: 웹캠 `FrameSource`. `getUserMedia`(ideal 1280×720, 오디오 없음), 권한을 얻은 뒤 `enumerateDevices`로 장치 목록, `start(deviceId)`로 열기·장치 전환(새 장치를 먼저 열고 성공하면 이전 트랙 정지, getUserMedia가 실패하면 이전 스트림 유지, 재생이 실패하면 둘 다 놓음), `devicechange` 구독, 트랙 `ended`(장치 분리) 감지. 고른 장치는 들고 있지 않는다(호출부의 선택 상자가 유일한 기준). `NotAllowedError`/`SecurityError`, `NotFoundError`, `NotReadableError`/`AbortError`, `OverconstrainedError`(`constraint`가 `deviceId`면 `not-found`)와 `mediaDevices` 없음(비보안 컨텍스트)을 `CameraError`(코드 + 한국어 문구)로 바꾼다. 프레임은 `requestVideoFrameCallback`마다 `createImageBitmap`으로 만들고(이전 변환이 안 끝났으면 버림), 단조 증가 `id`와 `timestampMs`를 붙인다. `stop()`은 모든 트랙을 멈추고 rVFC를 취소하고 `srcObject`를 비운다. 세대 카운터로 "연결 중 정지" 같은 경쟁을 처리한다(밀려난 `start()`는 던지지 않고 끝나며 결과는 `active`로 본다).
- **`src/render/canvas2d-renderer.ts`**: 캔버스를 컨테이너에 꽉 채우고 버퍼는 `ResizeObserver`의 `device-pixel-content-box`로 기기 픽셀에 맞춘다(devicePixelRatio·줌 반영). 프레임은 비율을 지켜 가운데 맞춤으로 그리고, 미러링은 여기서만 캔버스 변환으로 한다. 변환이 프레임 좌표 → 캔버스 좌표라서 다음 단계 이펙트도 프레임 좌표로 그리면 된다.
- **앱 셸** (`index.html`, `src/main.ts`, `src/ui/stats.ts`, `src/style.css`): 시작/정지 토글 버튼, 카메라 선택, 미러 표시 체크박스(기본 켬), 상태 문구(`role=status`), 오류 문구(`role=alert`), 렌더 FPS·영상 크기 표시. 라이트/다크 색 토큰.
- **테스트 훅 `window.__am`** (`src/test-hook.ts`): `snapshot()`(state, error, errorCode, frameCount, renderFps, videoWidth/Height, mirror, deviceId, tracks), `get/set('mirror')`, `start()`, `stop()`. README에 문서화.
- **테스트**: Vitest 37개(geometry, 카메라 오류 매핑·constraints, FpsCounter·formatStats). Playwright 12개(아래, 리뷰 수정 포함).

### 파일 지도

```
package.json  vite.config.ts  playwright.config.ts  .gitignore  index.html  README.md
tsconfig.json                   참조만 (tsc -b)
tsconfig.app.json               src/ (브라우저 타입만)
tsconfig.node.json              tests/, 설정 파일 (Node 타입)
scripts/fetch-assets.mjs        모델 다운로드 + WASM 복사 (멱등, 원자적 쓰기)
scripts/make-fixtures.mjs       y4m 픽스처 생성 + ffprobe 검증
src/main.ts                     조립 지점: DOM 연결, 앱 상태, 테스트 훅
src/test-hook.ts                window.__am 타입
src/style.css
src/core/types.ts               파이프라인 공통 타입
src/core/geometry.ts            좌표 헬퍼
src/sources/camera.ts           CameraSource, CameraError, toCameraError, cameraConstraints
src/render/canvas2d-renderer.ts Canvas2DRenderer
src/ui/stats.ts                 FpsCounter, formatStats, StatsView
tests/unit/geometry.test.ts  camera-errors.test.ts  stats.test.ts
tests/e2e/helpers.ts            useFakeCamera, canvasThumb, flipThumb, meanAbsDiff, litRatio …
tests/e2e/global-setup.ts       픽스처가 없으면 생성
tests/e2e/still.spec.ts         idle, 렌더·FPS·장치 목록, 미러, 정지, 외부 요청 0
tests/e2e/moving.spec.ts        프레임 변화
tests/e2e/denied.spec.ts        권한 거부
tests/e2e/devices.spec.ts       카메라 전환, 장치 분리·경쟁 흉내 (합성 가짜 카메라 2대)
tests/e2e/hidpi.spec.ts         기기 픽셀 비율 2에서 캔버스 버퍼 크기
```

### 버전

`@mediapipe/tasks-vision` 1.2.0(정확히 고정), `tweakpane` 4.0.5(고정, P2에서 사용), `vite` 8.3.5, `vitest` 5.0.5, `@playwright/test` 1.64.1, `typescript` 7.0.2, `@types/node` 26. TypeScript 7(네이티브 `tsc`)은 마찰 없이 동작했다: `tsc --noEmit`이 정상적으로 타입 오류를 잡고, Vite/Vitest/Playwright는 TypeScript 패키지를 직접 쓰지 않는다. 그래서 7.0.2를 그대로 쓴다.

### PLAN과 다른 점 (이유)

1. **린트 미설정**: PLAN M0에 "린트"가 있지만 이번 단계 지시의 스크립트 목록에 없고 PoC 규모에서 과하다고 봤다. 대신 tsconfig를 엄격하게 둔다(`strict`, `noUnusedLocals/Parameters`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`).
2. **상태 `starting` 추가**: 요구된 `idle|running|stopped|error`에 `starting`(getUserMedia 대기)을 더했다. 권한 프롬프트는 얼마든지 길어질 수 있어서 그동안 버튼을 막고 "카메라 연결 중…"을 보여 주기 위해서다.
3. **자산 훅은 `predev`/`prebuild`**: `postinstall`은 오프라인 `npm install`을 실패시키고 `npm test`에는 자산이 필요 없어서 쓰지 않았다.
4. **포트는 `package.json` 스크립트에 고정** (`vite.config.ts`에는 두지 않음, 한 곳만 관리).
5. **`Frame` 타입 추가, `FrameSource.onFrame`은 단일 소비자**: 프레임마다 ImageBitmap 소유권을 넘겨야(나중에 Worker로 transfer) 하므로 소비자를 하나(파이프라인)로 정했다.
6. **캡처용 `<video>`를 DOM 안(캔버스 뒤)에 둠**: 문서에 붙지 않은 비디오는 Chrome이 백그라운드 렌더링 경로로 rVFC를 느리게 부를 수 있어서다. 헤드리스 측정에서는 분리된 비디오도 15회/초였지만 실제 창에서는 보장되지 않는다.
7. **장치 전환 실패 시 기존 카메라 유지**: 새 장치를 못 열면(getUserMedia 실패) 상태는 `running` 그대로, 오류 문구만 보여 주고 선택 상자를 원래 장치로 되돌린다. 재생 실패로 기존 스트림까지 잃었으면 `error`가 된다. 시작 실패, 권한 거부, 장치 분리도 `error` 상태가 된다. 전환하는 동안에는 선택 상자를 막는다.
8. **정지·오류 시 캔버스를 지운다** (자리표시 문구가 보이도록).
9. **`ParamSpec`, `DetectorOptions` 구체화**: PLAN에는 이름만 있어 `ParamSpec`은 number/boolean/select 세 가지, `DetectorOptions`는 `delegate`/`minConfidence`/`nmsThreshold`로 정했다. 추론 해상도·목표 FPS는 Detector가 아닌 파이프라인 파라미터로 둘 계획이다. `Trigger`는 타입만 두었다(no-op 구현은 파이프라인을 만드는 단계에서).
10. **테스트 훅은 프로덕션 빌드에도 포함**: E2E가 `vite preview`(빌드 결과)에서 돌기 때문이다.
11. **Playwright 픽스처 선택은 프로젝트 대신 파일 최상위 `test.use()`** (`useFakeCamera()`): `launchOptions`는 워커 단위라 describe 안에서는 바꿀 수 없고 파일 최상위에서만 된다.
12. **권한 거부 흉내**: `--use-fake-ui-for-media-stream=deny` + `permissions: []`. 둘 다 각각만으로도 `NotAllowedError`가 나는 것을 확인했고, 확실히 하려고 둘 다 쓴다.

### 알려진 문제·한계

- 실제 웹캠, 실제 장치 분리(`ended`/`devicechange`) 경로는 자동 테스트하지 못한다. E2E는 합성 이벤트와 `enumerateDevices`/`getUserMedia` 덮어쓰기로 흉내만 낸다. 마지막에 사용자가 직접 확인해야 한다.
- 파일 기반 가짜 카메라는 ideal 1280×720을 무시하고 파일 크기(640×480)를 그대로 낸다. 실제 웹캠에서 1280×720이 나오는지는 확인하지 못했다.
- 렌더는 카메라 프레임 속도를 그대로 따른다. 목표 FPS 상한과 추론 백프레셔는 파이프라인 단계(P4)에서 붙인다.
- 캔버스 크기가 바뀌면 다음 프레임이 올 때까지 배경색으로 비어 보인다.
- `two-faces.y4m`, `no-face.y4m`는 만들어 두었지만 P1 테스트에서는 아직 쓰지 않는다.
- y4m 헤더의 `XCOLORRANGE=FULL`(JPEG 원본)은 Chrome이 무시하므로 색 범위가 약간 다를 수 있다. 테스트에는 영향 없다.
- `npm run e2e`는 매번 빌드 후 preview 서버를 띄운다(`reuseExistingServer: false`, 5318이 이미 쓰이면 실패).

### 실행한 명령과 결과

| 명령 | 결과 |
|---|---|
| `npm run assets` (처음) | 모델 3개 다운로드(224KB, 1058KB, 3671KB), WASM 4개 복사 |
| `npm run assets` (두 번째) | `다운로드 0개, 복사 0개` |
| 모델 1개·WASM 1개를 지우고 `npm run assets` | 지운 것만 다시 받음/복사 |
| `npm run fixtures` (처음 / 두 번째) | 4개 생성, 모두 640x480 15/1fps 60프레임 / 모두 건너뜀 |
| `npm run typecheck` | 통과 (오류 0) |
| `npm test` | 3 파일, 36 테스트 통과 |
| `npm run build` | 통과 (JS 9.2KB, CSS 2.1KB + public 자산) |
| `npm run dev` | 5317에서 기동, `/models/*.tflite`, `/wasm/*.wasm` 200 확인 후 종료 |
| `npm run e2e` | 8 테스트 통과 (약 19초). `npx playwright test --repeat-each=3`으로 24/24 통과 |

E2E 측정값(헤드리스 Chrome 156, 가짜 카메라 15fps): 렌더 FPS ≈ 15, 미러 비교에서 원본 대비 평균 차이 ≈ 31, 원본을 뒤집은 것 대비 0, 움직이는 영상 0.5초 간격 평균 차이 ≈ 13.

E2E가 확인하는 것:

- `still.spec.ts`: 시작 전 idle·빈 캔버스 / 시작 후 캔버스가 비어 있지 않음, 렌더 FPS > 5, 640×480, 트랙 live, 장치 목록 채워짐 / 미러 토글이 화면을 좌우로 뒤집음(UI 체크박스와 `__am.set` 둘 다) / 정지하면 모든 트랙 `ended`, `srcObject` null, 영상 크기 0×0(`영상 —`), frameCount 고정, FPS 0, 다시 시작 가능 / 로드·시작·토글·정지·새로고침 동안 localhost 밖 요청 0
- `moving.spec.ts`: 렌더 FPS > 5, 첫 화면과 달라질 때까지 다시 찍어 화면 변화 확인(최대 3초)
- `denied.spec.ts`: 권한 거부 시 `error` 상태, `not-allowed`, 한국어 안내(`role=alert`), 시작 버튼 다시 활성, 잡히지 않은 예외 0
- `devices.spec.ts`: 카메라를 바꾸면 deviceId가 바뀌고 이전 트랙 `ended`, 새 트랙 live, 렌더 계속, 전환 중 선택 상자 비활성 / 고른 카메라가 빠지면 `disconnected`, 선택 상자는 남은 카메라 하나, 다시 시작하면 그 카메라를 연다 / 전환 중 재생이 실패하면 `error`, 다시 시작 가능 / 연결 중 재생을 기다리는 사이 트랙이 끝나면 `error`로 남는다
- `hidpi.spec.ts`: `--force-device-scale-factor=2`에서 캔버스 버퍼가 CSS 크기의 2배

모든 테스트는 `pageerror`(잡히지 않은 예외)가 없는지도 확인한다.

### 리뷰 수정

리뷰에서 확인된 문제를 고쳤다.

- **고른 카메라를 뽑으면 다시 시작이 막히던 문제** (P1-correctness-1, P1-architecture-1, P1-platform-perf-1, major): `CameraSource.requestedDeviceId`를 없앴다. 고른 장치는 선택 상자 값 하나로만 들고, `main.start()`가 매번 `camera.start(ui.camera.value || undefined)`로 연다. `camera.deviceId`는 열린 스트림의 장치만 돌려준다. 그래서 `refreshDevices()`가 사라진 장치 대신 첫 항목을 고르면 다음 시작도 그 장치를 연다. `CameraSource.switchDevice()`도 없앴다. 실행 중 `start(id)`가 곧 전환이다. B→C 전환 경쟁에서 이전 값으로 되돌리던 코드도 함께 사라졌다. `deviceId`(exact)가 걸린 `OverconstrainedError`는 `not-found`("카메라를 찾을 수 없습니다. 웹캠 연결과 카메라 선택을 확인한 뒤…")로 바꿨다. 해상도는 ideal로만 걸기 때문이다. 다른 장치로 몰래 다시 여는 폴백은 넣지 않았다. `snapshot().deviceId`는 열린 장치, 없으면 선택 상자 값이다.
- **밀려난 시작·전환이 성공처럼 보이던 문제** (P1-correctness-2, P1-architecture-2): `stop()`과 `fail()`이 같은 `release()`를 거치고, 여기서 `startToken`을 올린다. 그래서 연결 중에 트랙이 끝나 `fail()`이 불리면 기다리던 `start()`가 `running`으로 덮어쓰지 않는다. `main.switchDevice()`는 시작 시점의 토큰을 확인해 그사이 정지·오류가 있었으면 아무것도 하지 않는다. 전환 뒤 `camera.active`가 거짓이면(재생 실패로 기존 스트림까지 잃음) `fail()`로 `error`가 된다. 전환하는 동안에는 선택 상자를 막아 전환이 겹치지 않는다. `CameraSource.start()`는 스트림을 붙이자마자 rVFC를 건다(이전에는 재생이 끝난 뒤였다). 그래서 밀려났더라도 남은 스트림에는 항상 프레임 루프가 있다. 기다리는 사이 밀려난 `start()`는 getUserMedia가 실패해도 던지지 않는다. 전환 뒤에는 선택 상자를 늘 열린 장치에 맞춘다. 전환 중 `devicechange`가 오면 선택 상자가 이전 장치로 돌아갈 수 있기 때문이다.
- **`moving.spec.ts`가 샘플 시점에 따라 실패할 수 있던 문제** (P1-correctness-3): 0.5초 간격 한 번만 비교하지 않는다. 첫 화면과 평균 차이가 2를 넘을 때까지 `expect.poll`로 다시 찍는다(최대 3초).
- **nit 적용**
  - P1-correctness-5 / P1-architecture-4: 정지·오류 때 `videoSize`를 0×0으로 되돌린다. 그러면 통계는 `영상 —`가 된다.
  - P1-architecture-5: 쓰지 않던 `CameraSource.videoSize` getter를 지웠다.
  - P1-platform-perf-5: `not-allowed` 문구에 macOS 시스템 설정(개인정보 보호 및 보안 > 카메라) 안내를 더했다.
  - P1-correctness-4: tsconfig를 `tsconfig.app.json`(`src/`, `types: ["vite/client"]`)과 `tsconfig.node.json`(테스트·설정 파일, `types: ["node"]`)으로 나눴다. 루트 `tsconfig.json`은 참조만 두고, `typecheck`는 `tsc -b`다. `src/`에 `process`나 `Buffer`를 쓰면 이제 타입 오류가 난다(직접 확인함). 빌드 정보 파일은 `node_modules/.tmp/`에 생긴다.
  - P1-platform-perf-6: `hidpi.spec.ts`를 추가했다. Playwright의 `deviceScaleFactor: 2`는 쓸 수 없었다. 헤드리스 Chrome에서 `devicePixelRatio`는 2가 되지만 `devicePixelContentBoxSize`는 CSS 픽셀을 돌려주기 때문이다(직접 확인함). 그래서 `--force-device-scale-factor=2`와 `viewport: null`로 실제 레티나 화면처럼 띄운다. 이렇게 하면 dpr 2, 기기 픽셀 박스 2배가 된다. 이를 위해 `useFakeCamera()`에 Chrome 플래그를 더하는 `args` 옵션을 두었다.
  - P1-platform-perf-4 (일부): `fetch-assets.mjs`는 `text/html` 응답(캡티브 포털·프록시 페이지)을 모델로 저장하지 않는다. 매직 바이트 검사는 넣지 않았다. `face_landmarker.task`는 offset 0이 아니라 2에 `PK`가 있어서, 제안대로 검사하면 정상 파일을 거부한다. 전체 다운로드 타임아웃도 넣지 않았다. 느린 회선에서 정상 다운로드를 끊을 수 있기 때문이다.
- **새 테스트**: Vitest 1개(`deviceId` OverconstrainedError → `not-found`). macOS 안내 문구 확인도 기존 테스트에 더했다. E2E는 `devices.spec.ts` 3개(장치 분리 후 다시 시작, 전환 중 재생 실패, 연결 중 트랙 종료)와 `hidpi.spec.ts` 1개를 더했다. 기존 테스트에도 확인을 더했다: 전환 중 선택 상자 비활성, 정지 뒤 영상 크기 0×0. 장치 분리는 `enumerateDevices`에서 장치를 빼고, 그 장치를 열려고 하면 실제 Chrome처럼 `OverconstrainedError('deviceId')`를 던지게 덮어써 흉내 낸다. 그다음 트랙에 `ended`, `mediaDevices`에 `devicechange`를 보낸다.
- **테스트가 버그를 잡는지 확인**: 고친 동작을 하나씩 되돌려 보았다. 확인 뒤 원래 코드로 복원했다.
  - 고른 장치를 전환 때만 기억하게 되돌리면 장치 분리 테스트가 실패한다.
  - 전환 뒤 `fail()` 분기를 빼면 재생 실패 테스트가 실패한다.
  - `fail()`이 토큰을 올리지 않게 하면 연결 중 트랙 종료 테스트가 실패한다.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` (`tsc -b`) | 통과 |
| `npm test` | 3 파일, 37 테스트 통과 |
| `npm run build` | 통과 (JS 9.2KB) |
| `npm run e2e` | 12 테스트 통과 (약 25초) |
| `npx playwright test --repeat-each=3` | 36/36 통과 |

## P2 얼굴 검출 + 모자이크 (M2 + M3) — 2026-10-31

### 만든 것

- **`src/detectors/mediapipe-face.ts`** (`MediaPipeFaceDetector`): MediaPipe `FaceDetector`(runningMode `VIDEO`) 어댑터. WASM은 `/wasm`, 모델은 `/models`(같은 출처)에서 읽는다. `@mediapipe/tasks-vision` 번들은 처음 쓸 때 동적 import 한다(별도 청크 154KB). 생성자에서 모델(`short`/`full`)을 받고, `init`/`updateOptions`로 실행 장치(GPU/CPU)·`minDetectionConfidence`·`minSuppressionThreshold`를 받는다. 신뢰도·NMS는 `setOptions`로 바로 바꾸고, 실행 장치가 바뀌면 태스크를 새로 만든다. GPU를 요청하면 GPU로 먼저 만들고, **만들 때** 실패하거나 GPU **추론이 실패하면**(첫 추론이든 나중이든) CPU로 다시 만들어 그 프레임을 다시 처리한다. 실제 실행 장치(`activeDelegate`)와 대체 이유(`fallbackReason`)를 보고한다. VIDEO 모드 타임스탬프는 단조 증가로 맞춘다. 박스는 입력 픽셀, 키포인트(6개)는 정규화 좌표에 입력 크기를 곱해 공통 `Detection`으로 바꾼다(`toDetection`). WebGL2가 없으면 만들기 전에 한국어 오류를 던진다.
- **`src/core/pipeline.ts`** (`Pipeline`): Source → Detector → 패스스루 Tracker → Trigger(빈 훅) → Rules → Renderer+Effect.
  - **동기 표시**: 분석이 끝난 프레임만 그 프레임의 검출 결과와 함께 그린다. 카메라 프레임을 그대로 그리는 코드 경로가 없다. 마지막 분석 프레임(ImageBitmap)과 검출 결과를 들고 있다가, 표시 파라미터(미러·이펙트·패딩·블록·강도·색·디버그)가 바뀌거나 캔버스 크기가 바뀌면 **같은 프레임·같은 검출 결과**로 다시 그린다. 검출기를 불러오거나 다시 만드는 동안(`loading`)·오류(`error`)일 때는 새 프레임을 닫기만 하므로 화면에는 마지막 분석 프레임(없으면 빈 캔버스)이 남는다.
  - **백프레셔**: 추론 중인 프레임은 1개. 목표 FPS 차례가 왔는데 추론 중이면 버리고 `droppedFrames`를 센다. 차례가 아닌 프레임은 세지 않고 건너뛴다.
  - **목표 FPS** (`src/core/frame-gate.ts` `FrameGate`): 다음 차례 시각을 간격만큼 누적해 평균이 목표에 맞게 고른다. 카메라 타임스탬프 흔들림 때문에 간격의 1/4까지 일찍 온 프레임도 받고, 많이 밀렸으면 지금부터 다시 센다.
  - **추론 해상도**: 긴 변이 320/480/640/원본이 되게 `createImageBitmap(resize)`로 줄여 넣고, 결과를 원본 프레임 픽셀로 되돌린다(`src/core/detections.ts` `mapToSource`). 프레임 밖으로 나간 부분은 자르지 않는다(리뷰 수정).
  - **검출기 작업 직렬화**: 초기화·옵션 변경·추론을 한 줄(promise 체인)로 세운다. 모델·실행 장치를 연달아 바꾸면 마지막 요청만 실행한다(`syncDetector`, 토큰). 같은 모델이면 `updateOptions`(실행 장치 변경은 어댑터가 새로 만든다), 다른 모델이면 이전 것을 `dispose`하고 레지스트리에서 새로 만든다.
  - 자르지 않은 박스에 패딩(`padRect`) → 바깥쪽 정수 픽셀 맞춤(`snapOut`) → 프레임 클램프 후 이펙트에 `Region { kind: 'rect', unclipped }`로 넘긴다(`unclipped`는 자르기 전 영역, 리뷰 수정). 디버그 오버레이는 이펙트 뒤에 그린다.
  - 추론 실패(GPU→CPU 재시도까지 실패)나 초기화 실패는 `error` 상태와 한국어 문구가 된다. 모델·실행 장치를 다시 고르면 다시 시도한다.
- **`src/core/params.ts`** (`ParamStore`): PLAN §4 파라미터 중 지금까지 구현한 16개(`deviceId mirror model delegate minConfidence nmsThreshold inferenceSize targetFps effect padding blockMode blockSize blockCells strength solidColor debug`). 리뷰 수정 뒤에는 코어 11개만 `Params`/`DEFAULT_PARAMS`에 있고 이펙트 5개는 이펙트 스키마에서 온다. `get/set/subscribe/snapshot`. 값은 스키마(`ParamSpec`)로 검사한다: 타입이 다르면 거부, 숫자는 범위로 자르고 step에 맞춤(패널 슬라이더와 같은 값), 선택지는 목록(모델·이펙트는 레지스트리)에 있어야 함, 색은 `#rrggbb`. 바뀐 값만 알린다. 이펙트와 무관한 스키마는 `coreParamSpecs()`, 이펙트 스키마는 각 이펙트의 `params`에 있다.
- **`src/core/registry.ts`** (`Registry`): id로 찾는 등록부. Detector는 팩토리(`DetectorEntry.create`)로 등록한다. `main.ts`가 `mediapipe-face-short`, `mediapipe-face-full`(같은 어댑터, 다른 모델)과 `pixelate`, `solid`를 등록하고, 패널의 모델·이펙트 선택지는 레지스트리 목록에서 나온다.
- **`src/core/rules.ts`**: 기본 규칙 `'face'` → 고른 이펙트(`defaultRules`), 첫 번째로 맞는 규칙(`matchRule`, label·trackIds).
- **`src/core/detections.ts`**: `mapToSource`. `passThroughTracks`(검출 하나 = 트랙 하나, M5에서 IoU 트래커로 교체)는 리뷰 수정에서 `src/tracking/pass-through.ts`로 옮겼다.
- **`src/effects/pixelate.ts`**: 영역을 `cols × rows`로 축소(`imageSmoothingQuality: 'high'`) → 스무딩 없이 확대. 블록 크기 방식 상대(영역 폭을 `blockCells` 칸으로) / 절대(`blockSize` 원본 px), 강도(`globalAlpha`로 원본과 혼합, 0이면 그리지 않음). `src/effects/solid.ts`: 색 채움(`solidColor`). 둘 다 `Region`을 감싸는 사각형(`regionBounds`)에 적용한다.
- **`src/render/debug-overlay.ts`**: 검출 박스(초록), 모자이크 영역(노랑 점선), 키포인트, 점수. 글자는 미러에 뒤집히지 않게 캔버스 좌표로 쓴다.
- **`src/render/canvas2d-renderer.ts`**: `draw(image, size, opts, paint?)` — 프레임을 그린 직후 프레임 → 캔버스 변환이 걸린 채로 `paint(ctx)`(이펙트, 오버레이)를 부른다. `viewRect`(프레임이 그려진 캔버스 영역), `onResize`(크기가 바뀌면 다시 그리기).
- **`src/ui/panel.ts`** (`ParamPanel`, Tweakpane 4): 입력(카메라, 미러 표시) · 검출(모델, 실행 장치, 최소 신뢰도, NMS 임계, 추론 해상도, 목표 FPS) · 모자이크(이펙트, 패딩 배율, 고른 이펙트의 파라미터) · 표시(디버그 오버레이) · 모니터(추론 FPS·추론 시간·검출 수 값과 그래프, 실행 장치, 버린 프레임). 값의 기준은 ParamStore이고, 패널은 사본 객체를 Tweakpane에 묶어 양쪽을 맞춘다(store가 거부하면 패널을 되돌림). 이펙트 파라미터는 스키마에서 자동으로 만들고, 고른 이펙트와 `visibleIf`(블록 방식에 따라 칸 수/px 슬라이더 하나만)에 따라 보이고 숨는다. Tweakpane 입력에는 `aria-label`을 붙였다(카메라 선택 상자 `#camera`, 미러 체크박스 `#mirror`).
- **`src/core/local-only.ts`**: `fetch`를 감싸 같은 출처가 아닌 요청을 보내기 전에 거부하고 기록한다(아래 "확인한 것" 2).
- **앱 셸**: 헤더에는 시작/정지 버튼과 렌더 통계만 남기고 카메라 선택·미러 체크박스는 패널로 옮겼다. 상태 줄 아래에 검출기 상태 줄(`#detector`: 불러오는 중 / 준비됨 · 모델 · 실행 장치 / GPU 대체 안내 / 오류, 자세한 이유는 툴팁), 화면 위 안내(`#stage-note`: 검출기를 불러오는 중, 다시 불러오는 중 — 마지막 분석 프레임 표시, 첫 프레임 분석 중, 검출기 오류). 검출기는 페이지를 열자마자 불러온다. 화면 오른쪽에 300px 패널, 폭 800px 이하에서는 아래로.
- **테스트 훅 `window.__am`**: 스냅숏에 `devices detectorState detectorError detectorId activeDelegate delegateFallback detections regions drawnFrameId detectionFrameId inferenceFps inferenceMs droppedFrames viewRect blockedRequests`를 더했다. `get/set`은 모든 파라미터, `set`은 받아들였는지(boolean)를 돌려준다. `params()` 추가. README에 표로 정리했다.

### 파일 지도 (P2에서 새로 만들거나 크게 바꾼 것)

```
src/main.ts                       조립: 레지스트리 등록, ParamStore·Pipeline·Panel 생성, 카메라 상태, UI 갱신, 테스트 훅
src/test-hook.ts                  window.__am 타입 (P2 필드 추가)
src/core/types.ts                 Delegate, Detector.activeDelegate/fallbackReason, ParamSpec(visibleIf, color), Effect.label
src/core/params.ts                Params, DEFAULT_PARAMS, coreParamSpecs, normalizeParam, ParamStore
src/core/registry.ts              Registry, DetectorEntry
src/core/pipeline.ts              Pipeline (동기 표시, 백프레셔, 검출기 교체)
src/core/frame-gate.ts            FrameGate (목표 FPS)
src/core/detections.ts            mapToSource (passThroughTracks는 리뷰 수정에서 src/tracking/pass-through.ts로)
src/core/rules.ts                 defaultRules, matchRule
src/core/local-only.ts            installLocalOnlyFetch, isAllowedUrl, blockedRequests
src/core/geometry.ts              + fitLongSide, snapOut, regionBounds
src/detectors/mediapipe-face.ts   MediaPipeFaceDetector, toDetection
src/effects/pixelate.ts           pixelate, pixelGrid
src/effects/solid.ts              solid
src/render/canvas2d-renderer.ts   paint 콜백, viewRect, onResize
src/render/debug-overlay.ts       drawDebugOverlay
src/ui/panel.ts                   ParamPanel (Tweakpane)
src/ui/stats.ts                   FpsCounter: 몰려 온 프레임 때문에 튀지 않게 간격 하한(창의 1/4) (리뷰 수정에서 src/core/fps-counter.ts로)
tests/unit/                       params, registry, frame-gate, detections(+rules), effects, local-only, mediapipe-face, pipeline(가짜 검출기·렌더러), geometry·stats 추가
tests/e2e/pixels.ts               캔버스 픽셀 분석 헬퍼 (toCanvasRect, regionStats, capture, diffOutside, nextFrames)
tests/e2e/detect.spec.ts          1인: 검출·박스 위치·키포인트·패딩 영역, 추론 해상도, 디버그 오버레이, 동기 표시 표본, 첫 프레임부터 모자이크
tests/e2e/detect-two.spec.ts      2인: 검출 2개, 둘 다 모자이크
tests/e2e/detect-none.spec.ts     얼굴 없음: 4초 동안 분석 프레임마다 0개, 강도와 무관하게 같은 화면
tests/e2e/mosaic.spec.ts          블록·바깥 동일·강도 0, 블록 크기, 단색, 패딩, 신뢰도 0.99↔0.5, 값 검사
tests/e2e/switching.spec.ts       모델 short↔full·실행 장치 GPU↔CPU 실행 중 전환(전환 중 rAF 표본), GPU 실패 → CPU 대체, WebGL 없음 → fail-closed
tests/e2e/loading.spec.ts         검출기를 늦게 불러올 때 빈 화면 → 첫 그림부터 모자이크, 모델 404 → 오류·빈 화면·재시도
tests/e2e/local-only.spec.ts      WASM·모델 localhost 로드, 전환 중 외부 요청 0·지표 전송 차단, 70초 방치 중 외부 요청 0
```

### 확인한 것

1. **blaze_face_full_range는 Tasks FaceDetector(1.2.0)에서 동작한다.** GPU·CPU 모두 만들어지고 정면 얼굴을 찾는다(정지 1인 픽스처 점수 ≈ 0.87, short-range ≈ 0.88). 그래서 UI 경고 문구는 넣지 않았다. GPU에서 full-range의 첫 추론은 셰이더 컴파일 때문에 약 1.6초 걸린다(그 뒤 약 10ms). 먼 얼굴에서 short와 비교하는 것은 먼 얼굴 픽스처가 없어 하지 못했다.
2. **MediaPipe Tasks 1.2.0은 사용 지표를 Google로 보낸다.** 번들에 `https://odml.pa.googleapis.com/v1/log`로 POST 하는 로거가 있고(README 개인정보 고지에도 있음), 태스크를 만들 때 60초 간격 타이머를 걸고 `close()` 때도 보낸다. 검증 스크립트에서 FaceDetector 4개를 만들고 닫자 외부 요청 4건이 실제로 나갔다. 끄는 옵션은 없다. 그래서 `installLocalOnlyFetch()`로 같은 출처가 아닌 `fetch`를 보내기 전에 거부한다. 거부되면 로거는 오류로 보고 타이머를 멈춘다. E2E에서 모델·실행 장치 전환(닫기 4번) 때 4건, 70초 방치 때 60초 주기 1건을 막았고 실제 외부 요청은 0건이었다. MediaPipe의 다른 네트워크 경로는 WASM 로더의 XHR(로컬 파일용)뿐이다.
3. **GPU delegate 실패는 만들 때가 아니라 첫 추론에서 드러날 수 있다.** 부동소수 텍스처 확장을 숨기면 `createFromOptions(GPU)`는 성공하고 첫 `detectForVideo`가 "No full support of FP16 on this GPU"로 실패한다. 그래서 어댑터는 만들 때와 추론 때 모두 CPU로 대체한다.
4. **MediaPipe는 CPU 실행 장치여도 WebGL2가 필요하다.** 입력 이미지를 항상 WebGL 텍스처로 올린다(`addGpuBufferToStream`). WebGL을 막으면 CPU 태스크는 만들어지지만 첫 추론이 `activeTexture` 오류로 죽는다. 그래서 만들기 전에 WebGL2를 확인해 한국어 오류를 보여 주고, 화면에는 아무것도 그리지 않는다(fail-closed).
5. 헤드리스 Chrome 156(이 Mac)에서 GPU delegate가 동작한다(WebGL2 "WebKit WebGL"). 640×480 프레임, short-range 추론 시간: GPU ≈ 4–5ms, CPU ≈ 3ms. 첫 GPU 추론은 ≈ 100ms. 목표 15fps에서 카메라 15fps를 그대로 따라간다(버린 프레임 0).
6. Tweakpane 4.0.5: 체크박스 입력은 크기 0·투명이라(`appearance: none`) Playwright가 보이지 않는 요소로 본다. CSS로 보이는 상자 위에 같은 크기로 겹쳐 두었다(클릭·키보드에도 낫다). 목록 선택 상자의 `<option>`에는 값이 없고 이름만 있다(선택은 selectedIndex로 한다). 타입은 `@tweakpane/core`가 있어야 제대로 잡힌다.

### PLAN과 다른 점 (이유)

1. **`minConfidence` 범위 0.1–0.99** (PLAN 0.1–0.9): "0.99면 검출 0개" 확인을 패널로도 할 수 있게. 정지 1인 픽스처 점수가 0.88이라 0.9로는 사라지지 않는다.
2. **모델 파라미터 = Detector 레지스트리 id**: short/full을 같은 어댑터 클래스의 두 레지스트리 항목(`mediapipe-face-short`, `mediapipe-face-full`)으로 등록했다. 모델 선택지가 레지스트리에서 나오고, M6의 두 번째 어댑터(FaceLandmarker)도 같은 선택 상자에 들어간다. 모델을 바꾸면 검출기를 새로 만들고, 실행 장치만 바꾸면 같은 어댑터가 태스크를 다시 만든다.
3. **`Detector` 인터페이스에 `activeDelegate`, `fallbackReason` 추가.** 결과 좌표는 넘겨받은 (축소된) 입력의 픽셀이고 원본 좌표로 되돌리는 것은 파이프라인이 한다(어댑터가 축소 비율을 몰라도 되게).
4. **`ParamSpec` 재정의**: `default`를 빼고(기본값은 `DEFAULT_PARAMS` 한 곳. 리뷰 수정에서 다시 넣었다) `visibleIf`와 `color` 타입을 더했다. 숫자 스키마는 `step`이 필수다(저장소와 슬라이더가 같은 값이 되게). `Effect`에 UI 이름 `label`을 더했다. 이펙트 파라미터 값도 ParamStore에 있고, 이펙트의 `params`는 어떤 키를 쓰는지와 그 범위를 알려 준다.
5. **패딩은 렌더 단계에서**: PLAN 초안의 `Track.box`는 "스무딩·패딩 후"지만, 패딩은 렌더할 때 적용해 낮은 FPS에서도 패딩을 바꾸면 마지막 분석 프레임에 바로 반영되게 했다(`Track.box` 주석 수정).
6. **패스스루 트래커 + 빈 Trigger 훅**: 트래커(M5) 전이라 검출 하나를 트랙 하나로 넘긴다. `Pipeline.trigger`는 분석 프레임마다 트랙 목록을 받는 no-op이다.
7. **상대 블록 크기 = 패딩한 모자이크 영역 폭을 나눈 칸 수** (PLAN "얼굴 폭 대비". 리뷰 수정 뒤에는 프레임으로 자르기 전 패딩 영역 폭): 영역을 정확히 그 칸 수로 나눠 예측하기 쉽다. 얼굴 폭 기준이면 칸 수 × 패딩 배율이 된다.
8. **강도는 픽셀화에만**: 단색은 색 하나만 받는다(지시에 강도는 픽셀화 파라미터로 적혀 있음).
9. **검출기는 시작 전(페이지 로드 때) 불러온다**: 시작을 누를 때쯤 준비되도록. 정지해도 놓지 않는다.
10. **마지막 분석 프레임 다시 그리기**: 표시 파라미터 변경·캔버스 크기 변경 때 다시 그린다. P1 알려진 문제("캔버스 크기가 바뀌면 다음 프레임까지 빈 화면")도 함께 사라졌다. 다시 그리기는 `frameCount`·FPS에 세지 않는다.
11. **카메라 선택·미러를 Tweakpane 패널로** 옮기고 시작/정지 버튼은 헤더에 남겼다. Tweakpane 선택 상자의 옵션에는 장치 ID가 없어서 테스트는 `__am.snapshot().devices`로 ID를 읽고 이름으로 고른다. 패널이 장치 목록·전환 결과를 store에 반영할 때는 전환을 다시 걸지 않는다(`quietDevice`).
12. **`@tweakpane/core` 2.0.5 devDependency** (타입 전용, 정확히 고정): Tweakpane 4 타입 선언이 이 패키지를 참조한다. 없으면 `Pane`의 메서드가 `any`가 된다.
13. **외부 요청 차단(`local-only.ts`)과 WebGL2 사전 확인**: PLAN에 없지만 "확인한 것" 2, 4 때문에 필요했다.
14. **`FpsCounter` 간격 하한**: 검출기 교체 직후 첫 추론이 느리면 프레임 두 개가 몰려 와 추론 FPS 그래프가 30 넘게 튀었다. 간격을 창의 1/4(250ms)보다 짧게 보지 않는다. 시작 직후 15fps 다섯 프레임(266ms)은 그대로 15로 잰다.
15. **P1 테스트 적응** (동작이 바뀐 곳만): 원본 비디오와 픽셀 비교하는 QA 테스트(QA-3/QA-4 still·moving, 미러 41번)는 모자이크 강도 0(`unmasked`)으로 P1 렌더 경로를 본다. 움직이는 픽스처 QA는 동기 표시 지연을 줄이려고 목표 15fps. 20초 연속 실행 QA는 화면 FPS > 10을 보려고 목표 15fps(동기 표시라 화면 FPS = 추론 FPS, 기본 8). 콘솔 오류·경고 검사에서는 MediaPipe WASM 자체 로그(`isMediaPipeLog`: glog `I/W/E…`, `INFO: Created TensorFlow Lite XNNPACK delegate for CPU.`, 그래프 시작·종료)를 뺀다. `devices.spec`/`still.spec`의 카메라 선택은 이름으로 고르고 ID는 훅에서 읽는다.

### 알려진 문제·한계

- **추론이 메인 스레드에서 돈다** (P3에서 Worker로): `detectForVideo`는 동기라 그동안 메인 스레드가 멈춘다. 평소 3–5ms지만 검출기를 새로 만든 뒤 첫 GPU 추론은 ≈ 100ms(full-range ≈ 1.6초) 걸린다. 그동안 들어온 프레임은 버린 프레임으로 센다.
- **검출이 빠진 프레임은 가려지지 않는다**: hold·트래킹(M5) 전이다. 정지 픽스처에서는 빠진 프레임이 없었다.
- 모자이크는 영역을 감싸는 사각형에만 적용한다(타원 등은 M5). 축소는 캔버스 `'high'` 스무딩이라 정확한 평균(box filter)은 아니다.
- GPU에서 CPU로 대체되면 실행 장치 파라미터를 다시 바꿀 때까지 CPU로 남는다.
- 외부 요청 차단은 메인 스레드 `fetch`만 감싼다. P3에서 Worker로 옮기면 Worker 안에서도 같은 차단을 걸어야 한다.
- MediaPipe가 콘솔에 자체 로그를 남긴다(CPU 실행 장치에서는 `INFO: Created TensorFlow Lite XNNPACK delegate for CPU.`가 `console.error`로). 앱 오류가 아니다. 모델 파일이 없을 때 등의 검출기 오류 문구는 한국어 앞부분 뒤에 MediaPipe 영어 메시지가 붙는다.
- 카메라는 목표 FPS와 상관없이 비디오 프레임마다 `ImageBitmap`을 만든다(차례가 아닌 프레임은 바로 닫는다).
- full-range가 먼 얼굴에서 실제로 나은지는 먼 얼굴 픽스처가 없어 확인하지 못했다(PLAN §6 비교 실험은 M6 측정 때).
- 실제 웹캠, 실제 GPU 실패 환경은 자동 테스트하지 못했다(GPU 실패는 WebGL 확장을 숨겨 흉내 냄).

### 실행한 명령과 결과

| 명령 | 결과 |
|---|---|
| 검증 스크립트 (헤드리스 Chrome, `portrait.jpg`) | short/full × GPU/CPU 모두 얼굴 1개 (점수 0.91/0.92/0.78/0.85). 외부 요청 4건(`odml.pa.googleapis.com/v1/log`) 발견 → 차단 추가 |
| `npm install --save-dev --save-exact @tweakpane/core@2.0.5` | 추가 |
| `npm run typecheck` | 통과 |
| `npm test` | 11 파일, 102 테스트 통과 |
| `npm run build` | 통과 (앱 JS 179KB(Tweakpane 포함), MediaPipe 번들 154KB 별도 청크, CSS 2.4KB) |
| `npm run e2e` | 55 테스트 통과 (약 2.8분, 70초 방치 테스트 포함). 키보드 포커스 탐색 테스트는 P1부터 `test.fail()`(예상된 실패)로 표시돼 있다 |

E2E 측정값 (헤드리스 Chrome 156, 가짜 카메라 640×480 15fps, 기본 파라미터):

- 정지 1인: 검출 1개, 점수 0.88, 박스 `{x:215, y:119, w:224, h:224}`, 모자이크 영역(패딩 1.3) `{x:181, y:85, w:292, h:292}`. 추론 해상도 320/480/원본에서 박스 IoU > 0.8.
- 2인: 6번 표본 모두 2개 (점수 0.94, 0.94). 얼굴 없음: 분석 프레임 33개 모두 0개 (잘못된 검출 0).
- 모자이크: 영역 안 가로 이웃 픽셀이 같은 비율 0.978(강도 0이면 0.558), 같은 색 구간 평균 41px(강도 0이면 2.3px). 영역 밖은 모자이크 없는 화면과 차이 0 (11만 표본). 단색: 영역 밝기 표준편차 0, 색 (255, 0, 255).
- 블록 크기: 같은 색 구간 평균 절대 8px → 11.8, 32px → 45.1, 상대 24칸 → 18.0, 6칸 → 67.7, 4칸(UI 입력) → 101.5.
- 패딩 1.0 / 1.5 / 2.0: 영역 폭 224 / 336 / 448, 단색 면적 99,856 / 224,676 / 400,689 px.
- 신뢰도 0.99(UI 입력) → 검출 0개·영역 0개, 0.5 → 다시 1개. 새로고침 없음.
- 모델 short → full, 실행 장치 GPU → CPU 전환 중 rAF 표본(약 70–90개, 그중 불러오는 중 50–75개)에서 모두 `drawnFrameId === detectionFrameId`, 얼굴 영역 평평함 ≥ 0.978, 불러오는 동안 `frameCount` 변화 없음.
- 검출기를 2.5초 늦게 불러오면 카메라가 켜져 있어도 캔버스는 빈 화면(밝은 픽셀 0), 첫 그림부터 모자이크. 모델 404 → 오류 문구, 빈 화면, 실행 장치를 바꾸면 다시 시도해 정상.
- 외부 요청: 모델·실행 장치 4번 전환 중 요청 19건 모두 localhost(`/wasm/vision_wasm_internal.{js,wasm}`, `/models/blaze_face_{short,full}_range.tflite` 포함), 막은 지표 전송 4건. 70초 방치: 요청 7건 모두 localhost, 막은 지표 전송 1건.

### 리뷰 수정

리뷰에서 확인된 문제를 고쳤다.

- **가장자리에 걸린 얼굴의 패딩이 줄던 문제** (P2-architecture-2 major, P2-correctness-1, P2-privacy-perf-2): `mapToSource`가 박스를 프레임 안으로 자른 뒤 렌더 단계가 그 잘린 박스를 패딩해서, 보이는 쪽 여백이 실제 얼굴 크기가 아니라 보이는 부분 기준으로 줄었다. 이제 `mapToSource`는 좌표만 되돌리고 자르지 않는다(크기 0·NaN 박스만 버린다). 트랙과 `__am.detections`도 자르지 않은 박스다. `render()`가 `clampRect(snapOut(padRect(박스)))`로 패딩한 뒤에 자르고, 패딩한 영역이 프레임에 전혀 걸치지 않을 때만 건너뛴다(박스가 밖이어도 패딩이 프레임에 걸치면 가린다). 검증 메모대로 MediaPipe는 왼쪽·위쪽에서는 origin을 0으로 자르고 크기를 유지해서 영향이 없고, 오른쪽·아래쪽에서 박스가 프레임 밖으로 나갈 때 이 문제가 생겼다.
- **상대 블록 크기가 잘린 영역 폭을 따르던 문제** (P2-privacy-perf-1): `Region`에 선택 필드 `unclipped`(프레임으로 자르기 전 패딩 영역)를 두었다. 픽셀화는 상대 모드 블록 크기를 `unclipped.width / blockCells`로 정하고(`pixelGrid(r, p, refWidth)`), 그리는 영역은 잘린 `rect` 그대로다. 제안처럼 파이프라인에서 상대 모드를 절대 블록 크기로 바꾸지 않은 것은 코어가 픽셀화 파라미터를 몰라야 하기 때문이다(아래 P2-architecture-1).
- **이펙트를 더하려면 코어를 고쳐야 하던 문제** (P2-architecture-1): `ParamSpec`에 `default`를 다시 넣었다(타입별로 필수). `Params`/`DEFAULT_PARAMS`는 코어 파라미터 11개만 두고, 이펙트 파라미터(`blockMode blockSize blockCells strength solidColor`)의 키·범위·기본값은 각 이펙트의 `params`에만 있다. `ParamStore`는 받은 스키마(코어 + 등록된 이펙트)에서 키와 기본값을 모으고 그 밖의 키는 거부한다. `Pipeline`의 다시 그리기 키는 코어 표시 키(`mirror effect padding debug`)와 등록된 이펙트의 파라미터 키다. 그래서 새 이펙트는 `main.ts`에서 등록만 하면 패널, `__am.get/set`, 다시 그리기가 모두 동작한다(단위 테스트에서 가짜 `blur` 이펙트로 확인). `blockMode` 유니온은 `PixelateParams`에만 남았다. 타입: `ParamValues = Params & Record<string, ParamValue>`, `ParamStore.get`은 코어 키면 정확한 타입, 아니면 `ParamValue | undefined`. `__am.get/set`은 문자열 키를 받는다(모르는 키의 `get`은 `undefined`).
- **동기 표시 검사가 실패할 수 없던 문제** (P2-correctness-3, P2-architecture-5): `drawnFrameId`는 이제 렌더러가 기록한다(`DrawOptions.frameId` → `renderer.frameId`, 지우면 `null`). 다른 경로로 프레임을 그리면 `detectionFrameId`와 어긋난다. 그리고 `tests/e2e/sync-moving.spec.ts`를 더했다. 움직이는 1인 픽스처로 목표 8fps·15fps에서 rAF마다 새로 그려진 프레임을 분석해 (1) 모자이크 영역 평평함 > 0.9, (2) 그려진 픽셀에서 잰 머리 사진의 가로 중심과 모자이크 영역 중심의 차이 < 12px를 본다. 머리 사진 가장자리는 회색(0x70) 배경과 다른 열로 찾고, 한쪽이 프레임 밖이면 다른 쪽 가장자리 ± 120px로 잰다. 정상일 때 차이는 −3…+5px, 왕복 한 주기(4.2초) 동안 그려진 프레임 34개(8fps)·61–64개(15fps) 모두 검출 1개였다.
- **목표 1fps에서 FPS가 0으로 읽히던 문제** (P2-architecture-4): `FpsCounter.setTargetFps(fps)`가 측정 창을 `max(1000, 2500 / fps)` ms로 늘린다. 파이프라인이 목표 FPS가 바뀔 때마다 추론·렌더 FPS 둘 다에 건다. E2E에서 1fps로 바꾸고 3초 동안 250ms마다 읽은 추론 FPS는 0.98–1.01이었고, 렌더 FPS와 헤더 표시도 한 번도 0이 아니었다.
- **신뢰도·NMS 슬라이더를 끌 때마다 그래프를 다시 만들던 문제** (P2-privacy-perf-4): 두 가지를 했다. (1) `applyDetectorOptions`는 줄에 하나만 세우고(`optionsQueued`) 실행할 때 최신 값을 읽는다. 줄이 바쁜 동안(추론, 불러오기) 여러 번 바꿔도 `updateOptions`는 한 번이다. (2) `ParamSpec.applyOnRelease`(`minConfidence`, `nmsThreshold`에 켬)면 패널이 Tweakpane `change`의 `ev.last`일 때만 store에 넣는다. (1)만으로는 부족했다: `setOptions`가 메인 스레드를 막는 동안 쌓인 포인터 이벤트가 그 뒤 하나씩 오므로 매번 줄이 비어 있다. 숫자 입력(Enter)과 키보드 조작은 `last`가 바로 와서 그대로 반영된다. `__am.set`은 패널을 거치지 않으므로 바로 반영된다.
- **nit**
  - P2-correctness-5: `ParamStore`는 `Object.hasOwn`으로 키를 확인한다. `__proto__`, `toString`, `constructor`는 모르는 키로 거부한다.
  - P2-architecture-7: `core/types.ts`에 `Renderer`, `DrawOptions`를 두었다. `Pipeline`은 이 인터페이스만 알고(단위 테스트의 캐스트가 사라졌다) `Canvas2DRenderer`가 구현한다. `FpsCounter`는 `src/core/fps-counter.ts`로 옮겨 core가 ui를 import 하지 않는다.
  - P2-architecture-8 (일부): 쓰지 않던 `ParamStore.spec()`, 테스트에서만 쓰던 `Registry.has()`를 지웠다. `passThroughTracks`는 `src/tracking/pass-through.ts`로 옮겼다(M5에서 이 파일을 바꾼다). `errorText` 공유는 하지 않았다. 세 줄짜리라 공유 모듈을 새로 두는 이득이 작다.
  - P2-architecture-9: README의 `strength`는 픽셀화 전용(단색은 무시)이라고 적었다. 위 "만든 것"의 GPU 대체 설명을 "GPU 추론이 실패하면(언제든)"으로 고쳤다. 번들 크기는 빌드 청크 기준 154KB로 맞췄다(어댑터 주석). 패키지 파일 `vision_bundle.mjs`는 156KB이고 PLAN §1.2의 값은 이것이다.
- **리뷰 밖 테스트 수정**: `moving.spec.ts`(P1)가 한 번 실패했다. 썸네일을 찍은 뒤 `frameCount`를 읽어서, 그 사이 새 프레임이 그려지면 첫 비교가 그 프레임으로 바로 통과하고 `frameCount`는 아직 그대로였다. `frameCount`를 먼저 읽게 순서만 바꿨다.
- **리뷰 밖 보강 (fail-closed)**: `Canvas2DRenderer.draw()`는 paint(이펙트·오버레이)가 던지면 캔버스를 비우고 다시 던진다. 원본 프레임을 그린 뒤 이펙트가 실패하면 오류 상태 동안 가리지 않은 프레임이 화면에 남을 수 있었다.

파일 지도 (리뷰 수정에서 새로 만들거나 옮긴 것):

```
src/core/fps-counter.ts           FpsCounter (+ setTargetFps). ui/stats.ts에서 옮김
src/tracking/pass-through.ts      passThroughTracks. core/detections.ts에서 옮김
src/core/types.ts                 ParamValue, ParamSpec.default·applyOnRelease, Region.unclipped, Renderer, DrawOptions
tests/e2e/sync-moving.spec.ts     움직이는 얼굴: 그려진 프레임마다 모자이크가 그 프레임의 얼굴 위에 있다 (8fps, 15fps)
```

**테스트가 버그를 잡는지 확인**: 고친 동작을 하나씩 되돌려 보았다. 확인 뒤 원래 코드로 복원했다.

- `mapToSource`에 클램프를 되돌리면 단위 테스트 3개(자르지 않음, 가장자리 패딩, 패딩이 걸치는 박스)가 실패한다.
- 옵션 합치기(`optionsQueued`)를 빼면 합치기 단위 테스트가 실패한다.
- 프레임 N을 프레임 N−1의 검출 결과로 그리게 하면 `sync-moving` 8fps(중심 차이 최대 55px)와 15fps(29px)가 실패한다.
- `camera.onFrame`에서 원본 프레임을 렌더러로 바로 그리게 하면 `sync-moving`(평평함 0.52), detect.spec의 동기 표시(id 불일치), 첫 프레임 모자이크 테스트가 실패한다.
- 패널의 `applyOnRelease` 확인을 빼면 슬라이더 테스트가 실패한다(드래그 중 store 값 0.89).

**새 테스트**: Vitest 12개. pipeline 6개(가장자리 패딩, 패딩이 걸치는 박스·안 걸치는 박스, 새 이펙트 파라미터 전달·다시 그리기, 옵션 합치기, FPS 창, 렌더러가 기록한 drawnFrameId), params 3개(상속 키 거부, 새 이펙트 파라미터, applyOnRelease), effects 2개(잘린 영역의 블록 크기, 기본값), FpsCounter 1개(1fps). detections의 자르기 테스트는 "자르지 않음"으로 바꿨다. E2E 4개: `sync-moving.spec.ts` 2개, mosaic.spec 슬라이더(신뢰도는 놓을 때, 패딩은 드래그 중에 반영), detect.spec 1fps 모니터.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm test` | 11 파일, 114 테스트 통과 |
| `npm run build` | 통과 (앱 JS 179.8KB, MediaPipe 청크 154.4KB, CSS 2.4KB) |
| `npm run e2e` | 59 테스트 통과 (약 2.8분). 키보드 포커스 탐색 테스트는 P1부터 `test.fail()`(예상된 실패) |
| `npx playwright test moving.spec sync-moving --repeat-each=5` | 25/25 통과 (qa-p1-moving 포함) |
| `npx playwright test mosaic.spec detect.spec -g "슬라이더\|1fps" --repeat-each=4` | 8/8 통과 |


## P3 Worker + 표시 모드 (M4 + fail-closed) — 2026-10-31

### 만든 것

- **검출 Worker** (`src/detectors/worker/detector.worker.ts`): `new Worker(new URL(...), { type: 'module' })`로 띄우는 module Worker. Worker에서 돌 수 있는 검출기 종류를 `HostedSpec`(`{ kind: 'mediapipe-face', model }`)으로 받아 만든다(`createHosted`). 요청(`init`/`update`/`detect`)은 받은 순서대로 한 줄로 처리하고, 응답마다 실제 실행 장치·대체 이유를 함께 보낸다. MediaPipe는 Worker 안에서 `FilesetResolver.forVisionTasks('/wasm', true)`(ES 모듈 WASM)로 불러오고, GPU delegate는 OffscreenCanvas(WebGL2)를 쓴다. GPU를 만들거나 돌리지 못하면 P2와 같은 어댑터 코드가 Worker 안에서 CPU로 대체한다. Worker 안에서도 `installLocalOnlyFetch`로 외부 요청을 막고, 막은 URL은 메인으로 알린다(`{ type: 'blocked' }`).
- **`DetectorProxy`** (`src/detectors/worker/proxy.ts`): 같은 `Detector` 인터페이스를 postMessage RPC로 구현한다. 요청마다 id를 붙여 응답과 짝을 맞추고(순서가 바뀌어도 됨), `detect`의 ImageBitmap은 transfer 목록으로 넘긴다(복사 없음). Worker 안의 오류는 그 요청의 거부로, Worker의 잡히지 않은 오류(`error`/`messageerror` 이벤트)는 기다리던 요청을 모두 거부하고 Worker를 끝낸 뒤 `onError`로 알린다. `dispose()`는 Worker를 `terminate()` 하고 기다리던 요청을 거부하며, 그 뒤 오는 응답은 무시한다. 닫은 뒤의 `detect`는 보내지 않고 넘겨받은 프레임을 닫는다. 모듈 수준 `workerStats { created, live }`로 Worker 수를 센다. 시험용 `crashDetectorWorkers()`는 살아 있는 Worker에 `crash`를 보내 Worker 안에서 `setTimeout`으로 던지게 한다.
- **실행 위치 파라미터** `location: 'worker'(기본) | 'main'` (패널 "실행 위치"): `DetectorEntry.create(location)`로 팩토리가 구현을 고른다(`main.ts`의 `faceDetector()`: Worker면 `DetectorProxy`, 아니면 `MediaPipeFaceDetector`). 파이프라인은 위치 값을 팩토리에 넘기기만 하고 Worker인지 모른다. 모델·실행 위치가 바뀌면(`model@location` 키) 이전 검출기를 **바로**(작업 줄 밖에서) 닫는다. 진행 중인 요청도 거부되므로 멈춘 Worker를 기다리지 않고, 초기화가 멈춘 검출기도 다시 바꾸면 닫는다. 실행 장치·신뢰도는 같은 검출기의 `updateOptions`.
- **백프레셔**: 추론 중인 요청은 1개, 차례가 온 프레임을 버리면 `droppedFrames`를 센다(P2 그대로).
- **표시 모드** `displayMode: 'sync'(기본) | 'async'` (패널 "표시"): 동기는 P2와 같다(분석이 끝난 프레임만 그 결과와 함께). 비동기는 카메라 프레임마다 바로 그리고 박스는 최신 검출 결과(패딩 적용)를 쓴다. 검출은 같은 목표 FPS·백프레셔로 따로 돈다. 동기로 바꾸면 비동기로 그린(분석하지 않은) 프레임은 지우고 다음 분석 프레임부터 그린다.
- **fail-closed** (`src/core/fail-closed.ts`, `src/effects/cover.ts`): `failReason()`이 `loading`(불러오는 중) · `error` · `waiting`(시작·검출기 준비 뒤 첫 결과 대기) · `stalled`(마지막 결과가 제한 시간보다 오래됨)를 낸다. 제한 시간은 `max(1000ms, 2000 / 목표 FPS)`(1fps면 2초). 비동기 표시는 이유가 있거나 결과가 다른 크기의 프레임에서 나왔으면 **프레임 전체를 굵게 픽셀화**(가로 12칸, 고른 이펙트·강도와 무관하게 강도 1)해서 그린다. 검출기 상태가 바뀌면 다음 카메라 프레임을 기다리지 않고 지금 프레임을 다시 판단해 그린다. 동기 표시는 원래 분석한 프레임만 그리므로 그대로 두고 안내만 띄운다. 화면 위 안내(`src/ui/status-text.ts`)는 모드·이유별 한국어 문구다(비동기: "… — 화면 전체를 가립니다.", 동기: "검출이 늦어져 화면을 갱신하지 않습니다 — 마지막으로 분석한 프레임을 보여 줍니다." 등).
- **검출기 입력 소유권**: `Detector.detect(frame)`는 frame의 소유권을 넘겨받는다(검출기가 닫거나 transfer). 파이프라인은 항상 `createImageBitmap(frame, resize)`로 따로 만든 입력을 넘겨, transfer 되어도 화면용 프레임이 남는다. `Detector.onError`(선택)를 더해 요청 밖의 복구할 수 없는 오류도 파이프라인이 오류 상태로 바꾼다(이미 바꾼 검출기의 오류는 무시).
- **모니터·통계**: 패널 모니터에 렌더 FPS(값·그래프), 실행 위치, 롱태스크(>50ms) 수, Worker 수를 더했다(추론 FPS·추론 시간·검출 수·실행 장치·버린 프레임은 P2부터). 검출기 상태 줄에 실행 위치를 함께 보인다(`얼굴 검출기 준비됨 · BlazeFace 근거리 (short-range) · Worker · GPU`). 롱태스크는 `PerformanceObserver({ type: 'longtask', buffered: true })`로 센다(`src/ui/long-tasks.ts`).
- **테스트 훅 `window.__am`**: 스냅숏에 `location displayMode failReason failClosed fullCover workers longTasks`를 더했고 `detectionFrameId`는 "화면에 그린 박스를 낸 검출 프레임"으로 바꿨다(동기면 그린 프레임과 같고, 전체를 가렸으면 null). `renders(sinceSeq?)`는 그린 프레임마다 `{ seq, frameId, detectionFrameId, mode, fullCover }`를 남긴 기록(최근 600개. `fullCover`는 리뷰 수정 전 이름이 `failClosed`였다). `fault(kind, ms?)`: `delay`(검출마다 늦춤) · `error`(검출 실패) · `crash`(Worker 안의 잡히지 않은 오류) · `none`(고장을 없애고 오류 상태면 다시 불러옴). README에 표로 정리했다.
- **빌드 설정** (`vite.config.ts`): `worker.format: 'es'`(Worker가 MediaPipe를 동적 import 하므로 코드 분할이 되는 형식). dev 전용 플러그인 `serve-public-wasm`(아래 "확인한 것" 2).

### 파일 지도 (P3에서 새로 만들거나 크게 바꾼 것)

```
src/detectors/worker/detector.worker.ts  검출 Worker (HostedSpec으로 검출기 생성, 요청 직렬 처리, Worker 안 외부 요청 차단)
src/detectors/worker/proxy.ts            DetectorProxy (RPC, transfer, 오류 전달, dispose), workerStats, crashDetectorWorkers
src/detectors/worker/protocol.ts         메인 ↔ Worker 메시지 타입, HostedSpec
src/detectors/mediapipe-face.ts          Worker에서는 ES 모듈 WASM + ModuleFactory 다시 넣기, 입력 소유권, 닫는 중 만든 태스크 정리
src/core/pipeline.ts                     비동기 표시, fail-closed 덮개, renders 기록, 시험용 고장, 검출기 즉시 교체, onError
src/core/fail-closed.ts                  FailReason, failReason, staleLimitMs
src/core/types.ts                        ExecutionLocation, DisplayMode, Detector.onError, detect 소유권 주석
src/core/params.ts                       location, displayMode
src/core/registry.ts                     DetectorEntry.create(location)
src/core/local-only.ts                   scope·콜백을 받게 (Worker용), noteBlocked
src/effects/cover.ts                     coverFrame (fail-closed 전체 픽셀화)
src/ui/status-text.ts                    stageNoteText (화면 위 안내, main.ts에서 옮김)
src/ui/long-tasks.ts                     LongTaskMonitor
src/ui/panel.ts                          실행 위치·표시 모드, 렌더 FPS·실행 위치·롱태스크·Worker 수 모니터
src/main.ts  src/test-hook.ts            팩토리, 스냅숏·renders·fault
vite.config.ts                           worker.format es, serve-public-wasm (dev)
tests/unit/proxy.test.ts                 가짜 Worker로 RPC·transfer·오류·dispose·늦은 응답·Worker 수
tests/unit/fail-closed.test.ts           failReason, staleLimitMs, stageNoteText
tests/unit/pipeline.test.ts              비동기·fail-closed·고장·onError·실행 위치 교체(멈춘 요청·멈춘 초기화)·renders 기록 13개 추가
tests/e2e/worker.spec.ts                 기본 Worker·transfer·P2와 같은 결과, 롱태스크 10초(Worker/메인), 실행 위치·장치 3번 전환과 Worker 수, 빠른 전환 10번, Worker 오류 전달·회복
tests/e2e/display.spec.ts                동기 drawn = detection, 비동기 렌더 FPS > 추론 FPS·얼굴 계속 가림·패딩, 동기로 돌아오기
tests/e2e/fail-closed.spec.ts            비동기 지연·실패·Worker 오류·다시 불러오기, 동기 지연·Worker 오류 (원본 안 보임, 안내, 회복)
tests/e2e/switching.spec.ts              GPU 실패·WebGL 없음을 Worker와 메인 양쪽에서 (patchWorkers)
tests/e2e/helpers.ts                     patchWorkers (Worker 안에 고장 심기)
```

### 확인한 것

1. **MediaPipe 1.2.0은 module Worker에서 두 번째 태스크를 만들 때 "ModuleFactory not set."으로 실패한다.** 태스크를 만들 때마다 WASM 로더를 다시 실행해(`importScripts`가 module Worker에서 TypeError → `import(url)`) `self.ModuleFactory`를 얻고, 쓴 뒤 `self.ModuleFactory = undefined`로 지운다. 메인 스레드의 클래식 `<script>`는 다시 실행되지만 ES 모듈은 두 번째 `import()`가 캐시라 다시 실행되지 않는다. 그래서 같은 Worker에서 실행 장치를 바꾸거나(태스크 다시 만들기) GPU 생성 실패 뒤 CPU로 대체할 때 실패했다. 어댑터가 Worker에서는 로더 모듈을 직접 import 해 기본 export를 들고 있다가, 태스크를 만들 때마다 `globalThis.ModuleFactory`에 다시 넣는다.
2. **Vite dev 서버는 Worker 안 MediaPipe의 `import('/wasm/vision_wasm_module_internal.js')`를 거부한다.** 사전 번들된 의존성의 동적 import에도 `?import`를 붙이고, public 파일을 import 하면 "should not be imported from source code" 500을 낸다. `@vite-ignore`로도 쿼리는 붙는다. `vite.config.ts`의 dev 전용 미들웨어가 `/wasm/` 요청의 쿼리를 떼어 public 미들웨어가 그대로 내보내게 했다. `vite build` 결과에는 쿼리가 붙지 않는다. dev(5317)에서 Worker·GPU·검출이 동작하는 것을 헤드리스로 확인했다.
3. 헤드리스 Chrome 156에서 Worker 안의 GPU delegate(OffscreenCanvas WebGL2)가 동작한다. 640×480, short-range, 목표 8fps 정상 상태: `inferenceMs`(Worker는 메시지 왕복 포함) Worker ≈ 4.7–4.9ms, 메인 ≈ 4.1–4.4ms. 검출 결과는 P2와 같다(정지 1인 박스 `{215, 119, 224, 224}`, 점수 0.877).
4. Playwright의 `page.route`와 `context.on('request')`는 dedicated Worker의 요청도 잡는다(Worker 안 모델 요청 지연·404, 외부 요청 기록이 그대로 동작). `addInitScript`는 Worker에 걸리지 않는다. 그래서 Worker 안의 고장은 `page.on('worker')` + `worker.evaluate`로 심는다(`patchWorkers`). Worker가 MediaPipe를 다 불러오기 전에 심어지도록 테스트에서 WASM 로더 응답을 700ms 늦춘다. 같은 이유로 어댑터의 WebGL2 확인을 MediaPipe 번들을 불러온 뒤로 옮겼다(동작 차이 없음).
5. `--disable-3d-apis`·`--disable-webgl`은 `HTMLCanvasElement`의 WebGL만 끄고 `OffscreenCanvas`(메인·Worker)의 WebGL2는 그대로라 "WebGL 없음" 흉내에 쓸 수 없다.
6. Worker를 `terminate()`로 닫으면 MediaPipe의 `close()`가 불리지 않아 닫을 때의 지표 전송 시도도 없다. Worker 안에서 실행 장치를 바꿀 때(태스크 `close()`)와 60초 주기 전송은 Worker 안에서 막히고 메인에 기록된다(로컬 전용 E2E: Worker 단계에서 2건, 전체 4건, 외부 요청 0).
7. 메인 스레드 롱태스크(헤드리스, 정지 1인, 목표 8fps, 10초 정상 상태): **Worker 0개, 메인 스레드 0개**(추론이 4ms 남짓이라). 측정 중 잡힌 롱태스크는 메인 스레드로 바꿀 때 메인에서 검출기를 만들고 첫 GPU 추론을 하는 77–80ms 하나와 페이지 로드 때 50–58ms 하나뿐이다. 즉 이 환경에서는 Worker의 이득이 정상 상태가 아니라 검출기 생성·첫 추론(P2에서 full-range GPU 첫 추론 ≈ 1.6초)과 무거운 모델·느린 기기에서 드러난다.

### PLAN과 다른 점 (이유)

1. **`Detector.detect()`가 입력의 소유권을 가져간다.** transfer 하면 메인의 비트맵이 떼어지므로, 파이프라인은 항상 따로 만든 입력(추론 해상도 복사본)을 넘긴다. 추론 해상도가 원본과 같을 때(640×480 + 640) P2는 원본을 그대로 넘겼지만 이제 같은 크기 복사본을 하나 만든다(createImageBitmap 1회).
2. **Worker 쪽 검출기 표는 `HostedSpec`으로 따로 둔다.** 레지스트리 항목(팩토리 함수)은 Worker로 넘길 수 없어서 `DetectorEntry.create(location)`가 `DetectorProxy(id, labels, { kind, model })`를 만들고 Worker가 `kind`로 같은 어댑터를 만든다. 새 Worker 지원 검출기는 `HostedSpec` 유니온과 `createHosted`에 한 줄씩 더한다.
3. **`Detector.onError`(선택), `dispose()`는 진행 중인 요청도 끊는다**는 계약을 더했다. Worker가 요청 밖에서 죽어도 조용히 묻히지 않게, 멈춘 Worker 때문에 전환이 막히지 않게 하기 위해서다.
4. **fail-closed 제한 시간 = max(1초, 목표 간격 2개)**: 지시의 "예: 1초"를 쓰되, 목표 1fps에서는 정상이어도 간격이 1초라 계속 가려지므로 2초로 늘린다. 덮개는 픽셀화(12칸) 고정이다.
5. **동기 표시의 fail-closed는 덮개를 그리지 않는다.** 동기 표시에는 분석한 프레임만 나오고 그 프레임은 이미 자기 검출 결과로 가려져 있어서, 멈춘 화면(또는 빈 화면)과 안내로 충분하다고 봤다.
6. **동기로 바꾸면 화면이 다음 분석 프레임까지(최대 한 추론 간격) 비어 보인다.** 비동기로 그린 프레임을 남기면 그린 프레임 ≠ 검출 프레임이 되어서 지운다.
7. **시험용 고장은 파이프라인에 둔다**(`Pipeline.fault`, 검출 직전에 지연·실패). 실행 위치와 상관없이 같은 경로로 걸리게 하기 위해서다. Worker 자체의 오류는 `crash`(Worker 안에서 던짐)와 Playwright `worker.evaluate`로 따로 확인한다. `fault('none')`은 오류 상태면 검출기를 다시 불러온다(테스트 편의. UI에서는 P2처럼 모델·실행 장치·실행 위치를 바꾸면 다시 시도한다).
8. **그린 프레임마다의 기록은 스냅숏 필드가 아니라 `renders()` 링 버퍼**로 둔다. rAF 표본은 프레임을 놓칠 수 있어서 "모든 그린 프레임"을 확인하려면 기록이 필요했다.
9. **`inferenceMs`는 Worker면 메시지 왕복 시간**이다(Worker 안 순수 추론 시간은 따로 보내지 않는다).
10. **헤더 통계는 그대로**(`렌더 … FPS · 영상 …`), 렌더 FPS 그래프는 패널 모니터에 더했다.
11. **P2 테스트 적응** (동작이 바뀐 곳만): QA 계측(`qa-p2-helpers.ts`)은 Worker로 transfer 한 비트맵도 "분석한 프레임"으로 센다(Worker 안 WebGL 업로드는 메인에서 보이지 않음). ImageBitmap 누수 탐색 테스트는 transfer 한 비트맵을 닫은 것으로 센다. `qa-p2-fallback.spec.ts`(init script로 GPU 실패 흉내)는 실행 위치를 메인으로 두고 본다(Worker 쪽은 `switching.spec.ts`). `local-only.spec.ts`는 Worker(ES 모듈 WASM)와 메인(클래식 WASM)을 모두 거친다. detect·detect-two·detect-none에 "기본 실행 위치 Worker" 확인을 더했다.

### 알려진 문제·한계

- **비동기 표시는 빠른 움직임에서 얼굴이 샐 수 있다**(설계상, 비교 실험용). fail-closed는 결과가 1초보다 오래될 때만 전체를 가린다. 회복 직후에는 1초가 안 된 고장 전 박스를 쓰다가, 새 결과가 오기 전에 1초가 지나면 잠깐 다시 전체를 가릴 수 있다.
- 롱태스크 기준은 이 환경에서 Worker와 메인을 구별하지 못한다(둘 다 정상 상태 0개, 위 "확인한 것" 7).
- Worker마다 WASM 인스턴스를 새로 만든다. 실행 위치를 Worker로 바꾸거나 모델을 바꾸면 Worker를 새로 띄워 WASM 컴파일·모델 읽기를 다시 한다(헤드리스에서 준비까지 ≈ 0.3–0.8초).
- ModuleFactory 다시 넣기(확인한 것 1)는 tasks-vision 1.2.0 내부 동작에 기대는 우회다. 버전을 올리면 다시 확인해야 한다.
- Worker 안의 비트맵 누수는 직접 재지 않았다(어댑터가 `detect`의 `finally`에서 닫는다). 메인 쪽은 QA 탐색 테스트로 확인한다.
- `crash` 고장은 Worker 실행일 때만 된다(메인이면 `false`).
- Worker 안의 GPU 실패·WebGL 없음은 `worker.evaluate`로 WebGL 확장·컨텍스트를 숨겨 흉내 냈다. 실제 GPU 실패 기기, 실제 웹캠은 자동 테스트하지 못했다.

### 실행한 명령과 결과

| 명령 | 결과 |
|---|---|
| `git add -A` | 시작할 때 1회 (P2까지의 상태를 인덱스에 체크포인트) |
| 검증 스크립트 (헤드리스, preview 5318) | Worker·GPU·검출 동작 확인. 같은 Worker에서 실행 장치 변경 시 "ModuleFactory not set." 발견 → 수정 후 모델·실행 장치·실행 위치 7번 전환 모두 ready |
| 검증 스크립트 (dev 5317) | `?import` 500 발견 → `serve-public-wasm` 추가 후 Worker·GPU·검출 동작 |
| `npm run typecheck` | 통과 |
| `npm test` | 13 파일, 145 테스트 통과 |
| `npm run build` | 통과 (앱 JS 188.1KB, Worker 4.3KB, MediaPipe 청크 154.4KB(메인)·154.7KB(Worker) 각각, CSS 2.4KB) |
| `npm run e2e` | 98 테스트 통과 (약 5.4분). 키보드 포커스 탐색 테스트는 P1부터 `test.fail()`(예상된 실패) |
| `npx playwright test worker.spec display.spec fail-closed.spec switching.spec --repeat-each=3` | 51/51 통과 (2.6분) |

E2E 측정값 (헤드리스 Chrome 156, 가짜 카메라 640×480 15fps, 기본 파라미터):

- 기본 실행 위치 Worker, GPU. 보낸 프레임 8개 모두 transfer 목록에 있고 보낸 뒤 메인에서 떼어짐(width 0). 2인·얼굴 없음도 Worker에서 P2와 같다(2개 / 0개).
- 동기: 3초 동안 그린 프레임 24개 모두 `frameId === detectionFrameId`, rAF 표본 174개 모두 drawn = detection, 얼굴 영역 평평함 ≥ 0.978, 렌더 FPS = 추론 FPS(7.67).
- 비동기: 렌더 15.0 FPS, 추론 8.1 FPS. 3초 동안 그린 프레임 45개에 검출 프레임 25개, 전부 앞선 검출 프레임의 박스로 그림, 가린 프레임 0, 얼굴 영역 평평함 ≥ 0.978, 영역 폭 292 = 검출 폭 224 × 1.3.
- fail-closed (비동기): `fault('delay', 4000)` 뒤 약 0.89초부터 전체를 가림(마지막 성공 프레임 시각 + 1초). 가린 동안 프레임 전체 평평함 ≥ 0.988(평소 0.75), 얼굴 영역은 지연 전·중·후 내내 ≥ 0.978, 안내 "검출 결과가 늦어 화면 전체를 가립니다.", 영역 = 프레임 전체. `error`·`crash`: 첫 표본부터 전체를 가림, "검출기 오류 — 화면 전체를 가립니다.", Worker 수 0. 실행 위치 전환으로 다시 불러오는 동안: "얼굴 검출기를 불러오는 중 — 화면 전체를 가립니다." 모두 `fault('none')` 뒤 회복.
- fail-closed (동기): 지연 2초 동안 frameCount 변화 ≤ 1, 마지막 분석 프레임(모자이크) 유지, 1.3초 뒤 "검출이 늦어져 화면을 갱신하지 않습니다 — …". Worker 오류: "검출기 오류로 화면을 갱신하지 않습니다.", 화면 고정, 회복.
- 전환: 실행 위치 Worker ↔ 메인과 실행 장치 GPU ↔ CPU를 3바퀴(12단계) 모두 검출 1개·오류·앱 경고 없음. 만든 Worker 4개(처음 1 + 돌아갈 때마다 1), 끝난 Worker 3개, 살아 있는 Worker는 Worker 실행 중 1·메인 실행 중 0(Playwright `page.workers()`와 일치). 전환 중 그린 프레임 31개 모두 동기 일치. 기다리지 않고 10번 전환해도 살아 있는 Worker 0(메인) → 1(Worker).
- Worker 오류 전달: `fault('crash')` → "얼굴 검출기 오류: 검출 Worker 오류: Uncaught Error: 시험용 Worker 오류"가 검출기 상태 줄에, Worker 전역에서 직접 던진 오류("바깥에서 낸 오류")도 같다. 모델 404(Worker 안 초기화 실패)는 "얼굴 검출기를 불러오지 못했습니다: …"(loading.spec).
- GPU 실패 흉내(FP16 확장 숨김): Worker·메인 모두 CPU로 대체하고 "GPU를 쓸 수 없어 CPU로 실행 중입니다" 보고. WebGL 없음: Worker·메인 모두 "WebGL2를 쓸 수 없습니다" 오류, 빈 화면, 남은 Worker 0.
- 롱태스크 10초: 위 "확인한 것" 7.

### 리뷰 수정

리뷰에서 확인된 문제를 고쳤다.

- **메인 스레드 어댑터의 `dispose()`가 진행 중인 초기화를 끊지 않던 문제** (P3-correctness-1, P3-architecture-2): `MediaPipeFaceDetector`에 `dispose()`하면 거부되는 `closed` 프로미스를 두고, `create()` 안의 `loadVision()`·`createFromOptions()`와 `updateOptions()`의 `setOptions()`를 이것과 경쟁시킨다(`untilClosed`). 그래서 `dispose()`하면 init·updateOptions(실행 장치 변경, 추론 중 GPU→CPU 재시도 포함)가 바로 거부되고 파이프라인의 작업 줄이 풀린다. 닫은 뒤에 만들어진 태스크는 만들어지는 대로 닫는다. 이제 Worker(`DetectorProxy`)와 메인 어댑터 모두 `Detector` 계약("진행 중인 요청도 끊는다")을 지키고, "초기화가 멈춘 검출기도 다시 바꾸면 닫는다"가 두 실행 위치 모두에서 맞다. 남는 비용: MediaPipe에는 태스크 만들기를 취소하는 API가 없어서 닫힌 메인 쪽 만들기는 끝까지 돈 뒤 닫힌다. 그래서 메인 스레드에서 태스크 만들기 두 개가 겹칠 수 있다. MediaPipe가 전역 `ModuleFactory`를 넣고 확인하는 구간(로더 스크립트 실행 → load 이벤트 → 확인·호출)이 한 태스크 안이라 서로 끼어들 틈은 없다고 판단했다(겹치는 경우를 따로 재현하지는 않았다).
- **카메라를 바꾸면 비동기 표시가 이전 카메라의 박스로 새 카메라 프레임을 그리던 문제** (P3-correctness-3, P3-architecture-1, P3-concurrency-privacy-2): `Frame`에 `streamId`(프레임을 낸 `MediaStream.id`)를 더했다. 카메라는 캡처를 시작할 때의 스트림 id를 붙인다(전환 직전에 시작한 캡처는 이전 스트림의 프레임으로 남는다). 파이프라인은 `push()`에서 스트림이 바뀐 것을 보면 `streamChanged()`를 부른다. 여기서 `latest`·`firstFrameMs`를 비우고, 세션을 올려 진행 중이던 이전 카메라 프레임의 추론 결과도 버리고, 목표 FPS 차례를 다시 센다(새 카메라의 첫 프레임을 바로 검출하도록). 화면은 비우지 않는다. 그래서 비동기는 새 카메라의 첫 결과까지 `waiting`으로 화면 전체를 가리고, 동기는 마지막 분석 프레임(이전 카메라, 자기 결과로 가려짐)을 남긴다. 제안처럼 `main.ts`의 `switchDevice()`에서 `pipeline.sourceChanged()`를 부르지 않은 이유: `camera.start()`는 새 getUserMedia가 끝날 때까지 이전 카메라 프레임을 계속 내고, `play()`가 끝나기 전에 새 카메라 프레임이 올 수도 있어서 호출 시점으로는 경계를 정확히 잡을 수 없다. 프레임에 스트림을 붙이면 경계가 정확하고 `main.ts`는 바꾸지 않아도 된다.
- **nit**
  - P3-correctness-5: `reset()`에서 `readyMs`도 비운다. 시작을 누른 뒤 첫 프레임이 오기 전 `failReason`이 `stalled`가 아니라 `waiting`이다(안내도 "첫 프레임 분석 중…").
  - P3-architecture-3: `stageNoteText`는 `frameCount > 0` 대신 `hasFrame`(`snapshot().drawnFrameId !== null`)으로 화면에 프레임이 있는지 본다. 비동기에서 동기로 바꿔 화면을 지운 뒤 "마지막으로 분석한 프레임을 보여 줍니다"라고 하지 않는다.
  - P3-architecture-4: `RenderRecord.failClosed`를 `fullCover`로 바꿨다(스냅숏의 `fullCover`와 같은 뜻). 스냅숏의 `failClosed`(failReason이 있다, 동기 모드의 멈춤 포함)와의 차이를 README 표에 적었다. 이 필드를 쓰는 단위·E2E 테스트도 바꿨다.
  - P3-architecture-5: README의 WebGL2 없음 문구를 "동기는 빈 화면, 비동기는 화면 전체를 가린 영상"으로, "원본을 가리지 않고 그리는 경로가 없다"를 "검출 결과나 fail-closed 판정을 거치지 않고 원본을 그리는 경로가 없다(비동기는 순간 노출 가능)"로 고쳤다. `pipeline.ts` 머리 주석도 같게 고쳤다.
- **리뷰 밖 테스트 수정**: `switching.spec.ts`의 GPU 대체 테스트(worker)가 전체 실행에서 한 번 실패했다. `drawnFrameId`와 `detectionFrameId`를 서로 다른 스냅숏에서 읽어서, 그 사이 새 프레임이 그려지면 값이 어긋났다(22 대 24). 한 스냅숏에서 읽게 고쳤다.

파일 지도 (리뷰 수정에서 바꾼 것):

```
src/detectors/mediapipe-face.ts   closed 프로미스, untilClosed, 늦게 만들어진 태스크 닫기
src/core/types.ts                 Frame.streamId
src/sources/camera.ts             캡처 시작 때의 스트림 id를 프레임에 붙임
src/core/pipeline.ts              streamChanged(), reset()의 readyMs, RenderRecord.fullCover
src/ui/status-text.ts  src/main.ts  stageNoteText의 hasFrame
README.md                         fullCover, 카메라 전환, WebGL2 없음·원본 경로 문구
tests/unit/mediapipe-face.test.ts 가짜 tasks-vision으로 진짜 어댑터의 dispose 확인 (3개)
tests/unit/pipeline.test.ts       카메라 전환 2개, reset 뒤 waiting
tests/e2e/devices.spec.ts         비동기 + 같은 크기 카메라 전환
tests/e2e/worker.spec.ts          메인 초기화가 멈춘 채 Worker로 전환
```

**새 테스트**: Vitest 5개. mediapipe-face 3개(가짜 `@mediapipe/tasks-vision`으로 실제 메인 스레드 어댑터를 돌린다: WASM 로더가 응답하지 않아도 `dispose()`하면 init이 바로 거부, 태스크를 만드는 중에 닫으면 바로 거부하고 늦게 만들어진 태스크는 닫음, 실행 장치를 바꾸는 중에 닫으면 updateOptions가 바로 거부), pipeline 2개(비동기: 같은 해상도의 다른 카메라로 바꾸면 새 카메라의 첫 결과까지 전체를 가리고 진행 중이던 이전 카메라 결과는 버림 / 동기: 진행 중이던 이전 카메라 프레임은 그리지 않음). 기존 failClosedReason 테스트에 reset 뒤 `waiting` 확인을 더했다. E2E 2개:

- `devices.spec.ts` 비동기 + 합성 가짜 카메라 2대(둘 다 1280×720) 전환, getUserMedia 300ms 지연: 전환 직전까지 이전 카메라의 결과로 그리다가 새 카메라의 첫 프레임 1개를 전체를 가려 그리고, 그 뒤 박스로 그린 프레임은 모두 새 카메라 프레임의 결과를 쓴다(3번 반복 모두 가린 프레임 1개).
- `worker.spec.ts` 메인 스레드만 쓰는 클래식 WASM 로더(`vision_wasm_internal.js`)를 6초 늦춰 메인 초기화를 멈춘 채 실행 위치를 Worker로 바꾸면 222ms 만에 Worker가 준비되고 검출 1개.

**테스트가 버그를 잡는지 확인**: 고친 동작을 하나씩 되돌려 보았다. 확인 뒤 원래 코드로 복원했다.

- 어댑터의 `untilClosed`가 경쟁 없이 그대로 기다리게 하면 mediapipe-face 단위 3개가 시간 초과로 실패하고, worker.spec의 멈춘 메인 → Worker 전환이 6339ms 걸려 실패한다.
- `push()`에서 `streamChanged()` 대신 스트림 id만 바꾸게 하면 pipeline 단위 2개와 devices.spec 비동기 전환 테스트(전체를 가린 프레임이 나오지 않음)가 실패한다.
- `reset()`에서 `readyMs = null`을 빼면 failClosedReason 테스트가 실패한다.

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm test` | 13 파일, 150 테스트 통과 |
| `npm run build` | 통과 (앱 JS 188.6KB, Worker 4.6KB, MediaPipe 청크 154.4KB(메인)·154.7KB(Worker), CSS 2.4KB) |
| `npm run e2e` | 100 테스트 통과 (약 5.8분). 키보드 포커스 탐색 테스트는 P1부터 `test.fail()`(예상된 실패) |
| `npx playwright test switching.spec devices.spec --repeat-each=3` | 33/33 통과 |

## P4 트래킹 + 검출기 교체 (M5 + M6, 축약) — 2026-10-31

발표 일정 때문에 P4는 축약했다. Workflow의 P4 구현 에이전트가 코드를 거의 다 쓴 상태에서 멈췄고, 그 뒤 리뷰·검증·QA 사이클 없이 메인 세션이 마무리했다.

### 만든 것

- `src/tracking/iou-tracker.ts`: IoU 그리디 매칭, 정수 트랙 id, 검출이 끊긴 뒤 `holdMs` 동안 마지막 박스 유지, 트랙별 One Euro 스무딩. 내보내는 박스는 스무딩 박스와 그 프레임의 검출 박스의 합집합이라 스무딩 때문에 가리는 범위가 줄지 않는다. 매칭할 때는 최근 속도로 위치를 예측한다(최대 300ms).
- `src/tracking/one-euro.ts`: One Euro Filter (시각 단위는 초).
- 파라미터: 유지 시간, 스무딩, minCutoff, beta, IoU 임계, 모양(사각형/타원). 디버그 오버레이에 트랙 id.
- `src/effects/clip.ts`: 타원 모양. 프레임으로 자르기 전 영역에 내접시킨다.
- 두 번째 검출기 `src/detectors/mediapipe-face-landmarker.ts`(박스 = 랜드마크를 감싸는 사각형). 공통 부분은 `src/detectors/mediapipe-task.ts`로 뺐다. 레지스트리 항목이 자기 파라미터(`numFaces`)를 들고 오고, Worker와 메인 스레드 양쪽에서 돈다.

### 아이패드(Safari/WebKit) 대응

- 발표에서 아이패드로 보기 위해 확인했다. `ResizeObserver.observe(..., { box: 'device-pixel-content-box' })`가 WebKit에서 TypeError를 던져 앱이 아예 시작되지 않았다. 지원하지 않으면 `content-box`로 관찰하도록 바꿨다(`resize()`는 원래 contentRect × DPR 경로가 있었다).
- Playwright WebKit 27.2에서 캔버스 스트림을 가짜 카메라로 넣어 확인했다. Worker·메인 모두 GPU로 얼굴 1개를 검출했고, 트랙 id 1, 추론 약 8 FPS였다. 실제 iPadOS Safari와 같은 엔진이지만 실기기 확인은 아니다.
- `vite.config.ts`의 `server`/`preview`에 `allowedHosts: ['.ts.net']`를 넣었다. `npm run demo`는 빌드한 뒤 5320에서 preview를 띄운다. 아이패드에서는 `tailscale serve`(HTTPS)로 연다. 카메라는 HTTPS 같은 보안 컨텍스트에서만 열리므로 `http://100.x.x.x`로는 열리지 않는다.

### 검증

- typecheck 통과. 단위 테스트 177개 통과(트래커·One Euro 포함).
- 전체 E2E: P1~P3 기대값 중 "신뢰도 0.99면 영역이 바로 사라진다"(`mosaic.spec.ts`)는 박스 유지와 충돌해서, 그 검사에서는 `holdMs` 0으로 고쳤다.
- 생략한 것: P4 리뷰·검증·QA, P4 전용 E2E(트랙 id 안정성, 유지 시간 측정, 스무딩 지터 비교, 타원 픽셀 검사), `npm run bench`와 `docs/RESULTS.md`.

## P5 자연어로 가릴 대상 정하기 (추가 요구) — 2026-10-31

발표 직전에 들어온 요구다. 자연어 명령으로 무엇을 모자이크할지 정하되, API가 아니라 로컬에서 도는 모델을 쓴다. 리뷰·QA 사이클 없이 메인 세션이 바로 구현했다.

- **모델 선택**: Transformers.js의 OWL-ViT(`Xenova/owlvit-base-patch32`, 오픈 어휘 검출, 텍스트 → 박스). 후보 중 가장 작고 API가 단순하다.
  - Grounding DINO tiny: fp16 360MB, 더 무겁다.
  - Florence-2 base: 인코더-디코더 생성이라 느리고 구현이 복잡하다.
  - Moondream: 약 2B로 브라우저·아이패드에 너무 크다.
- **구현**:
  - `src/detectors/owlvit.ts`: Detector 어댑터, 자기 파라미터 `prompt`·`owlThreshold`, 메인 스레드 전용(`DetectorEntry.mainOnly`).
  - `ParamSpec`에 `text` 타입을 추가했다.
  - 기본 규칙을 "모든 라벨 → 고른 이펙트"로 바꿨다.
  - 검출기 상태 줄에 해석한 대상을 보여 준다.
  - 모델·ORT WASM은 fetch-assets가 로컬로 받는다(`public/models/hf/`, `public/ort/`).
- **문제와 해결**:
  - transformers 4.3.2(onnxruntime-web 1.31.0-dev)는 WebGPU·WASM 모두 `Provider type for Where node '/class_head/Where' is not set`으로 세션 생성에 실패했다. 그래프 최적화를 꺼도 같았다. 3.8.1(onnxruntime-web 1.22)로 내려 해결했다.
  - "넥타이랑"을 조사 "이랑"으로 잘라 "넥타"가 되던 파서 버그를 고쳤다. 지금은 조사로 자르지 않고 사전 낱말을 문장에서 찾는다.
- **확인**:
  - 헤드리스 Chrome(WebGPU 사용 가능)에서 정지 초상 영상에 "넥타이랑 깃발 가려줘"를 넣으면 넥타이 1개(0.34)와 깃발 2개(0.24, 0.14)만 가려지고 얼굴은 보인다. "얼굴"은 0.46으로 잡았다.
  - GPU fp16 기준 추론 약 80ms, 첫 로드 10~20초, 외부 요청 0건.
  - 파서 단위 테스트 4개.
- **한계**:
  - 한국어는 사전 낱말만 이해한다.
  - 관계 표현("왼쪽 사람만")은 지원하지 않는다.
  - 아이패드는 WebGPU가 없으면 WASM 8비트로 느리다(프레임당 수 초 예상, 미측정).

### P5 정정 — 사전 파싱 제거, OWL-ViT 단독 기본 (같은 날)

- 사용자 지적: 자연어를 사전으로 파싱하지 말고 모델이 해석하게 하라. 한→영 사전과 `parsePrompt`를 모두 지웠다.
- **Qwen3.5-0.8B 직접 박스**(이미지 + 명령 → bbox JSON, Transformers.js 4.4.0-next): 헤드리스 Chrome WebGPU에서 프레임당 11.3초가 걸렸고 박스도 부정확해 실시간 검출로는 쓸 수 없다.
- **Qwen3.5-0.8B 해석 + OWL-ViT 검출**: 해석이 명령마다 8.5~11.2초였고 결과도 틀렸다.
  - "넥타이랑 깃발 가려줘" → ["넥타이랑 깃발 가려줘", "put the belt and the flag together"]
  - "사람 얼굴만 모자이크해줘" → []
- 결론: OWL-ViT 자체가 텍스트로 대상을 지정할 수 있다(영어 명사구). 그래서 **OWL-ViT 단독을 기본**으로 두고, Qwen 해석은 선택(`interpreter: 'qwen'`)으로 남겼다.
- OWL-ViT 단독 확인(정지 초상, WebGPU, 약 70ms·8 FPS): `human face` 0.37, `suit jacket` 0.17, `flag` 0.12. `necktie`는 못 잡았고 `a tie`로는 앞서 0.34였다(문구에 민감).
- 의존성: `@huggingface/transformers` 4.4.0-next.0(Qwen3.5), `transformers-v3` = `npm:@huggingface/transformers@3.8.1`(OWL-ViT). 두 onnxruntime-web(1.31 dev, 1.22 dev)이 한 페이지에 공존한다.
- 최종: 데모에서 지원되지 않는 경로를 보이지 않도록 Qwen 경로를 완전히 뺐다. 지운 것은 `qwen-vlm.ts`, `natural-language.ts`, `interpreter` 파라미터, Transformers.js 4.x 의존성, Qwen 모델 파일(약 850MB)이다. 검출기는 `src/detectors/owlvit.ts`(id `owlvit`) 하나이고, 의존성은 `@huggingface/transformers` 3.8.1 하나, ORT WASM은 `public/ort/`(1.22, jsep + 기본)이다.
- 최종 확인(정지 초상, WebGPU, 약 70ms·8 FPS): `a tie, a flag` → 넥타이 0.34, 깃발 0.24·0.14. `human face` → 0.37. `wrist watch, suit jacket` → 재킷 0.17(시계는 못 잡음). 외부 요청 0건. 단위 테스트 177개 통과.

## P6 공식 저장소에서 직접 받기 + 영어 UI (제출 준비) — 2026-10-31

- 사용자 요구: 데모를 GitHub 저장소로 제출하고 상대가 직접 써 본다. 그래서 사용자 서버가 떠 있을 때만 동작하면 안 되고, 받을 것은 공식 저장소에서 받아야 한다. 처음 요구사항의 "외부 서버 없이"는 이제 "추론은 브라우저 안에서, 다운로드는 공식 출처에서"로 바뀌었다.
- 바꾼 것:
  - MediaPipe 모델은 `storage.googleapis.com/mediapipe-models`, WASM은 `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm`에서 받는다.
  - OWL-ViT는 Hugging Face Hub(`Xenova/owlvit-base-patch32`)에서, ORT WASM은 Transformers.js 기본값(jsDelivr)에서 받는다. 모두 CORS `*`라 정적 호스팅에서도 받을 수 있다.
  - fetch 가드는 같은 출처만 허용하던 방식에서 텔레메트리 호스트(`odml.pa.googleapis.com`)만 막는 방식으로 바꿨다.
  - 지운 것: `scripts/fetch-assets.mjs`, `predev`/`prebuild`/`assets` 스크립트, `public/models`·`public/wasm`·`public/ort`, dev 전용 `serve-public-wasm` 플러그인, 임시 HTTPS 설정.
- 확인(별도 outDir 빌드, 헤드리스 Chrome): 요청 호스트는 localhost, cdn.jsdelivr.net, storage.googleapis.com, huggingface.co, us.aws.cdn.hf.co뿐이고, 텔레메트리 1건을 막았다.
  - BlazeFace Worker GPU: face 0.88
  - BlazeFace 메인 GPU: face 0.88
  - OWL-ViT `a tie, a flag`: 0.34, 0.24, 0.14
- iOS 대응: iPhone·iPad에서는 Worker 안의 MediaPipe가 `document`를 찾다 실패하고, GPU 실행 장치를 만들다 멈췄다. iOS에서는 기본값을 `location: 'main'`, `delegate: 'CPU'`로 둔다.
- 다른 기기 접속(데모): `npm run demo`(127.0.0.1:5320) + `tailscale serve --bg 5320`. 처음 실패한 원인은 두 가지였다.
  - preview가 `[::1]`에만 열려 있었다(`--host 127.0.0.1`로 해결).
  - macOS 방화벽이 `tailscaled`와 `node`의 들어오는 연결을 막고 있었다(사용자가 tailscaled를 허용).
- UI 영어화(포크 에이전트): 패널·상태 줄·오류·안내·버튼을 모두 영어로 바꿨다. 머리글에 **Hide:** 입력창 + Apply를 추가했다. 누르면 `prompt`가 설정되고 `model`이 `owlvit`로 바뀌며, 패널의 같은 칸과 서로 맞춰진다. 390px 폭에서도 가로 스크롤이 없다. 문구를 확인하는 단위·E2E 테스트도 같이 고쳤다.
- 진행 표시줄(`src/ui/loading-bar.ts`): fetch 가드에서 모델·WASM 응답(`.wasm`, `.tflite`, `.task`, `.onnx` 등)을 복제해 받은 바이트를 센다. 메인과 Worker 모두 세고, Worker는 `download` 메시지로 메인에 보낸다. 표시는 "Downloading model files… N% (a / b MB)"이고, 다 받은 뒤 검출기가 `loading`인 동안은 움직이는 막대 "Loading model…"이다. 1.5MB/s로 늦춘 새 세션에서 표시됐다가 준비되면 사라지는 것을 확인했다.
- E2E: CDN 전환으로 깨진 7개를 고쳤다.
  - 모델 가로채기 패턴을 `**/<파일명>`으로 바꿨다.
  - "localhost 밖 요청 0건" 검사를 "앱 자신·공식 저장소(`storage.googleapis.com`, `cdn.jsdelivr.net`, `huggingface.co`, `*.hf.co`) 밖 요청 0건"으로 바꿨다(`isExpectedUrl`).
  - 관련 9개 스펙을 돌린 결과 55개 중 53개가 통과했다. 실패한 2개(`P2-5/6`, `P3-4 sync`)는 단독으로 다시 돌리면 통과했다(부하 중 타이밍 흔들림).
- 확인: typecheck 통과, 단위 테스트 179개 통과, build 통과. 데모 서버는 `127.0.0.1:5320`에서 최종 빌드를 내려준다.
- UI 정리: 머리글 아래에 간단 조작줄(`src/ui/quick-controls.ts`)을 뒀다.
  - **Face mosaic | Text targets** 토글: `model`을 마지막 얼굴 검출기와 `owlvit` 사이에서 바꾼다. Text일 때만 Hide 입력이 보인다.
  - Mosaic blocks(`blockCells`, 움직이면 `blockMode`를 relative로), Effect, Shape, Show boxes(`debug`).
  - 기존 Tweakpane 패널은 "Advanced settings"로 이름을 바꾸고 폴더를 기본으로 접었다(기능은 그대로).
  - 자동화 브라우저(`navigator.webdriver`)에서는 E2E가 라벨로 조작하므로 폴더를 펼친다. 조작줄의 `Effect` 그룹과 이름이 겹치는 E2E 3곳은 패널 범위로 좁혔다.
  - 데스크톱(1280)과 휴대폰(390) 화면, 모드 전환, 가로 스크롤 없음을 확인했다.
- E2E 추가 수정: 모델 지연용 정규식(`/models/blaze_face_…`)과 네트워크 스펙의 자산 필터를 새 공식 경로에 맞췄다. 번역 범위에서 빠졌던 `qa-p2-network`의 한국어 버튼 이름을 고쳤다.

## P7 GitHub Pages로 배포할 수 있는 저장소 정리 — 2026-10-31

- `vite.config.ts`에 `base: './'`를 넣어, 빌드 결과물이 하위 경로(`https://<계정>.github.io/<레포>/`)에서도 동작하게 했다.
- `.github/workflows/deploy.yml`: `main` push 또는 수동 실행 시 Node 24로 `npm ci` → typecheck → 단위 테스트 → build → `actions/upload-pages-artifact`(dist) → `actions/deploy-pages`를 돈다. 저장소 Settings → Pages → Source를 "GitHub Actions"로 한 번 설정해야 한다.
- 확인: 빌드 결과물을 `/automatic-mosaic/` 하위 폴더에 넣고 정적 서버로 연 뒤 헤드리스 Chrome에서 돌렸다. 400 이상 응답과 페이지 오류는 없었다.
  - 얼굴(Worker): face 0.88
  - 텍스트 대상 `a tie, a flag`: 0.34, 0.24, 0.14
- 커밋 작성자: 이 저장소에만 `mconcat <67312570+mconcat@users.noreply.github.com>`로 설정했다(전역 git 설정이 없었다).

## P8 iPhone 텍스트 모드 수정 — 2026-10-31

- 증상 1: iPhone에서 Text targets로 바꾸자마자 탭이 죽었다("이 페이지를 열 수 없음"). 진행 표시줄을 넣은 뒤부터 생겼다.
  - 원인 추정: 진행률을 세려고 OWL-ViT fp16(약 300MB) 응답을 `clone()`해 iOS WebKit 메모리 한도를 넘었다.
  - 수정: 64MB를 넘는 응답은 복제하지 않는다. OWL-ViT 진행률은 Transformers.js `progress_callback`으로 받는다. q4f16(127MB)은 onnxruntime-web 1.22 WebGPU에서 세션 생성에 실패해(`Failed to load detector: 265780232`) fp16을 유지했다.
- 증상 2: 탭은 살았지만 "Importing a module script failed"가 났다.
  - 원인: 재배포 전에 연 페이지가 이제 없는 코드 조각을 불러왔고, preview 서버가 그 자리에 index.html을 돌려줬다. 같은 빌드를 macOS WebKit에서 돌리면 정상이었다.
  - 수정: 동적 import 실패를 "앱이 갱신됐을 수 있으니 새로고침하라"는 안내로 바꾼다(`src/core/chunk-error.ts`).
- 같은 URL은 진행률을 처음 한 번만 센다(검출기를 다시 만들 때마다 모델을 복제하지 않는다).
  - "검출기를 30번 다시 만들어도 RSS가 계속 늘지 않는다" 탐색 테스트: 304·325MB로 기준 300MB를 넘다가, 수정 후 273MB로 통과했다(20번째 이후 평탄).
- 전체 E2E(이 수정 전): 125개 중 123개 통과. 실패한 2개는 위 메모리 테스트와, 영어 문구 대소문자(`Worker` → `worker`) 검사였고 둘 다 고쳤다. 수정 후 관련 스펙 62개 통과, 단위 테스트 182개 통과.

## P9 백그라운드 탭에서 끊긴 다운로드 자동 재시도 — 2026-10-31

- 증상: iPad에서 모델을 받는 중에 탭을 잠깐 나갔다 오면 "Load failed"가 뜨고 검출기가 오류 상태로 남았다. iOS가 백그라운드 탭의 요청을 끊기 때문이다.
- 수정 `src/core/load-retry.ts`:
  - 오류 문구가 브라우저의 fetch 네트워크 실패 문구로 끝나면 다시 불러온다. 대상은 Safari "Load failed", Chrome "Failed to fetch"·"network error", Firefox "NetworkError…"다. MediaPipe의 "Failed to fetch model: … (404)" 같은 HTTP 오류는 넣지 않는다.
  - 탭이 다시 보이면(`visibilitychange`) 바로 다시 시도한다.
  - 보이는 동안 끊긴 것이면 2초·5초·10초 뒤에 최대 3번 다시 시도하고, 준비되면 횟수를 되돌린다.
  - 그동안 상태 줄에는 "Model download was interrupted … Retrying…"이 나온다.
- 진행 표시줄은 이제 검출기를 불러오는 동안만 보인다. 중간에 끊긴 다운로드 항목이 남아도 표시줄이 멈춰 있지 않다.
- 테스트:
  - 단위 5개(문구 판별, 간격·횟수, 백그라운드 대기 후 복귀 시 재시도, 준비 후 횟수 초기화)
  - E2E 2개(`load-retry.spec.ts`: 보이는 동안 끊김 → 자동 회복, 백그라운드 끊김 → 3초 동안 재요청 없음 → 탭이 보이는 순간 회복)
  - 전체 E2E 127개 모두 통과, 단위 테스트 187개 통과.
