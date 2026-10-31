// QA P2-2 (나란히 2인 픽스처): 얼굴 2개, 각 박스가 각 얼굴 위, 둘 다 모자이크.
import { expect, test } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, collectDetections, grid, installQa2, save2, shot2 } from './qa-p2-helpers';

useFakeCamera('two-faces.y4m');

// 손으로 잡은 정답 (two-faces.y4m 첫 프레임, 원본 좌표). 오른쪽 얼굴은 x + 320.
const LEFT = { face: { x: 92, y: 42, width: 138, height: 153 }, eyes: [{ x: 140, y: 100 }, { x: 187, y: 100 }], nose: { x: 162, y: 132 }, mouth: { x: 162, y: 152 } };
const shift = (p: { x: number; y: number }, dx: number): { x: number; y: number } => ({ x: p.x + dx, y: p.y });
const contains = (r: Rect, p: { x: number; y: number }): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

test('P2-2 2인: 분석 프레임마다 얼굴 2개, 각 박스가 각 얼굴 위, 둘 다 블록', async ({ page }) => {
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa2(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 3);
  const frames = await collectDetections(page, 24);
  const s = await snapshot(page);
  const boxes = [...s.detections].sort((a, b) => a.box.x - b.box.x).map((d) => d.box);
  const checks = [0, 320].map((dx, i) => {
    const b = boxes[i]!;
    const pts = [...LEFT.eyes, LEFT.nose, LEFT.mouth].map((p) => contains(b, shift(p, dx)));
    return { box: b, pointsInside: pts, center: { x: b.x + b.width / 2, y: b.y + b.height / 2 } };
  });
  const p = await page.evaluate(() => window.__am.params());
  const blocks = [];
  for (const r of s.regions) {
    const g = grid(r, String(p.blockMode), Number(p.blockSize), Number(p.blockCells));
    blocks.push(await page.evaluate(([r, c, rr]) => window.__qa2.blockCheck(r, c, rr), [r, g.cols, g.rows] as const));
  }
  const same = await page.evaluate((rs) => window.__qa2.sameFrame('strength', 0, rs), s.regions);
  const shots = [await shot2(page, 'p2-12-two-faces')];
  await page.evaluate(() => window.__am.set('debug', true));
  shots.push(await shot2(page, 'p2-12b-two-faces-debug-canvas', { canvasOnly: true }));

  const ev = { counts: frames.map((f) => f.count), scores: frames.map((f) => f.scores), checks, regions: s.regions, blocks, sameFrame: same, shots };
  save2('qa-p2-2-two-faces', ev);
  console.log('[P2-2 two]', JSON.stringify({ ...ev, scores: [...new Set(frames.flatMap((f) => f.scores.map((x) => x.toFixed(3))))] }));

  expect(frames.every((f) => f.count === 2), JSON.stringify(ev.counts)).toBe(true);
  expect(Math.min(...frames.flatMap((f) => f.scores))).toBeGreaterThanOrEqual(0.5);
  for (const c of checks) expect(c.pointsInside.every(Boolean), JSON.stringify(c)).toBe(true);
  expect(Math.abs(checks[0]!.center.x - 161)).toBeLessThan(30);
  expect(Math.abs(checks[1]!.center.x - 481)).toBeLessThan(30);
  expect(s.regions).toHaveLength(2);
  for (const b of blocks) expect(b.uniformFrac).toBeGreaterThanOrEqual(0.98);
  expect(same.outside.max).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});
