import { expect, test } from '@playwright/test';
import { canvasThumb, collectPageErrors, litRatio, snapshot, useFakeCamera } from './helpers';
import { regionStats, toCanvasRect } from './pixels';

// 검출기가 늦게 준비되어도 카메라 원본 프레임은 화면에 나오지 않는다.
useFakeCamera('still-1face.y4m');

test('검출기를 불러오는 동안 카메라가 켜져 있어도 화면은 비어 있고, 첫 그림부터 모자이크다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.route('**/blaze_face_short_range.tflite', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running' && window.__am.snapshot().videoWidth > 0);

  const s = await snapshot(page);
  expect(s.detectorState).toBe('loading');
  expect(s.frameCount).toBe(0);
  expect(s.drawnFrameId).toBeNull();
  expect(litRatio(await canvasThumb(page))).toBe(0);
  await expect(page.locator('#stage-note')).toHaveText('Loading detector…');
  await page.waitForTimeout(800);
  expect(litRatio(await canvasThumb(page))).toBe(0); // 여전히 빈 화면

  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1);
  const first = await snapshot(page);
  expect(first.drawnFrameId).toBe(first.detectionFrameId);
  const stats = await regionStats(page, await toCanvasRect(page, first.regions[0]!));
  expect(stats.flat).toBeGreaterThan(0.9);
  await expect(page.locator('#stage-note')).toBeHidden();
  expect(errors).toEqual([]);
});

test('검출기를 만들지 못하면 오류를 보여 주고 원본 프레임을 그리지 않는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.route('**/blaze_face_short_range.tflite', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running' && window.__am.snapshot().videoWidth > 0);
  await page.waitForTimeout(800);
  const s = await snapshot(page);
  console.log('[detector error]', s.detectorError);
  expect(s.detectorError).toMatch(/Failed to load detector/);
  expect(s.frameCount).toBe(0);
  expect(litRatio(await canvasThumb(page))).toBe(0);
  await expect(page.locator('#detector')).toContainText('Failed to load detector');
  await expect(page.locator('#stage-note')).toContainText('Detector error');

  // 모델을 다시 고르면 다시 시도한다
  await page.unroute('**/blaze_face_short_range.tflite');
  await page.evaluate(() => window.__am.set('delegate', 'CPU'));
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1);
  expect((await snapshot(page)).detectorState).toBe('ready');
  expect(errors).toEqual([]);
});
