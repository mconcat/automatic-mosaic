// QA P3-1 (나란히 2인 픽스처): 기본 실행 위치 Worker에서 P2와 같이 얼굴 2개, 각 박스가 각 얼굴 위, 둘 다 가려짐. 비동기도 확인.
import { expect, test } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, collectDetections } from './qa-p2-helpers';
import { hookSet, installQa3, qa3, save3, shot3, startSampler, stopSampler, summarize, waitReady } from './qa-p3-helpers';

useFakeCamera('two-faces.y4m');

// QA P2가 손으로 잡은 왼쪽 얼굴 (원본 좌표). 오른쪽 얼굴은 x + 320.
const LEFT_FACE: Rect = { x: 92, y: 42, width: 138, height: 153 };
const RIGHT_FACE: Rect = { ...LEFT_FACE, x: LEFT_FACE.x + 320 };
const LEFT_PTS = [{ x: 140, y: 100 }, { x: 187, y: 100 }, { x: 162, y: 132 }, { x: 162, y: 152 }];
const inside = (r: Rect, p: { x: number; y: number }): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

test('P3-1 2인: 기본 Worker에서 분석 프레임마다 얼굴 2개 (P2와 같음), 동기·비동기 모두 두 얼굴이 가려짐', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await page.goto('/');
  const locationParam = await page.evaluate(() => window.__am.get('location'));
  await waitReady(page, 'worker');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 3);
  const frames = await collectDetections(page, 24);
  const s = await snapshot(page);
  const boxes = [...s.detections].sort((a, b) => a.box.x - b.box.x).map((d) => d.box);
  const pointsInside = [0, 320].map((dx, i) => LEFT_PTS.map((p) => inside(boxes[i]!, { x: p.x + dx, y: p.y })));
  const flatSync = await page.evaluate(([l, r]) => [window.__qa3.flatness(l), window.__qa3.flatness(r)], [LEFT_FACE, RIGHT_FACE] as const);
  const shots = [await shot3(page, 'p3-12-two-faces-worker')];
  // 비동기에서도 두 얼굴이 계속 가려지는지 (오른쪽 얼굴 영역 표본 + 왼쪽은 끝에 한 번)
  await hookSet(page, 'displayMode', 'async');
  await page.waitForTimeout(1500);
  await startSampler(page, RIGHT_FACE);
  await page.waitForTimeout(3000);
  const asyncSamples = await stopSampler(page);
  const sa = await snapshot(page);
  const flatAsync = await page.evaluate(([l, r]) => [window.__qa3.flatness(l), window.__qa3.flatness(r)], [LEFT_FACE, RIGHT_FACE] as const);
  shots.push(await shot3(page, 'p3-12b-two-faces-async'));
  const q = await qa3(page);
  const ev = {
    locationParam,
    location: s.location,
    workers: s.workers,
    qaWorkers: q.workers,
    counts: frames.map((f) => f.count),
    scores: [...new Set(frames.flatMap((f) => f.scores.map((x) => x.toFixed(3))))],
    boxes,
    pointsInside,
    regions: s.regions,
    flatSync,
    async: { renderFps: sa.renderFps, inferenceFps: sa.inferenceFps, detections: sa.detections.length, regions: sa.regions.length, flat: flatAsync, samples: summarize(asyncSamples) },
    drawnUnanalysedSync: q.frames.drawnUnanalysed,
    shots,
  };
  save3('qa-p3-1-two-faces', ev);
  console.log('[P3-1 two]', JSON.stringify(ev));
  expect(locationParam).toBe('worker');
  expect(s.location).toBe('worker');
  expect(s.workers.live).toBe(1);
  expect(frames.every((f) => f.count === 2), JSON.stringify(ev.counts)).toBe(true);
  expect(Math.min(...frames.flatMap((f) => f.scores))).toBeGreaterThanOrEqual(0.5);
  for (const p of pointsInside) expect(p.every(Boolean)).toBe(true);
  expect(s.regions).toHaveLength(2);
  for (const f of flatSync) expect(f).toBeGreaterThan(0.9);
  expect(sa.detections).toHaveLength(2);
  expect(sa.renderFps).toBeGreaterThan(sa.inferenceFps * 1.5);
  for (const f of flatAsync) expect(f).toBeGreaterThan(0.9);
  expect(Math.min(...asyncSamples.filter((x) => x.face >= 0).map((x) => x.face))).toBeGreaterThan(0.9);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});
