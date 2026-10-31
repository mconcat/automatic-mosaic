// QA P3 (정지 1인 픽스처): 기본 Worker(1), 롱태스크(2), 동기·비동기 표시(3), fail-closed(4), 실행 위치·장치 전환(5), Worker 오류 전달(6).
// 근거는 window.__am 수치, 캔버스 픽셀(qa-p3-helpers 표본), 앱과 따로 센 Worker 생성·종료와 롱태스크, 요청 기록이다.
import { expect, test, type Page } from '@playwright/test';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole, recordRequests } from './qa-helpers';
import { appConsoleProblems, collectDetections } from './qa-p2-helpers';
import {
  FACE,
  READABLE_TEXT,
  P2_BOX,
  containsRect,
  hookSet,
  installQa3,
  iou,
  onEachWorker,
  qa3,
  save3,
  setInWorkers,
  shot3,
  startRunning,
  startSampler,
  stopSampler,
  summarize,
  waitReady,
  workerPatch,
  type Sample3,
} from './qa-p3-helpers';

useFakeCamera('still-1face.y4m');

const FACE_MIN = 0.9; // 얼굴 영역 평평함 하한 (모자이크 ≈ 0.98, 원본 ≈ 0.6 — 비동기 테스트에서 함께 잰다)

async function lastSeq(page: Page): Promise<number> {
  return (await page.evaluate(() => window.__am.renders().at(-1)?.seq)) ?? 0;
}

async function sampleFor(page: Page, ms: number): Promise<Sample3[]> {
  await startSampler(page);
  await page.waitForTimeout(ms);
  return stopSampler(page);
}

function drawnSamples(xs: Sample3[]): Sample3[] {
  return xs.filter((x) => x.face >= 0);
}

test('P3-1 기본 실행 위치는 Worker, 정지 1인 검출이 P2와 같다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await page.goto('/');
  const before = { location: await page.evaluate(() => window.__am.get('location')), displayMode: await page.evaluate(() => window.__am.get('displayMode')) };
  await waitReady(page, 'worker');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 3);
  const frames = await collectDetections(page, 16);
  const s = await snapshot(page);
  const q = await qa3(page);
  const d = s.detections[0]!;
  const detectorText = await page.locator('#detector').textContent();
  const panelValues = await page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.panel input, .panel select')].map((i) => (i instanceof HTMLSelectElement ? i.selectedOptions[0]?.textContent : i.value)));
  const shots = [await shot3(page, 'p3-01-worker-still'), await shot3(page, 'p3-01b-worker-still-canvas', { canvasOnly: true })];
  const evidence = {
    before,
    snapshot: { location: s.location, activeDelegate: s.activeDelegate, workers: s.workers, displayMode: s.displayMode, inferenceMs: s.inferenceMs, inferenceFps: s.inferenceFps, renderFps: s.renderFps },
    qa3: { workers: q.workers, live: q.live, frames: q.frames },
    pageWorkers: page.workers().map((w) => w.url()),
    frames,
    detection: d,
    region: s.regions,
    iouP2: iou(d.box, P2_BOX),
    regionContainsFace: containsRect(s.regions[0]!, FACE),
    detectorText,
    panelHasWorker: panelValues.includes('Worker'),
    shots,
  };
  save3('qa-p3-1-still-worker', evidence);
  console.log('[P3-1 still]', JSON.stringify(evidence));

  expect(before).toEqual({ location: 'worker', displayMode: 'sync' });
  expect(s.location).toBe('worker');
  expect(s.workers.live).toBe(1);
  expect(q.workers.constructed).toBe(1);
  expect(q.live).toBe(1);
  expect(page.workers()).toHaveLength(1);
  expect(detectorText).toContain('Worker');
  expect(evidence.panelHasWorker).toBe(true);
  for (const f of frames) {
    expect(f.count, `frame ${f.frameId}`).toBe(1);
    expect(f.scores[0]!, `frame ${f.frameId}`).toBeGreaterThanOrEqual(0.5);
  }
  expect(evidence.iouP2).toBeGreaterThan(0.9);
  expect(evidence.regionContainsFace).toBe(true);
  // 검출이 Worker에서 돌았다: 메인에서 보낸(transfer) 프레임만 그렸다
  expect(q.frames.analysed).toBeGreaterThanOrEqual(s.frameCount);
  expect(q.frames.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});

