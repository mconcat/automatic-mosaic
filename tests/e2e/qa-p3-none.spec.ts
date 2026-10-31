// QA P3-1 (얼굴 없음 픽스처): 기본 실행 위치 Worker에서 여러 초 동안 검출 0개 (P2와 같음). 비동기에서도 0개이고 전체 덮개가 없다.
import { expect, test } from '@playwright/test';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, collectDetections } from './qa-p2-helpers';
import { hookSet, installQa3, save3, shot3, waitReady } from './qa-p3-helpers';

useFakeCamera('no-face.y4m');

test('P3-1 얼굴 없음: 기본 Worker에서 6초 동안 분석 프레임마다 0개, 비동기에서도 0개', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await page.goto('/');
  const locationParam = await page.evaluate(() => window.__am.get('location'));
  await waitReady(page, 'worker');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 3);
  const t0 = Date.now();
  const frames = await collectDetections(page, 45, 20_000); // 목표 8fps → 약 6초
  const seconds = (Date.now() - t0) / 1000;
  const s = await snapshot(page);
  const shots = [await shot3(page, 'p3-13-no-face-worker')];
  await hookSet(page, 'displayMode', 'async');
  await page.waitForTimeout(1500);
  const seq0 = (await page.evaluate(() => window.__am.renders().at(-1)?.seq)) ?? 0;
  await page.waitForTimeout(3000);
  const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
  const sa = await snapshot(page);
  shots.push(await shot3(page, 'p3-13b-no-face-async'));
  const ev = {
    locationParam,
    location: s.location,
    workers: s.workers,
    analysedFrames: frames.length,
    seconds,
    framesWithDetections: frames.filter((f) => f.count > 0).length,
    spurious: frames.filter((f) => f.count > 0).map((f) => f.scores),
    async: { renders: renders.length, cover: renders.filter((r) => r.fullCover).length, detections: sa.detections.length, regions: sa.regions, renderFps: sa.renderFps, inferenceFps: sa.inferenceFps },
    shots,
  };
  save3('qa-p3-1-no-face', ev);
  console.log('[P3-1 none]', JSON.stringify(ev));
  expect(locationParam).toBe('worker');
  expect(s.location).toBe('worker');
  expect(s.workers.live).toBe(1);
  expect(seconds).toBeGreaterThan(4);
  expect(ev.framesWithDetections).toBe(0);
  expect(ev.async.cover).toBe(0);
  expect(sa.detections).toHaveLength(0);
  expect(sa.regions).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});
