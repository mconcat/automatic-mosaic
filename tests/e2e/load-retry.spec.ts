import { expect, test } from '@playwright/test';
import { collectPageErrors, useFakeCamera } from './helpers';

// 모델 다운로드가 끊기면(iOS는 탭이 백그라운드로 가면 요청을 끊는다) 검출기를 다시 불러온다.
useFakeCamera('still-1face.y4m');

const MODEL = '**/blaze_face_short_range.tflite';

test('보이는 동안 다운로드가 끊기면 잠시 뒤 저절로 다시 받아 준비된다', async ({ page }) => {
  const errors = collectPageErrors(page);
  // failing인 동안은 모델 요청을 끊는다 (GPU 실패 → CPU 대체로 다시 받는 것까지 끊어 오류 상태를 만든다)
  let failing = true;
  await page.route(MODEL, (route) => (failing ? route.abort('failed') : route.continue()));
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
  await expect(page.locator('#detector')).toContainText('Model download was interrupted');
  failing = false;
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('백그라운드에서 끊기면 기다렸다가, 탭이 다시 보일 때 바로 다시 받는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  // 페이지가 보는 document.visibilityState를 테스트가 정한다
  await page.addInitScript(() => {
    const w = window as unknown as { __hidden: boolean };
    w.__hidden = true;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (w.__hidden ? 'hidden' : 'visible') });
  });
  let failing = true;
  let requests = 0;
  await page.route(MODEL, (route) => (++requests, failing ? route.abort('failed') : route.continue()));
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
  failing = false;
  const atError = requests;
  await page.waitForTimeout(3000); // 보이는 동안이었다면 2초 뒤 다시 시도했을 시간
  expect(await page.evaluate(() => window.__am.snapshot().detectorState)).toBe('error');
  expect(requests).toBe(atError); // 백그라운드에서는 다시 받지 않았다

  await page.evaluate(() => {
    (window as unknown as { __hidden: boolean }).__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 15_000 });
  expect(requests).toBeGreaterThan(atError);
  expect(errors).toEqual([]);
});
