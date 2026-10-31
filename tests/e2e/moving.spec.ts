import { expect, test } from '@playwright/test';
import { canvasThumb, collectPageErrors, expectFpsAbove, litRatio, meanAbsDiff, snapshot, startApp, useFakeCamera } from './helpers';

useFakeCamera('moving-1face.y4m');

test('움직이는 영상에서 프레임이 시간에 따라 바뀐다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await expectFpsAbove(page, 5);

  // 프레임 수를 먼저 읽는다 (그 사이 새 프레임이 그려져도 아래 비교는 그보다 새 프레임이 있어야 통과한다)
  const firstCount = (await snapshot(page)).frameCount;
  const first = await canvasThumb(page);
  expect(litRatio(first)).toBeGreaterThan(0.3);

  // 머리가 좌우로 왕복하므로 곧 화면이 눈에 띄게 달라져야 한다. 고정 간격 한 번만 비교하면
  // 두 시점에 머리가 같은 자리에 있을 수 있어서, 달라질 때까지 다시 찍는다.
  await expect.poll(async () => meanAbsDiff(first, await canvasThumb(page)), { timeout: 3000 }).toBeGreaterThan(2);
  expect((await snapshot(page)).frameCount).toBeGreaterThan(firstCount);
  expect(errors).toEqual([]);
});
