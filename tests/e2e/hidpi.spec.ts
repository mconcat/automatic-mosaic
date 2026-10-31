import { expect, test } from '@playwright/test';
import { collectPageErrors, startApp, useFakeCamera } from './helpers';

// 레티나 화면처럼 기기 픽셀 비율 2로 띄운다. Playwright의 deviceScaleFactor 에뮬레이션은
// devicePixelContentBoxSize를 CSS 픽셀로 돌려주므로, Chrome 플래그를 쓰고 뷰포트 에뮬레이션은 끈다.
useFakeCamera('still-1face.y4m', { args: ['--force-device-scale-factor=2'] });
test.use({ viewport: null });

test('캔버스 버퍼는 CSS 크기가 아닌 기기 픽셀 크기다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const s = await page.evaluate(() => {
    const c = document.getElementById('view') as HTMLCanvasElement;
    const css = c.getBoundingClientRect();
    return { dpr: devicePixelRatio, width: c.width, height: c.height, cssWidth: css.width, cssHeight: css.height };
  });
  expect(s.dpr).toBe(2);
  expect(s.cssWidth).toBeGreaterThan(100);
  expect(Math.abs(s.width - 2 * s.cssWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(s.height - 2 * s.cssHeight)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
