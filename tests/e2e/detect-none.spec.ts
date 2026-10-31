import { expect, test } from '@playwright/test';
import { collectPageErrors, meanAbsDiff, canvasThumb, snapshot, startApp, useFakeCamera, unmasked } from './helpers';

// 얼굴이 없는 픽스처 (커튼과 깃발)
useFakeCamera('no-face.y4m');

test('얼굴이 없으면 몇 초 동안 검출 0개이고 화면은 그대로다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  // 분석 프레임마다 검출 수를 센다 (약 4초)
  const perFrame = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const counts: number[] = [];
        let last = -1;
        const t0 = performance.now();
        const tick = (): void => {
          const s = window.__am.snapshot();
          if (s.drawnFrameId !== last) {
            last = s.drawnFrameId ?? -1;
            counts.push(s.detections.length);
          }
          if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
          else resolve(counts);
        };
        tick();
      }),
  );
  const spurious = perFrame.filter((n) => n > 0).length;
  console.log('[no-face]', JSON.stringify({ frames: perFrame.length, spurious }));
  expect(perFrame.length).toBeGreaterThan(20);
  expect(spurious).toBe(0);
  const s = await snapshot(page);
  expect(s.regions).toEqual([]);
  expect(s.location).toBe('worker'); // P3: 기본 실행 위치

  // 가릴 것이 없으니 모자이크 강도와 상관없이 같은 화면
  const masked = await canvasThumb(page);
  await unmasked(page);
  expect(meanAbsDiff(masked, await canvasThumb(page))).toBeLessThan(1);
  expect(errors).toEqual([]);
});
