import { expect, test, type Page } from '@playwright/test';
import { iou } from '../../src/core/geometry';
import type { AmSnapshot } from '../../src/test-hook';
import { collectPageErrors, isMediaPipeLog, snapshot, startApp, useFakeCamera } from './helpers';
import { nextFrames, regionStats, toCanvasRect } from './pixels';

// P3 검출 Worker: 기본 실행 위치, 프레임 transfer, 메인 스레드 롱태스크, 실행 위치·장치 전환, Worker 오류 전달.
useFakeCamera('still-1face.y4m');

const P2_BOX = { x: 215, y: 119, width: 224, height: 224 }; // P2(메인 스레드)에서 잰 정지 1인 박스

// 앱이 남긴 콘솔 오류·경고 (MediaPipe WASM 자체 로그는 뺀다)
function collectAppWarnings(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !isMediaPipeLog(m.text())) out.push(m.text());
  });
  return out;
}

function waitDetector(page: Page, location: 'worker' | 'main'): Promise<unknown> {
  return page.waitForFunction((loc) => {
    const s = window.__am.snapshot();
    return s.detectorState === 'ready' && s.location === loc;
  }, location);
}

test('기본 실행 위치는 Worker, 프레임은 복사하지 않고 transfer, 검출 결과는 P2(메인 스레드)와 같다', async ({ page }) => {
  const errors = collectPageErrors(page);
  // 메인 → Worker로 보낸 프레임: transfer 목록에 있고, 보낸 뒤 메인에서는 떼어진다 (width 0)
  await page.addInitScript(() => {
    const w = window as unknown as { __xfer: { sent: number; inTransferList: number; detached: number } };
    w.__xfer = { sent: 0, inTransferList: 0, detached: 0 };
    const post = Worker.prototype.postMessage as (this: Worker, msg: unknown, transfer?: unknown) => void;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, transfer?: unknown): void {
      const frame = (msg as { frame?: unknown } | null)?.frame;
      post.call(this, msg, transfer);
      if (!(frame instanceof ImageBitmap)) return;
      w.__xfer.sent++;
      if (Array.isArray(transfer) && transfer.includes(frame)) w.__xfer.inTransferList++;
      if (frame.width === 0 && frame.height === 0) w.__xfer.detached++;
    } as typeof Worker.prototype.postMessage;
  });
  await startApp(page);
  await nextFrames(page, 3);
  const s = await snapshot(page);
  const xfer = await page.evaluate(() => (window as unknown as { __xfer: { sent: number; inTransferList: number; detached: number } }).__xfer);
  console.log('[worker default]', JSON.stringify({ location: s.location, delegate: s.activeDelegate, workers: s.workers, box: s.detections[0]?.box, score: s.detections[0]?.score, inferenceMs: s.inferenceMs, xfer }));
  expect(await page.evaluate(() => window.__am.get('location'))).toBe('worker');
  expect(s.location).toBe('worker');
  expect(s.workers.live).toBe(1);
  expect(page.workers()).toHaveLength(1);
  expect(['GPU', 'CPU']).toContain(s.activeDelegate);
  expect(s.detections).toHaveLength(1);
  expect(s.detections[0]!.score).toBeGreaterThanOrEqual(0.5);
  expect(iou(s.detections[0]!.box, P2_BOX)).toBeGreaterThan(0.9);
  expect(s.drawnFrameId).toBe(s.detectionFrameId);
  expect((await regionStats(page, await toCanvasRect(page, s.regions[0]!))).flat).toBeGreaterThan(0.9);
  expect(xfer.sent).toBeGreaterThanOrEqual(s.frameCount);
  expect(xfer.inTransferList).toBe(xfer.sent);
  expect(xfer.detached).toBe(xfer.sent);
  await expect(page.locator('#detector')).toContainText('Worker');
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.panel input')].map((i) => i.value))).toContain('Worker');
  expect(errors).toEqual([]);
});