test('P3-2 메인 스레드 롱태스크: 정상 상태·무거운 추론 흉내·모델 전환을 Worker와 메인에서 센다', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  const wp = onEachWorker(page, workerPatch);
  await startRunning(page);
  await wp.applied();

  const measure = async (label: string, ms = 10_000): Promise<Record<string, unknown> & { longTasks: number; hookDelta: number; frames: number; maxMs: number }> => {
    await page.waitForTimeout(2000); // 워밍업
    const t0 = await page.evaluate(() => performance.now());
    const s0 = await snapshot(page);
    const q0 = await qa3(page);
    await page.waitForTimeout(ms);
    const s1 = await snapshot(page);
    const q1 = await qa3(page);
    const tasks = q1.longTasks.filter((t) => t.startMs >= t0);
    return {
      label,
      location: s1.location,
      delegate: s1.activeDelegate,
      seconds: ms / 1000,
      longTasks: tasks.length,
      hookDelta: s1.longTasks.count - s0.longTasks.count,
      maxMs: Math.max(0, ...tasks.map((t) => Math.round(t.durationMs))),
      durations: tasks.slice(0, 15).map((t) => Math.round(t.durationMs)),
      rafGapsOver50: q1.rafGaps.length - q0.rafGaps.length,
      frames: s1.frameCount - s0.frameCount,
      inferenceFps: Math.round(s1.inferenceFps * 10) / 10,
      inferenceMs: Math.round(s1.inferenceMs * 10) / 10,
      dropped: s1.droppedFrames - s0.droppedFrames,
    };
  };
  // 모델을 바꾼 순간부터 준비 + 2초까지의 롱태스크 (메인이면 첫 GPU 추론이 메인 스레드에서 돈다)
  const switchModel = async (label: string, model: string): Promise<Record<string, unknown>> => {
    const t0 = await page.evaluate(() => performance.now());
    expect(await hookSet(page, 'model', model)).toBe(true);
    await waitReady(page);
    await page.waitForFunction(() => window.__am.snapshot().detections.length === 1);
    const readyAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(2000);
    const q = await qa3(page);
    const tasks = q.longTasks.filter((t) => t.startMs >= t0);
    return { label, model, readyMs: Math.round(readyAt - t0), longTasks: tasks.length, durations: tasks.map((t) => Math.round(t.durationMs)) };
  };

  const results: Record<string, unknown>[] = [];
  const worker = await measure('worker 정상 상태');
  results.push(worker);
  await setInWorkers(page, { __qaBusyMs: 80 });
  const workerBusy = await measure('worker 추론마다 80ms 바쁜 대기');
  results.push(workerBusy);
  await setInWorkers(page, { __qaBusyMs: 0 });
  const workerFull = await switchModel('worker short→full', 'mediapipe-face-full');
  results.push(workerFull, await switchModel('worker full→short', 'mediapipe-face-short'));

  expect(await hookSet(page, 'location', 'main')).toBe(true);
  await waitReady(page, 'main');
  const main = await measure('main 정상 상태');
  results.push(main);
  await page.evaluate(() => window.__qa3.setBusy(80));
  const mainBusy = await measure('main 추론마다 80ms 바쁜 대기');
  results.push(mainBusy);
  await page.evaluate(() => window.__qa3.setBusy(0));
  const mainFull = await switchModel('main short→full', 'mediapipe-face-full');
  results.push(mainFull);
  const end = await snapshot(page);
  const evidence = { results, sincePageLoad: end.longTasks, uploadsInWorker: await Promise.all(wp.workers.map((w) => w.evaluate(() => (self as unknown as { __qaUploads?: number }).__qaUploads).catch(() => 'closed'))) };
  save3('qa-p3-2-long-tasks', evidence);
  console.log('[P3-2 long tasks]', JSON.stringify(evidence));

  expect(worker.location).toBe('worker');
  expect(main.location).toBe('main');
  expect(worker.frames).toBeGreaterThan(60);
  expect(main.frames).toBeGreaterThan(60);
  // 기준: Worker 실행은 워밍업 뒤 추론 때문에 생기는 롱태스크가 없다 (추론이 무거워도)
  expect(worker.longTasks).toBe(0);
  expect(worker.hookDelta).toBe(0);
  expect(workerBusy.longTasks).toBe(0);
  expect(workerBusy.frames).toBeGreaterThan(40);
  expect(workerFull.longTasks).toBe(0);
  // 같은 무거운 추론을 메인에서 돌리면 추론마다 롱태스크가 생긴다 (측정이 롱태스크를 잡을 수 있다는 대조군)
  expect(mainBusy.longTasks).toBeGreaterThan(30);
  expect(mainBusy.maxMs).toBeGreaterThanOrEqual(80);
  expect(errors).toEqual([]);
});

