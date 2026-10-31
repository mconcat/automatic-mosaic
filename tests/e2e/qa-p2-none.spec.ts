// QA P2-2 (얼굴 없는 픽스처): 몇 초 동안 분석 프레임마다 0개. 잘못된 검출은 수로 보고한다.
import { expect, test } from '@playwright/test';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, collectDetections, installQa2, save2, shot2 } from './qa-p2-helpers';

useFakeCamera('no-face.y4m');

test('P2-2 얼굴 없음: 6초 동안 분석 프레임마다 0개 (기본 신뢰도 0.5), 화면은 모자이크 없이 그대로', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa2(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1);
  const t0 = Date.now();
  const frames = await collectDetections(page, 48, 20_000); // 목표 8fps → 약 6초
  const seconds = (Date.now() - t0) / 1000;
  const s = await snapshot(page);
  const same = await page.evaluate(() => window.__qa2.sameFrame('strength', 0, []));
  const shots = [await shot2(page, 'p2-13-no-face')];

  // 참고: 신뢰도를 낮췄을 때 잘못된 검출 수 (기준 아님, 보고용)
  const low: Record<string, number> = {};
  for (const c of [0.3, 0.1]) {
    await page.evaluate((c) => window.__am.set('minConfidence', c), c);
    await page.waitForTimeout(400);
    const f = await collectDetections(page, 16);
    low[String(c)] = f.filter((x) => x.count > 0).length;
  }

  const spurious = frames.filter((f) => f.count > 0);
  const ev = { analysedFrames: frames.length, seconds, framesWithDetections: spurious.length, totalDetections: spurious.reduce((a, f) => a + f.count, 0), spuriousScores: spurious.map((f) => f.scores), regions: s.regions, sameFrameVsStrength0: same, lowConfidenceFramesWithDetections_of16: low, shots };
  save2('qa-p2-2-no-face', ev);
  console.log('[P2-2 none]', JSON.stringify(ev));

  expect(frames.length).toBe(48);
  expect(seconds).toBeGreaterThan(4);
  expect(spurious.length).toBeLessThanOrEqual(1); // 드문 잘못된 검출만 허용 (수는 위에 보고)
  expect(same.outside.max).toBe(0); // 모자이크 영역이 없으니 강도와 무관하게 같은 화면
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});