test('메인 스레드 롱태스크(>50ms): Worker 실행은 워밍업 뒤 10초 동안 0개 (메인 스레드 실행 수도 기록)', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  await startApp(page);
  const measure = async (): Promise<Record<string, unknown> & { longTasks: number; frames: number }> => {
    await page.waitForTimeout(1500); // 워밍업 (첫 GPU 추론 등)
    const t0 = await page.evaluate(() => performance.now());
    const before = await snapshot(page);
    await page.waitForTimeout(10_000);
    const after = await snapshot(page);
    const inWindow = after.longTasks.recent.filter((t) => t.startMs >= t0);
    return {
      location: after.location,
      delegate: after.activeDelegate,
      longTasks: after.longTasks.count - before.longTasks.count,
      maxMs: Math.max(0, ...inWindow.map((t) => Math.round(t.durationMs))),
      frames: after.frameCount - before.frameCount,
      inferenceMs: Math.round(after.inferenceMs * 10) / 10,
      inferenceFps: Math.round(after.inferenceFps * 10) / 10,
    };
  };
  const worker = await measure();
  await page.evaluate(() => window.__am.set('location', 'main'));
  await waitDetector(page, 'main');
  const main = await measure();
  console.log('[long tasks 10s]', JSON.stringify({ worker, main, sincePageLoad: (await snapshot(page)).longTasks }));
  expect(worker.location).toBe('worker');
  expect(main.location).toBe('main');
  expect(worker.frames).toBeGreaterThan(60); // 목표 8fps × 10초
  expect(main.frames).toBeGreaterThan(60);
  expect(worker.longTasks).toBe(0);
  expect(errors).toEqual([]);
});

test('실행 위치 Worker ↔ 메인, 실행 장치 GPU ↔ CPU를 3번씩 바꿔도 오류 없이 검출하고, 이전 Worker는 끝난다', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  const warnings = collectAppWarnings(page);
  const events = { started: 0, closed: 0 };
  page.on('worker', (w) => {
    events.started++;
    w.on('close', () => events.closed++);
  });
  await startApp(page);
  const first = await snapshot(page);
  const seq0 = (await page.evaluate(() => window.__am.renders().at(-1)?.seq)) ?? 0;
  const steps: Record<string, unknown>[] = [];
  for (let round = 0; round < 3; round++) {
    for (const [key, value] of [
      ['location', 'main'],
      ['delegate', 'CPU'],
      ['location', 'worker'],
      ['delegate', 'GPU'],
    ] as const) {
      await page.evaluate(([k, v]) => window.__am.set(k, v), [key, value] as const);
      const location = key === 'location' ? value : (steps.at(-1)?.location as string | undefined) ?? 'worker';
      await waitDetector(page, location as 'worker' | 'main');
      await nextFrames(page, 2);
      const s: AmSnapshot = await snapshot(page);
      const live = location === 'worker' ? 1 : 0;
      await expect.poll(() => page.workers().length, { message: `${round} ${key}=${value}` }).toBe(live);
      steps.push({ round, set: `${key}=${value}`, location: s.location, delegate: s.activeDelegate, fallback: s.delegateFallback !== null, live: s.workers.live, detections: s.detections.length });
      expect(s.location).toBe(location);
      expect(s.workers.live).toBe(live);
      expect(s.detections).toHaveLength(1);
      if (key === 'delegate' && !s.delegateFallback) expect(s.activeDelegate).toBe(value);
    }
  }
  const end = await snapshot(page);
  const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
  console.log('[switch x3]', JSON.stringify({ steps, workers: end.workers, events, renders: renders.length }));
  expect(end.workers.created - first.workers.created).toBe(3); // Worker로 돌아갈 때마다 하나
  expect(end.workers.live).toBe(1);
  expect(events.closed).toBe(events.started - 1);
  // 전환하는 동안에도 동기 표시: 그린 프레임 = 검출한 프레임
  expect(renders.length).toBeGreaterThan(20);
  for (const r of renders) expect([r.mode, r.frameId, r.fullCover]).toEqual(['sync', r.detectionFrameId, false]);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});