test('P3-3 동기 표시: 그린 프레임마다 drawn == detection (Worker 8fps, Worker 15fps, 메인 8fps)', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  const runs: Record<string, unknown>[] = [];
  for (const cfg of [
    { location: 'worker', fps: 8 },
    { location: 'worker', fps: 15 },
    { location: 'main', fps: 8 },
  ] as const) {
    await hookSet(page, 'location', cfg.location);
    await hookSet(page, 'targetFps', cfg.fps);
    await waitReady(page, cfg.location);
    await page.waitForTimeout(1500);
    const seq0 = await lastSeq(page);
    const q0 = await qa3(page);
    const samples = await sampleFor(page, 4000);
    const s = await snapshot(page);
    const q1 = await qa3(page);
    const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
    const drawn = drawnSamples(samples);
    const run = {
      ...cfg,
      renders: renders.length,
      mismatched: renders.filter((r) => r.mode !== 'sync' || r.fullCover || r.frameId !== r.detectionFrameId).length,
      rafSamples: drawn.length,
      rafMismatch: drawn.filter((x) => x.drawn !== x.detFrame).length,
      minFace: Math.min(...drawn.map((x) => x.face)),
      noDetection: drawn.filter((x) => x.dets !== 1).length,
      drawnUnanalysed: q1.frames.drawnUnanalysed - q0.frames.drawnUnanalysed,
      drawCalls: q1.frames.drawn - q0.frames.drawn,
      renderFps: Math.round(s.renderFps * 10) / 10,
      inferenceFps: Math.round(s.inferenceFps * 10) / 10,
    };
    runs.push(run);
    expect(run.renders, JSON.stringify(cfg)).toBeGreaterThan(cfg.fps * 4 * 0.6);
    expect(run.mismatched, JSON.stringify(cfg)).toBe(0);
    expect(run.rafMismatch, JSON.stringify(cfg)).toBe(0);
    expect(run.minFace, JSON.stringify(cfg)).toBeGreaterThan(FACE_MIN);
    expect(run.noDetection, JSON.stringify(cfg)).toBe(0);
    expect(run.drawnUnanalysed, JSON.stringify(cfg)).toBe(0);
    expect(Math.abs(run.renderFps - run.inferenceFps), JSON.stringify(cfg)).toBeLessThan(1.5);
  }
  await hookSet(page, 'location', 'worker');
  await waitReady(page, 'worker');
  const shots = [await shot3(page, 'p3-02-sync-worker')];
  save3('qa-p3-3-sync', { runs, shots });
  console.log('[P3-3 sync]', JSON.stringify(runs));
  expect(errors).toEqual([]);
});

test('P3-3 비동기 표시: 렌더 FPS가 추론 FPS보다 확실히 크고, 박스가 얼굴을 계속 가린다', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await startRunning(page);
  // 대조군: 강도 0(모자이크 없음)이면 같은 측정에서 얼굴 영역 평평함이 낮다
  await hookSet(page, 'strength', 0);
  await page.waitForTimeout(400);
  const rawFace = await page.evaluate((f) => window.__qa3.flatness(f), FACE);
  await hookSet(page, 'strength', 1);
  expect(await hookSet(page, 'displayMode', 'async')).toBe(true);
  await page.waitForTimeout(2000);
  const seq0 = await lastSeq(page);
  const samples = await sampleFor(page, 5000);
  const s = await snapshot(page);
  const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
  const drawn = drawnSamples(samples);
  const frameIds = new Set(renders.map((r) => r.frameId));
  const detIds = new Set(renders.map((r) => r.detectionFrameId).filter((x) => x !== null));
  const lags = renders.filter((r) => r.detectionFrameId !== null).map((r) => r.frameId - r.detectionFrameId!);
  const shots = [await shot3(page, 'p3-03-async'), await shot3(page, 'p3-03b-async-canvas', { canvasOnly: true })];
  await hookSet(page, 'debug', true);
  await page.waitForTimeout(300);
  shots.push(await shot3(page, 'p3-03c-async-debug'));
  await hookSet(page, 'debug', false);
  const evidence = {
    renderFps: s.renderFps,
    inferenceFps: s.inferenceFps,
    ratio: s.renderFps / s.inferenceFps,
    renders: renders.length,
    distinctFrames: frameIds.size,
    distinctDetectionFrames: detIds.size,
    modes: [...new Set(renders.map((r) => r.mode))],
    coverRenders: renders.filter((r) => r.fullCover).length,
    lagFrames: { min: Math.min(...lags), max: Math.max(...lags) },
    detectionAfterFrame: renders.filter((r) => r.detectionFrameId !== null && r.detectionFrameId > r.frameId).length,
    region: s.regions,
    regionContainsFace: s.regions.length === 1 && containsRect(s.regions[0]!, FACE),
    rawFaceFlatness: rawFace,
    samples: summarize(samples),
    minFaceDrawn: Math.min(...drawn.map((x) => x.face)),
    shots,
  };
  save3('qa-p3-3-async', evidence);
  console.log('[P3-3 async]', JSON.stringify(evidence));
  expect(s.displayMode).toBe('async');
  expect(evidence.modes).toEqual(['async']);
  expect(s.renderFps).toBeGreaterThan(12);
  expect(evidence.ratio).toBeGreaterThan(1.5);
  expect(evidence.distinctFrames).toBeGreaterThan(evidence.distinctDetectionFrames * 1.5);
  expect(evidence.detectionAfterFrame).toBe(0);
  expect(evidence.coverRenders).toBe(0);
  expect(evidence.regionContainsFace).toBe(true);
  expect(rawFace).toBeLessThan(0.8); // 원본 얼굴은 평평하지 않다 → 아래 하한이 원본 노출을 잡는다
  expect(evidence.minFaceDrawn).toBeGreaterThan(FACE_MIN);
  expect(drawn.length).toBeGreaterThan(100);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});

