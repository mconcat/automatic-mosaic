import { expect, test } from '@playwright/test';
import { collectPageErrors, snapshot, startApp, useFakeCamera } from './helpers';
import { recordRequests } from './qa-helpers';

// 앱은 자신(localhost)과 모델·WASM 공식 저장소에만 요청한다. MediaPipe Tasks 1.2.0은 사용 지표를
// https://odml.pa.googleapis.com/v1/log 로 보내려 하는데(close() 때, 60초마다), 앱이 보내기 전에 막는다.
useFakeCamera('still-1face.y4m');

test('WASM·모델은 공식 저장소에서 받고, 모델·실행 장치·실행 위치를 바꿔도 그 밖의 요청이 없다 (MediaPipe 지표 전송은 Worker·메인 모두 앱이 막는다)', async ({ page, context }) => {
  const log = await recordRequests(context);
  const errors = collectPageErrors(page);
  await startApp(page);
  const run = async (steps: (readonly [string, string])[]): Promise<void> => {
    for (const [key, value] of steps) {
      await page.evaluate(([k, v]) => window.__am.set(k, v), [key, value] as const);
      await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready');
    }
  };
  // Worker (기본): 모델을 바꾸면 Worker를 새로 띄우고, 실행 장치를 바꾸면 Worker 안에서 태스크를 닫고 다시 만든다
  await run([
    ['model', 'mediapipe-face-full'],
    ['delegate', 'CPU'],
    ['model', 'mediapipe-face-short'],
    ['delegate', 'GPU'],
  ]);
  await page.waitForTimeout(300);
  const fromWorker = (await snapshot(page)).blockedRequests.length;
  // 메인 스레드
  await run([
    ['location', 'main'],
    ['delegate', 'CPU'],
    ['location', 'worker'],
  ]);
  await page.waitForTimeout(500);
  const s = await snapshot(page);
  const local = log.all.map((r) => r.replace(/^GET /, ''));
  console.log('[local-only]', JSON.stringify({ requests: log.all.length, external: log.external, fromWorker, blocked: s.blockedRequests }));
  expect(log.external).toEqual([]);
  const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm/';
  const MODELS = 'https://storage.googleapis.com/mediapipe-models/face_detector/';
  expect(local).toContain(`${WASM}vision_wasm_module_internal.wasm`); // Worker (ES 모듈 WASM)
  expect(local).toContain(`${WASM}vision_wasm_module_internal.js`);
  expect(local).toContain(`${WASM}vision_wasm_internal.wasm`); // 메인 스레드
  expect(local).toContain(`${WASM}vision_wasm_internal.js`);
  expect(local).toContain(`${MODELS}blaze_face_short_range/float16/1/blaze_face_short_range.tflite`);
  expect(local).toContain(`${MODELS}blaze_face_full_range/float16/1/blaze_face_full_range.tflite`);
  // 태스크를 닫을 때마다 MediaPipe가 지표를 보내려 했고, Worker 안에서도 보내기 전에 막아 메인에 알렸다.
  expect(fromWorker).toBeGreaterThanOrEqual(1);
  expect(s.blockedRequests.length).toBeGreaterThan(fromWorker);
  expect(s.blockedRequests.every((u) => u.startsWith('https://odml.pa.googleapis.com/'))).toBe(true);
  expect(s.workers.live).toBe(1);
  expect(errors).toEqual([]);
});

test('70초 동안 그대로 두어도 공식 저장소 밖 요청이 없다 (MediaPipe 60초 주기 지표 전송도 막는다)', async ({ page, context }) => {
  test.setTimeout(120_000);
  const log = await recordRequests(context);
  const errors = collectPageErrors(page);
  await startApp(page);
  await page.waitForTimeout(70_000);
  const s = await snapshot(page);
  console.log('[local-only 70s]', JSON.stringify({ requests: log.all.length, external: log.external, blocked: s.blockedRequests, frameCount: s.frameCount }));
  expect(s.state).toBe('running');
  expect(log.external).toEqual([]);
  expect(s.blockedRequests.length).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});