test('실행 위치를 기다리지 않고 10번 번갈아 바꿔도 마지막 값으로 정착하고 Worker가 남지 않는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.__am.set('location', i % 2 ? 'worker' : 'main');
    window.__am.set('location', 'main');
  });
  await waitDetector(page, 'main');
  await nextFrames(page, 2);
  let s = await snapshot(page);
  expect(s.workers.live).toBe(0);
  await expect.poll(() => page.workers().length).toBe(0);
  expect(s.detections).toHaveLength(1);
  await page.evaluate(() => window.__am.set('location', 'worker'));
  await waitDetector(page, 'worker');
  await nextFrames(page, 2);
  s = await snapshot(page);
  console.log('[rapid location]', JSON.stringify(s.workers));
  expect(s.workers.live).toBe(1);
  await expect.poll(() => page.workers().length).toBe(1);
  expect(s.detections).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('메인 스레드 초기화가 멈춰 있어도 실행 위치를 Worker로 바꾸면 기다리지 않고 Worker로 바뀐다', async ({ page }) => {
  const errors = collectPageErrors(page);
  // 메인 스레드만 쓰는 클래식 WASM 로더를 6초 늦춘다 (Worker는 ES 모듈 로더를 쓴다)
  await page.route('**/wasm/vision_wasm_internal.js', async (route) => {
    await new Promise((r) => setTimeout(r, 6000));
    await route.continue().catch(() => {}); // 테스트가 먼저 끝났으면 무시
  });
  await startApp(page);
  await waitDetector(page, 'worker');
  await page.evaluate(() => window.__am.set('location', 'main'));
  await page.waitForTimeout(500); // 메인 초기화가 로더에서 멈춰 있다
  expect((await snapshot(page)).detectorState).toBe('loading');
  const t0 = Date.now();
  await page.evaluate(() => window.__am.set('location', 'worker'));
  await waitDetector(page, 'worker');
  const ms = Date.now() - t0;
  await nextFrames(page, 2);
  const s = await snapshot(page);
  console.log('[stuck main → worker]', JSON.stringify({ ms, workers: s.workers }));
  expect(ms).toBeLessThan(4000); // 메인 로더(6초)를 기다리지 않는다
  expect(s.workers.live).toBe(1);
  expect(s.detections).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('Worker 안의 잡히지 않은 오류는 화면 상태에 나오고(조용히 묻히지 않는다), 다시 불러오면 회복한다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const before = await snapshot(page);
  const rect = await toCanvasRect(page, before.regions[0]!);

  // 시험용 훅: Worker 안에서 setTimeout으로 던진다
  expect(await page.evaluate(() => window.__am.fault('crash'))).toBe(true);
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
  let s = await snapshot(page);
  console.log('[worker crash]', s.detectorError);
  expect(s.detectorError).toContain('Detector error: Detection worker error');
  expect(s.detectorError).toContain('Simulated worker error');
  await expect(page.locator('#detector')).toContainText('Detection worker error');
  await expect(page.locator('#stage-note')).toHaveText('Detector error — the view is not updated.');
  expect(s.workers.live).toBe(0);
  await expect.poll(() => page.workers().length).toBe(0);
  expect(s.failClosed).toBe(true);
  // 동기 표시: 마지막 분석 프레임(모자이크)이 남는다
  expect(s.drawnFrameId).toBe(s.detectionFrameId);
  expect((await regionStats(page, rect)).flat).toBeGreaterThan(0.9);

  // 회복
  expect(await page.evaluate(() => window.__am.fault('none'))).toBe(true);
  await waitDetector(page, 'worker');
  await nextFrames(page, 2);
  s = await snapshot(page);
  expect(s.detections).toHaveLength(1);
  expect(s.failClosed).toBe(false);
  await expect(page.locator('#stage-note')).toBeHidden();

  // 앱 훅이 아닌 실제 Worker 전역에서 던져도 같다
  await page.workers()[0]!.evaluate(() => {
    setTimeout(() => {
      throw new Error('바깥에서 낸 오류');
    });
  });
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
  s = await snapshot(page);
  expect(s.detectorError).toContain('바깥에서 낸 오류');
  await expect(page.locator('#detector')).toContainText('바깥에서 낸 오류');
  expect(errors).toEqual([]);
});