// fail-closed: 고장 → 표본 → 회복 → 표본
async function faultScenario(
  page: Page,
  opts: { mode: 'sync' | 'async'; inject: () => Promise<void>; recover: () => Promise<void>; faultMs: number; name: string },
): Promise<{ baseline: Sample3[]; during: Sample3[]; after: Sample3[]; afterSnap: Awaited<ReturnType<typeof snapshot>>; duringSnap: Awaited<ReturnType<typeof snapshot>>; detectorDuring: string | null; injectAt: number }> {
  await hookSet(page, 'displayMode', opts.mode);
  await page.waitForTimeout(1500);
  const baseline = await sampleFor(page, 800);
  await startSampler(page);
  await page.waitForTimeout(100);
  const injectAt = await page.evaluate(() => performance.now());
  await opts.inject();
  await page.waitForTimeout(opts.faultMs);
  const duringSnap = await snapshot(page);
  const detectorDuring = await page.locator('#detector').textContent();
  await shot3(page, `${opts.name}-during`);
  const during = await stopSampler(page);
  await startSampler(page);
  await opts.recover();
  await page.waitForFunction(() => {
    const s = window.__am.snapshot();
    return s.detectorState === 'ready' && s.failReason === null && s.detections.length === 1;
  }, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const after = await stopSampler(page);
  const afterSnap = await snapshot(page);
  await shot3(page, `${opts.name}-after`);
  return { baseline, during, after, afterSnap, duringSnap, detectorDuring, injectAt };
}

function recoveredFrames(after: Sample3[]): number {
  const last1500 = after.filter((x) => x.t >= (after.at(-1)?.t ?? 0) - 1500);
  return (last1500.at(-1)?.frameCount ?? 0) - (last1500[0]?.frameCount ?? 0);
}

for (const mode of ['sync', 'async'] as const) {
  test(`P3-4 fail-closed ${mode}: 검출 지연(fault delay)·검출 실패(fault error) 동안 얼굴이 계속 가려지고 한국어 안내, 회복하면 정상`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors = collectPageErrors(page);
    await installQa3(page);
    await startRunning(page);
    const out: Record<string, unknown> = {};

    // 1) 지연: 검출마다 3초
    const delay = await faultScenario(page, {
      mode,
      name: `p3-04-${mode}-delay`,
      faultMs: 3500,
      inject: async () => void (await page.evaluate(() => window.__am.fault('delay', 3000))),
      recover: async () => void (await page.evaluate(() => window.__am.fault('none'))),
    });
    // 2) 실패: 검출이 오류를 낸다 (검출기 오류 상태)
    const fail = await faultScenario(page, {
      mode,
      name: `p3-05-${mode}-error`,
      faultMs: 2000,
      inject: async () => void (await page.evaluate(() => window.__am.fault('error'))),
      recover: async () => void (await page.evaluate(() => window.__am.fault('none'))),
    });
    for (const [name, r] of [
      ['delay', delay],
      ['error', fail],
    ] as const) {
      const during = drawnSamples(r.during);
      const lateDuring = r.during.filter((x) => x.at > r.injectAt + 1500);
      const uncoveredLate = lateDuring.filter((x) => !x.cover).map((x) => ({ sinceInject: Math.round(x.at - r.injectAt), reason: x.reason, drawn: x.drawn, detFrame: x.detFrame, det: x.det }));
      out[name] = {
        baseline: summarize(r.baseline),
        during: summarize(r.during),
        after: summarize(r.after),
        duringSnap: { failReason: r.duringSnap.failReason, failClosed: r.duringSnap.failClosed, fullCover: r.duringSnap.fullCover, regions: r.duringSnap.regions, detectorState: r.duringSnap.detectorState, workers: r.duringSnap.workers },
        detectorDuring: r.detectorDuring,
        frameCountChangeLateDuring: (lateDuring.at(-1)?.frameCount ?? 0) - (lateDuring[0]?.frameCount ?? 0),
        coverLateDuring: lateDuring.filter((x) => x.cover).length,
        lateDuringSamples: lateDuring.length,
        uncoveredLate: uncoveredLate.slice(0, 30),
        coverStartsAfterInjectMs: Math.round((r.during.find((x) => x.cover && x.at > r.injectAt)?.at ?? NaN) - r.injectAt),
        recoveredFrames: recoveredFrames(r.after),
        afterSnap: { failReason: r.afterSnap.failReason, detections: r.afterSnap.detections.length, fullCover: r.afterSnap.fullCover, drawn: r.afterSnap.drawnFrameId, det: r.afterSnap.detectionFrameId, renderFps: r.afterSnap.renderFps, workers: r.afterSnap.workers },
      };
      save3(`qa-p3-4-fail-closed-${mode}`, out);
      if (mode === 'async' && uncoveredLate.length) console.log(`[P3-4 ${mode} ${name} UNCOVERED]`, JSON.stringify({ injectAt: r.injectAt, uncoveredLate: uncoveredLate.slice(0, 40), coverStarts: (out[name] as { coverStartsAfterInjectMs: number }).coverStartsAfterInjectMs }));
      // 원본 프레임이 보이지 않는다: 고장 중 모든 표본에서 얼굴 영역이 가려져 있다
      expect(during.length, name).toBeGreaterThan(30);
      expect(Math.min(...during.map((x) => x.face)), name).toBeGreaterThan(FACE_MIN);
      expect(Math.min(...drawnSamples(r.after).map((x) => x.face)), name).toBeGreaterThan(FACE_MIN);
      // 한국어 안내
      const notes = r.during.map((x) => x.note).filter((x): x is string => x !== null);
      expect(notes.length, name).toBeGreaterThan(0);
      for (const n of notes) expect(n, name).toMatch(READABLE_TEXT);
      expect(r.duringSnap.failClosed, name).toBe(true);
      if (mode === 'sync') {
        // 동기: 새 프레임을 그리지 않는다 (마지막 분석 프레임 유지)
        expect((out[name] as { frameCountChangeLateDuring: number }).frameCountChangeLateDuring, name).toBeLessThanOrEqual(1);
        expect(r.during.some((x) => x.note?.includes(name === 'delay' ? 'Detection is late' : 'Detector error'))).toBe(true);
      } else {
        // 비동기: 화면 전체를 가린다
        expect((out[name] as { coverLateDuring: number }).coverLateDuring, name).toBe((out[name] as { lateDuringSamples: number }).lateDuringSamples);
        expect(r.duringSnap.fullCover, name).toBe(true);
        expect(r.duringSnap.regions, name).toEqual([{ x: 0, y: 0, width: 640, height: 480 }]);
        expect(Math.min(...lateDuring.filter((x) => x.face >= 0).map((x) => x.whole)), name).toBeGreaterThan(0.95);
        expect(r.during.some((x) => x.note?.includes('covering the whole frame'))).toBe(true);
      }
      if (name === 'error') {
        expect(r.duringSnap.detectorState).toBe('error');
        expect(r.detectorDuring).toContain('Simulated detection failure');
        expect(r.detectorDuring).toMatch(READABLE_TEXT);
      }
      // 회복: 다시 새 프레임을 그리고, 결과를 믿을 수 있고, 얼굴 1개
      expect(r.afterSnap.failReason, name).toBeNull();
      expect(r.afterSnap.fullCover, name).toBe(false);
      expect(r.afterSnap.detections, name).toHaveLength(1);
      expect((out[name] as { recoveredFrames: number }).recoveredFrames, name).toBeGreaterThanOrEqual(mode === 'sync' ? 8 : 15);
      if (mode === 'sync') expect(r.afterSnap.drawnFrameId, name).toBe(r.afterSnap.detectionFrameId);
    }
    save3(`qa-p3-4-fail-closed-${mode}`, out);
    console.log(`[P3-4 ${mode}]`, JSON.stringify(out));
    expect(errors).toEqual([]);
  });
}

