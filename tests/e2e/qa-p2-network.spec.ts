// QA P2-7 / P1-7: 세션 전체(로드, 시작, 모델·실행 장치 전환, 이펙트, 정지·재시작, 새로고침, 65초 방치)에서
// 컨텍스트 단위로 모든 요청을 기록한다. localhost 밖 요청 0건, WASM·모델은 localhost에서 200으로 받는다.
import { expect, test, type Page } from '@playwright/test';
import { collectPageErrors, useFakeCamera } from './helpers';
import { isExpectedUrl, recordRequests } from './qa-helpers';
import { save2, shot2 } from './qa-p2-helpers';

useFakeCamera('still-1face.y4m');

async function waitReady(page: Page, id: string, delegate: string): Promise<void> {
  await page.waitForFunction(
    ([id, d]) => {
      const s = window.__am.snapshot();
      return s.detectorState === 'ready' && s.detectorId === id && s.activeDelegate === d;
    },
    [id, delegate] as const,
    { timeout: 20_000 },
  );
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 1);
}

test('P2-7 세션 전체 + 65초 방치: localhost 밖 요청 0건, WASM·모델은 localhost', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = collectPageErrors(page);
  const log = await recordRequests(context);
  const responses: { url: string; status: number; type: string }[] = [];
  context.on('response', (r) => responses.push({ url: r.url(), status: r.status(), type: r.request().resourceType() }));
  const failed: string[] = [];
  context.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  const blocked: string[] = [];
  const grabBlocked = async (): Promise<void> => {
    blocked.push(...(await page.evaluate(() => window.__am.snapshot().blockedRequests)));
  };

  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await waitReady(page, 'mediapipe-face-short', 'GPU');
  for (const [k, v, id, d] of [
    ['model', 'mediapipe-face-full', 'mediapipe-face-full', 'GPU'],
    ['delegate', 'CPU', 'mediapipe-face-full', 'CPU'],
    ['model', 'mediapipe-face-short', 'mediapipe-face-short', 'CPU'],
    ['delegate', 'GPU', 'mediapipe-face-short', 'GPU'],
  ] as const) {
    await page.evaluate(([k, v]) => window.__am.set(k, v), [k, v] as const);
    await waitReady(page, id, d);
  }
  await page.evaluate(() => window.__am.set('effect', 'solid'));
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await waitReady(page, 'mediapipe-face-short', 'GPU');
  await grabBlocked();
  await page.reload();
  await page.getByRole('button', { name: 'Start' }).click();
  await waitReady(page, 'mediapipe-face-short', 'GPU');
  await page.waitForTimeout(65_000); // MediaPipe 사용 지표 타이머(60초)를 넘긴다
  const fc = await page.evaluate(() => window.__am.snapshot().frameCount);
  await grabBlocked();
  const shots = [await shot2(page, 'p2-15-after-65s-soak')];

  const assets = responses.filter((r) => /\/(wasm|mediapipe-models)\//.test(r.url));
  const ev = {
    requestCount: log.all.length,
    external: log.external,
    nonLocalResponses: responses.filter((r) => !isExpectedUrl(r.url)),
    assets,
    blockedByApp: blocked,
    failed,
    frameCountAfterSoak: fc,
    all: log.all,
    shots,
  };
  save2('qa-p2-7-network', ev);
  console.log('[P2-7]', JSON.stringify({ ...ev, all: undefined }));

  expect(log.external).toEqual([]);
  expect(ev.nonLocalResponses).toEqual([]);
  expect(log.all.every((r) => isExpectedUrl(r.split(' ')[1]!))).toBe(true);
  const ok = (re: RegExp): boolean => assets.some((a) => re.test(a.url) && a.status === 200 && isExpectedUrl(a.url));
  expect(ok(/\/wasm\/vision_wasm(_module)?_internal\.wasm$/), 'wasm binary from the official npm package (jsDelivr)').toBe(true);
  expect(ok(/\/wasm\/vision_wasm(_module)?_internal\.js$/), 'wasm loader from the official npm package (jsDelivr)').toBe(true);
  expect(ok(/\/blaze_face_short_range\.tflite$/), 'short model from the official MediaPipe bucket').toBe(true);
  expect(ok(/\/blaze_face_full_range\.tflite$/), 'full model from the official MediaPipe bucket').toBe(true);
  expect(fc).toBeGreaterThan(400); // 방치하는 동안 계속 돌았다
  expect(errors).toEqual([]);
});
