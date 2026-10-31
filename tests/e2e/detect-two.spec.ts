import { expect, test } from '@playwright/test';
import { collectPageErrors, snapshot, startApp, useFakeCamera } from './helpers';
import { nextFrames, regionStats, toCanvasRect } from './pixels';

// 같은 인물 두 장을 나란히 붙인 픽스처 (왼쪽 절반, 오른쪽 절반에 얼굴 하나씩)
useFakeCamera('two-faces.y4m');

test('얼굴 둘을 찾고 둘 다 모자이크한다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 3);
  const counts: number[] = [];
  for (let i = 0; i < 6; i++) {
    counts.push((await snapshot(page)).detections.length);
    await page.waitForTimeout(150);
  }
  const s = await snapshot(page);
  console.log('[two-faces]', JSON.stringify({ counts, detections: s.detections.map((d) => ({ score: d.score, box: d.box })) }));
  expect(counts.every((n) => n === 2)).toBe(true);
  expect(s.location).toBe('worker'); // P3: 기본 실행 위치
  const [a, b] = [...s.detections].sort((p, q) => p.box.x - q.box.x);
  expect(a!.score).toBeGreaterThanOrEqual(0.5);
  expect(b!.score).toBeGreaterThanOrEqual(0.5);
  expect(a!.box.x + a!.box.width / 2).toBeLessThan(320);
  expect(b!.box.x + b!.box.width / 2).toBeGreaterThan(320);
  expect(s.regions).toHaveLength(2);
  for (const r of s.regions) {
    const stats = await regionStats(page, await toCanvasRect(page, r));
    expect(stats.flat).toBeGreaterThan(0.9);
  }
  expect(errors).toEqual([]);
});