test('P3-4 fail-closed: 실제 불러오기 지연(모델 2.5초)과 모델 404 동안 원본을 보이지 않고, 회복한다', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  let fullMode: 'delay' | '404' = 'delay';
  await page.route('**/blaze_face_full_range.tflite', async (route) => {
    if (fullMode === '404') return route.fulfill({ status: 404, body: 'not found' });
    await new Promise((r) => setTimeout(r, 2500));
    return route.continue();
  });
  await startRunning(page);
  const out: Record<string, unknown> = {};
  for (const mode of ['async', 'sync'] as const) {
    // 지연: short → full (불러오는 중)
    fullMode = 'delay';
    const r = await faultScenario(page, {
      mode,
      name: `p3-06-${mode}-model-slow`,
      faultMs: 1500,
      inject: async () => void (await hookSet(page, 'model', 'mediapipe-face-full')),
      recover: async () => {},
    });
    const loadingSamples = r.during.filter((x) => x.det === 'loading');
    out[`${mode}-slow`] = { during: summarize(r.during), loadingSamples: loadingSamples.length, after: summarize(r.after), afterSnap: { detectorId: r.afterSnap.detectorId, location: r.afterSnap.location, detections: r.afterSnap.detections.length } };
    expect(loadingSamples.length, mode).toBeGreaterThan(30);
    expect(Math.min(...drawnSamples(r.during).map((x) => x.face)), mode).toBeGreaterThan(FACE_MIN);
    expect(r.during.some((x) => /loading detector/i.test(x.note ?? '')), mode).toBe(true);
    if (mode === 'async') expect(loadingSamples.filter((x) => x.face >= 0).every((x) => x.cover), mode).toBe(true);
    else expect(loadingSamples.at(-1)!.frameCount - loadingSamples[0]!.frameCount, mode).toBeLessThanOrEqual(1);
    expect(r.afterSnap.detectorId).toBe('mediapipe-face-full');
    // 404: short로 갔다가 full로 (실패) → short로 회복
    await hookSet(page, 'model', 'mediapipe-face-short');
    await waitReady(page);
    fullMode = '404';
    const f = await faultScenario(page, {
      mode,
      name: `p3-07-${mode}-model-404`,
      faultMs: 1500,
      inject: async () => void (await hookSet(page, 'model', 'mediapipe-face-full')),
      recover: async () => void (await hookSet(page, 'model', 'mediapipe-face-short')),
    });
    out[`${mode}-404`] = { during: summarize(f.during), detectorDuring: f.detectorDuring, duringSnap: { detectorState: f.duringSnap.detectorState, fullCover: f.duringSnap.fullCover, workers: f.duringSnap.workers }, after: summarize(f.after) };
    expect(f.duringSnap.detectorState, mode).toBe('error');
    expect(f.detectorDuring, mode).toContain('Failed to load detector');
    expect(Math.min(...drawnSamples(f.during).map((x) => x.face)), mode).toBeGreaterThan(FACE_MIN);
    if (mode === 'async') expect(f.duringSnap.fullCover).toBe(true);
    expect(f.afterSnap.detectorId).toBe('mediapipe-face-short');
    expect(recoveredFrames(f.after), mode).toBeGreaterThanOrEqual(8);
  }
  save3('qa-p3-4-real-loading', out);
  console.log('[P3-4 real]', JSON.stringify(out));
  expect(errors).toEqual([]);
});

