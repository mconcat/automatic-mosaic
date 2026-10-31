// QA P2-5: GPU delegate가 실패하는 환경에서 CPU로 대체하고 그 사실을 UI·훅에 보고하는지.
// 부동소수 텍스처 확장을 숨기면 MediaPipe GPU 추론이 실패한다 (WebGL2 자체는 동작). 이 헤드리스 Chrome에서는
// GPU가 실제로 동작하므로 대체 경로는 이렇게 흉내 내야만 볼 수 있다.
import { expect, test } from '@playwright/test';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectDetections, grid, installQa2, probe2, save2, shot2 } from './qa-p2-helpers';

useFakeCamera('still-1face.y4m');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype as unknown as { getExtension: (n: string) => unknown; getSupportedExtensions: () => string[] | null };
    const ge = proto.getExtension;
    const gs = proto.getSupportedExtensions;
    proto.getExtension = function (this: unknown, n: string) {
      return /float/i.test(n) ? null : ge.call(this, n);
    };
    proto.getSupportedExtensions = function (this: unknown) {
      return (gs.call(this) ?? []).filter((n) => !/float/i.test(n));
    };
  });
});

test('P2-5 GPU 실패 → CPU 대체를 보고, 첫 프레임부터 모자이크, GPU를 다시 골라도 다시 대체·보고', async ({ page }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  await installQa2(page);
  await page.goto('/');
  // P3: init script는 메인 스레드에만 걸린다. 이 P2 테스트는 메인 스레드 검출기로 본다 (Worker 쪽은 switching.spec).
  await page.evaluate(() => window.__am.set('location', 'main'));
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1, undefined, { timeout: 20_000 });
  const first = await snapshot(page);
  const p = await page.evaluate(() => window.__am.params());
  const r = first.regions[0]!;
  const g = grid(r, String(p.blockMode), Number(p.blockSize), Number(p.blockCells));
  const firstBlocks = await page.evaluate(([r, c, rr]) => window.__qa2.blockCheck(r, c, rr), [r, g.cols, g.rows] as const);
  await page.waitForTimeout(400); // 모니터는 250ms마다 갱신
  const ui = async (): Promise<{ detector: string | null; monitor: string[] }> => ({
    detector: await page.locator('#detector').textContent(),
    monitor: await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.panel input')].map((i) => i.value).filter((v) => /CPU|GPU/.test(v))),
  });
  const ui1 = await ui();
  const shots = [await shot2(page, 'p2-19-gpu-fallback-cpu')];

  await page.evaluate(() => window.__am.set('delegate', 'CPU'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready' && window.__am.snapshot().delegateFallback === null);
  const asCpu = await snapshot(page);
  await page.waitForTimeout(400);
  const ui2 = await ui();
  await page.evaluate(() => window.__am.set('delegate', 'GPU'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready' && window.__am.snapshot().delegateFallback !== null, undefined, { timeout: 20_000 });
  const frames = await collectDetections(page, 4);
  const again = await snapshot(page);
  await page.waitForTimeout(400);
  const ui3 = await ui();
  const pr = await probe2(page);

  const ev = {
    requested: p.delegate,
    first: { activeDelegate: first.activeDelegate, fallback: first.delegateFallback?.slice(0, 160), detections: first.detections.length, drawn: first.drawnFrameId, det: first.detectionFrameId, blocks: firstBlocks },
    ui1,
    explicitCpu: { activeDelegate: asCpu.activeDelegate, fallback: asCpu.delegateFallback },
    ui2,
    gpuAgain: { activeDelegate: again.activeDelegate, fallback: again.delegateFallback?.slice(0, 160), counts: frames.map((f) => f.count) },
    ui3,
    drawnUnanalysed: pr.drawnUnanalysed,
    shots,
  };
  save2('qa-p2-5-fallback', ev);
  console.log('[P2-5 fallback]', JSON.stringify(ev));

  expect(p.delegate).toBe('GPU');
  expect(first.activeDelegate).toBe('CPU');
  expect(first.delegateFallback).toBeTruthy();
  expect(first.detections).toHaveLength(1);
  expect(first.drawnFrameId).toBe(first.detectionFrameId);
  expect(firstBlocks.uniformFrac).toBeGreaterThanOrEqual(0.98);
  expect(ui1.detector).toContain('CPU');
  expect(ui1.detector).toMatch(/GPU.*CPU/);
  expect(ui1.monitor).toContain('CPU (GPU fallback)');
  expect(asCpu.activeDelegate).toBe('CPU');
  expect(ui2.monitor).toContain('CPU');
  expect(again.activeDelegate).toBe('CPU');
  expect(again.delegateFallback).toBeTruthy();
  expect(ui3.monitor).toContain('CPU (GPU fallback)');
  expect(frames.every((f) => f.count === 1)).toBe(true);
  expect(pr.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
});
