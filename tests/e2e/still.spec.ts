import { expect, test } from '@playwright/test';
import { isExpectedUrl } from './qa-helpers';
import {
  canvasThumb,
  collectPageErrors,
  expectFpsAbove,
  flipThumb,
  litRatio,
  meanAbsDiff,
  snapshot,
  startApp,
  useFakeCamera,
} from './helpers';

useFakeCamera('still-1face.y4m');

test('시작 전에는 idle 상태이고 캔버스가 비어 있다', async ({ page }) => {
  await page.goto('/');
  const s = await snapshot(page);
  expect(s.state).toBe('idle');
  expect(s.frameCount).toBe(0);
  expect(litRatio(await canvasThumb(page))).toBe(0);
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('시작하면 캔버스에 영상이 나오고 렌더 FPS가 5를 넘는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);

  expect(litRatio(await canvasThumb(page))).toBeGreaterThan(0.3);
  await expectFpsAbove(page, 5);

  const s = await snapshot(page);
  expect(s.state).toBe('running');
  expect(s.error).toBeNull();
  expect([s.videoWidth, s.videoHeight]).toEqual([640, 480]);
  expect(s.tracks.length).toBeGreaterThan(0);
  expect(s.tracks.every((t) => t.readyState === 'live')).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(page.locator('#stats')).toContainText('640×480');

  // 권한을 얻은 뒤 장치 목록이 채워진다 (선택 상자는 장치 이름, ID는 테스트 훅).
  expect(s.devices.length).toBeGreaterThan(0);
  expect(s.devices.every((d) => d.deviceId !== '')).toBe(true);
  await expect(page.locator('#camera option')).toHaveCount(s.devices.length);
  await expect(page.locator('#camera option').first()).toHaveText(s.devices[0]!.label);
  expect(errors).toEqual([]);
});

test('미러 토글은 화면을 좌우로 뒤집는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const mirror = page.getByLabel('Mirror');
  await expect(mirror).toBeChecked(); // 기본값 켬

  await mirror.uncheck();
  expect(await page.evaluate(() => window.__am.get('mirror'))).toBe(false);
  await page.waitForTimeout(300);
  const plain = await canvasThumb(page);

  await mirror.check();
  expect((await snapshot(page)).mirror).toBe(true);
  await page.waitForTimeout(300);
  const mirrored = await canvasThumb(page);

  // 원본과는 많이 다르고, 원본을 뒤집은 것과는 거의 같다.
  const diffPlain = meanAbsDiff(plain, mirrored);
  const diffFlipped = meanAbsDiff(flipThumb(plain), mirrored);
  expect(diffPlain).toBeGreaterThan(10);
  expect(diffFlipped).toBeLessThan(3);

  // 테스트 훅으로도 바꿀 수 있다.
  await page.evaluate(() => window.__am.set('mirror', false));
  await expect(mirror).not.toBeChecked();
  await page.waitForTimeout(300);
  expect(meanAbsDiff(plain, await canvasThumb(page))).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test('정지하면 모든 트랙이 끝나고 렌더 루프가 멈춘다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await page.getByRole('button', { name: 'Stop' }).click();

  const s = await snapshot(page);
  expect(s.state).toBe('stopped');
  expect([s.videoWidth, s.videoHeight]).toEqual([0, 0]);
  await expect(page.locator('#stats')).toContainText('Video —');
  expect(s.tracks.length).toBeGreaterThan(0);
  expect(s.tracks.every((t) => t.readyState === 'ended')).toBe(true);
  // 비디오 요소도 스트림을 놓았다.
  expect(await page.evaluate(() => (document.getElementById('source') as HTMLVideoElement).srcObject)).toBeNull();

  await page.waitForTimeout(800);
  const later = await snapshot(page);
  expect(later.frameCount).toBe(s.frameCount);
  await expect.poll(async () => (await snapshot(page)).renderFps).toBe(0);
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();

  // 다시 시작할 수 있다.
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running' && window.__am.snapshot().frameCount > 3);
  expect(errors).toEqual([]);
});

test('세션 동안 앱 자신과 공식 모델·WASM 저장소 밖으로 나가는 요청이 없다', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  const errors = collectPageErrors(page);

  await startApp(page);
  await page.getByLabel('Mirror').uncheck();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.reload();
  await page.waitForLoadState('networkidle');

  expect(urls.length).toBeGreaterThan(0);
  const external = urls.filter((u) => !isExpectedUrl(u));
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