test('P3-4 fail-closed: Worker 안에서 추론이 1.5초씩 걸릴 때(바쁜 대기) 원본을 보이지 않고, 메인 스레드는 막히지 않는다', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  const wp = onEachWorker(page, workerPatch);
  await startRunning(page);
  await wp.applied();
  const out: Record<string, unknown> = {};
  for (const mode of ['async', 'sync'] as const) {
    const t0 = await page.evaluate(() => performance.now());
    const r = await faultScenario(page, {
      mode,
      name: `p3-08-${mode}-worker-busy`,
      faultMs: 4000,
      inject: async () => void (await setInWorkers(page, { __qaBusyMs: 1500 })),
      recover: async () => void (await setInWorkers(page, { __qaBusyMs: 0 })),
    });
    const q = await qa3(page);
    const late = r.during.filter((x) => x.t > 2000);
    out[mode] = {
      during: summarize(r.during),
      lateCover: late.filter((x) => x.cover).length,
      late: late.length,
      after: summarize(r.after),
      longTasksOnMain: q.longTasks.filter((t) => t.startMs >= t0).map((t) => Math.round(t.durationMs)),
      inferenceMsDuring: r.duringSnap.inferenceMs,
    };
    expect(Math.min(...drawnSamples(r.during).map((x) => x.face)), mode).toBeGreaterThan(FACE_MIN);
    expect(r.during.some((x) => x.reason === 'stalled'), mode).toBe(true);
    if (mode === 'async') expect(late.every((x) => x.cover), mode).toBe(true);
    expect(r.during.some((x) => x.note !== null && READABLE_TEXT.test(x.note)), mode).toBe(true);
    expect((out[mode] as { longTasksOnMain: number[] }).longTasksOnMain, mode).toEqual([]);
    expect(recoveredFrames(r.after), mode).toBeGreaterThanOrEqual(8);
  }
  save3('qa-p3-4-worker-busy', out);
  console.log('[P3-4 worker busy]', JSON.stringify(out));
  expect(errors).toEqual([]);
});

test('P3-5 실행 위치 Worker ↔ 메인, 실행 장치 GPU ↔ CPU를 3바퀴 (마지막 바퀴는 패널 UI): 오류 없음, 이전 Worker 종료, 외부 요청 0', async ({ page, context }) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  const requests = await recordRequests(context);
  await installQa3(page);
  const pwEvents = { started: 0, closed: 0 };
  page.on('worker', (w) => {
    pwEvents.started++;
    w.on('close', () => pwEvents.closed++);
  });
  await startRunning(page);
  const seq0 = await lastSeq(page);
  const steps: Record<string, unknown>[] = [];
  let location: 'worker' | 'main' = 'worker';
  const selectInPanel = async (label: string, optionText: string): Promise<void> => {
    await page.getByLabel(label, { exact: true }).selectOption({ label: optionText });
  };
  for (let round = 0; round < 3; round++) {
    const ui = round === 2;
    for (const [key, value] of [
      ['location', 'main'],
      ['delegate', 'CPU'],
      ['location', 'worker'],
      ['delegate', 'GPU'],
    ] as const) {
      const f0 = (await snapshot(page)).frameCount;
      const r0 = await lastSeq(page);
      if (ui) {
        if (key === 'location') await selectInPanel('Run on', value === 'main' ? 'Main thread' : 'Worker');
        else await selectInPanel('Delegate', value);
      } else expect(await hookSet(page, key, value)).toBe(true);
      if (key === 'location') location = value;
      await waitReady(page, location);
      // 새 검출기가 분석한 프레임이 2개 더 그려질 때까지 (전환 전 마지막 프레임의 검출 결과로 통과하지 않게)
      await page.waitForFunction((n) => window.__am.snapshot().frameCount >= n && window.__am.snapshot().detections.length === 1, f0 + 2);
      const stepRenders = await page.evaluate((seq) => window.__am.renders(seq), r0);
      const want = location === 'worker' ? 1 : 0;
      await expect.poll(() => page.workers().length, { message: `${round} ${key}=${value}` }).toBe(want);
      const s = await snapshot(page);
      const q = await qa3(page);
      const step = {
        round,
        via: ui ? 'panel' : 'hook',
        set: `${key}=${value}`,
        param: await page.evaluate((k) => window.__am.get(k), key),
        location: s.location,
        delegate: s.activeDelegate,
        fallback: s.delegateFallback,
        hookWorkers: s.workers,
        qaConstructed: q.workers.constructed,
        qaTerminated: q.workers.terminated,
        qaLive: q.live,
        pwWorkers: page.workers().length,
        detections: s.detections.length,
        newFrames: s.frameCount - f0,
        stepRenders: stepRenders.length,
        stepRendersMismatch: stepRenders.filter((r) => r.mode !== 'sync' || r.frameId !== r.detectionFrameId || r.fullCover).length,
        detectorText: await page.locator('#detector').textContent(),
      };
      steps.push(step);
      expect(step.param).toBe(value);
      expect(s.location).toBe(location);
      expect(s.workers.live).toBe(want);
      expect(q.live).toBe(want);
      expect(q.workers.constructed - q.workers.terminated).toBe(want);
      expect(s.detections).toHaveLength(1);
      expect(step.stepRendersMismatch).toBe(0);
      if (key === 'delegate' && !s.delegateFallback) expect(s.activeDelegate).toBe(value);
    }
  }
  const end = await snapshot(page);
  const q = await qa3(page);
  const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
  await shot3(page, 'p3-09-after-switching');
  const evidence = {
    steps,
    end: { workers: end.workers, location: end.location, delegate: end.activeDelegate },
    qa3Workers: q.workers,
    playwrightWorkerEvents: pwEvents,
    renders: renders.length,
    rendersMismatch: renders.filter((r) => r.mode !== 'sync' || r.frameId !== r.detectionFrameId || r.fullCover).length,
    requests: { total: requests.all.length, external: requests.external, sample: requests.all.filter((r) => r.includes('/wasm/') || r.includes('/models/') || r.includes('worker')) },
    blocked: end.blockedRequests,
    console: appConsoleProblems(cons),
    pageErrors: errors.map((e) => e.message),
    qaErrors: q.errors,
  };
  save3('qa-p3-5-switching', evidence);
  console.log('[P3-5 switching]', JSON.stringify(evidence));
  expect(q.workers.constructed).toBe(4); // 처음 1 + Worker로 돌아갈 때마다 1
  expect(q.workers.terminated).toBe(3);
  expect(end.workers).toEqual({ created: 4, live: 1 });
  expect(pwEvents.closed).toBe(pwEvents.started - 1);
  expect(evidence.rendersMismatch).toBe(0);
  expect(requests.external).toEqual([]);
  expect(evidence.console).toEqual([]);
  expect(errors).toEqual([]);
  expect(q.errors).toEqual([]);
});

test('P3-6 Worker 오류가 검출기 상태 줄에 나온다: 잡히지 않은 오류(crash·바깥에서 던짐), Worker 안 추론 실패', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  const wp = onEachWorker(page, workerPatch);
  await startRunning(page);
  await wp.applied();
  const cases: Record<string, unknown>[] = [];
  const recoverViaPanel = async (): Promise<void> => {
    // UI에서 다시 시도: 실행 위치를 메인으로 갔다가 Worker로 (오류 상태에서도 바꾸면 다시 불러온다)
    await page.getByLabel('Run on', { exact: true }).selectOption({ label: 'Main thread' });
    await waitReady(page, 'main');
    const f0 = (await snapshot(page)).frameCount;
    await page.getByLabel('Run on', { exact: true }).selectOption({ label: 'Worker' });
    await waitReady(page, 'worker');
    await page.waitForFunction((n) => window.__am.snapshot().frameCount >= n && window.__am.snapshot().detections.length === 1, f0 + 2);
  };
  const check = async (name: string, inject: () => Promise<unknown>, expectText: string): Promise<void> => {
    const live0 = (await qa3(page)).live;
    const f0 = (await snapshot(page)).frameCount;
    await inject();
    await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error', undefined, { timeout: 10_000 });
    await expect(page.locator('#detector')).toContainText(expectText);
    await page.waitForTimeout(800);
    const s = await snapshot(page);
    const q = await qa3(page);
    const text = await page.locator('#detector').textContent();
    const note = await page.locator('#stage-note').textContent();
    const noteVisible = await page.locator('#stage-note').isVisible();
    const path = await shot3(page, `p3-10-worker-error-${name}`);
    cases.push({ name, text, dataState: await page.locator('#detector').getAttribute('data-state'), note, noteVisible, detectorError: s.detectorError, hookWorkers: s.workers, qaLiveBefore: live0, qaLive: q.live, pwWorkers: page.workers().length, frameCountDelta: s.frameCount - f0, shot: path });
    expect(text).toMatch(READABLE_TEXT);
    expect(await page.locator('#detector').getAttribute('data-state')).toBe('error');
    expect(noteVisible).toBe(true);
    expect(note).toMatch(READABLE_TEXT);
    expect(s.workers.live).toBe(0);
    expect(q.live).toBe(0);
    await expect.poll(() => page.workers().length).toBe(0);
    await recoverViaPanel();
  };
  await check('crash', () => page.evaluate(() => window.__am.fault('crash')), 'Detection worker error');
  await check(
    'thrown-from-worker-global',
    () => page.workers()[0]!.evaluate(() => void setTimeout(() => {
      throw new Error('QA 바깥에서 던진 오류');
    })),
    'QA 바깥에서 던진 오류',
  );
  await check('detect-fails-inside-worker', () => setInWorkers(page, { __qaThrow: true }), 'QA: Worker 안 WebGL 업로드 실패');
  const end = await snapshot(page);
  save3('qa-p3-6-worker-errors', { cases, end: { detectorState: end.detectorState, location: end.location, detections: end.detections.length, workers: end.workers } });
  console.log('[P3-6 worker errors]', JSON.stringify(cases));
  expect(end.detectorState).toBe('ready');
  expect(errors).toEqual([]);
});

test('P3-6 Worker 스크립트를 불러오지 못하면 검출기 상태 줄에 오류가 나온다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa3(page);
  await page.route('**/assets/detector.worker-*.js', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error', undefined, { timeout: 15_000 });
  const s = await snapshot(page);
  const q = await qa3(page);
  const text = await page.locator('#detector').textContent();
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running');
  await page.waitForTimeout(1500);
  const running = await snapshot(page);
  const note = (await page.locator('#stage-note').isVisible()) ? await page.locator('#stage-note').textContent() : null;
  const lit = await page.evaluate(() => {
    const c = document.getElementById('view') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i]! + d[i + 1]! + d[i + 2]! > 90) n++;
    return n;
  });
  const path = await shot3(page, 'p3-11-worker-script-404');
  const evidence = { text, detectorError: s.detectorError, workers: s.workers, qa: { workers: q.workers, live: q.live }, running: { frameCount: running.frameCount, drawn: running.drawnFrameId, failReason: running.failReason }, note, litPixels: lit, shot: path };
  save3('qa-p3-6-worker-script-404', evidence);
  console.log('[P3-6 script 404]', JSON.stringify(evidence));
  expect(text).toMatch(READABLE_TEXT);
  expect(s.detectorState).toBe('error');
  expect(s.workers.live).toBe(0);
  expect(q.live).toBe(0);
  expect(running.frameCount).toBe(0); // 동기: 원본 프레임을 그리지 않는다
  expect(lit).toBe(0);
  expect(note).toMatch(READABLE_TEXT);
  expect(errors).toEqual([]);
});
