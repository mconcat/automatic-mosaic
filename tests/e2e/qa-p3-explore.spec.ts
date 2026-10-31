// QA P3 탐색 (정지 1인): 기준 밖에서 버그를 찾는다. 결과는 tests/artifacts/P3/explore-*.json.
// 빠른 파라미터 변경, 시작·정지 반복, 표시 모드 연타, 낮은/높은 목표 FPS의 비동기 덮개 깜빡임, 불러오는 중 Worker 오류,
// 멈춘(응답 없는) Worker, Worker 안의 처리되지 않은 거부, 강도 0에서의 fail-closed.
import { expect, test, type Page } from '@playwright/test';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems } from './qa-p2-helpers';
import {
  FACE,
  READABLE_TEXT,
  hookSet,
  installQa3,
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
} from './qa-p3-helpers';

useFakeCamera('still-1face.y4m');

async function lastSeq(page: Page): Promise<number> {
  return (await page.evaluate(() => window.__am.renders().at(-1)?.seq)) ?? 0;
}

test('탐색: 기다리지 않고 40번 섞어 바꾼 파라미터가 마지막 값으로 정착하고, 그동안 얼굴이 계속 가려지며 Worker가 새지 않는다', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await startRunning(page);
  const choices: [string, unknown[]][] = [
    ['location', ['worker', 'main']],
    ['delegate', ['GPU', 'CPU']],
    ['model', ['mediapipe-face-short', 'mediapipe-face-full']],
    ['displayMode', ['sync', 'async']],
    ['targetFps', [4, 8, 15]],
    ['inferenceSize', [320, 480, 640, 0]],
    ['mirror', [true, false]],
    ['minConfidence', [0.4, 0.5, 0.6]],
  ];
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * n); // 상위 비트를 쓴다 (LCG 하위 비트는 주기가 짧다)
  };
  const applied: string[] = [];
  const last: Record<string, unknown> = {};
  await startSampler(page);
  for (let i = 0; i < 40; i++) {
    const [key, values] = choices[rnd(choices.length)]!;
    const value = values[rnd(values.length)];
    expect(await hookSet(page, key, value)).toBe(true);
    last[key] = value;
    applied.push(`${key}=${String(value)}`);
    await page.waitForTimeout(rnd(60));
  }
  // 마지막 값 위에 정착
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 20_000 });
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 1 && window.__am.snapshot().failReason === null, undefined, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const samples = await stopSampler(page);
  const s = await snapshot(page);
  const q = await qa3(page);
  const params = await page.evaluate(() => window.__am.params());
  const wantLive = params.location === 'worker' ? 1 : 0;
  await expect.poll(() => page.workers().length).toBe(wantLive);
  const drawn = samples.filter((x) => x.face >= 0);
  const evidence = {
    applied,
    last,
    final: { location: s.location, detectorId: s.detectorId, delegate: s.activeDelegate, displayMode: s.displayMode, workers: s.workers, detections: s.detections.length },
    qaWorkers: { ...q.workers, live: q.live },
    pwWorkers: page.workers().length,
    samples: summarize(samples),
    lowFace: drawn.filter((x) => x.face <= 0.9).map((x) => ({ t: x.t, face: x.face, cover: x.cover, det: x.det, reason: x.reason, drawn: x.drawn, detFrame: x.detFrame })).slice(0, 20),
    console: appConsoleProblems(cons),
    errors: errors.map((e) => e.message),
  };
  save3('explore-rapid-params', evidence);
  await shot3(page, 'p3-20-after-rapid-params');
  console.log('[explore rapid]', JSON.stringify(evidence));
  for (const [k, v] of Object.entries(last)) expect(params[k], k).toBe(v);
  expect(s.location).toBe(params.location);
  expect(s.detectorId).toBe(params.model);
  expect(s.workers.live).toBe(wantLive);
  expect(q.live).toBe(wantLive);
  expect(q.workers.constructed - q.workers.terminated).toBe(wantLive);
  expect(evidence.lowFace).toEqual([]);
  expect(errors).toEqual([]);
  expect(evidence.console).toEqual([]);
});

test('탐색: 시작·정지 10번 (연결 중 정지, 지연 고장 중 정지 포함) 뒤에도 Worker는 하나, 정지 때 트랙 종료, 다시 시작하면 검출', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await page.goto('/');
  await waitReady(page, 'worker');
  const cycles: Record<string, unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    const kind = i % 3 === 0 ? 'stop-while-starting' : i % 3 === 1 ? 'stop-during-delay' : 'normal';
    const startP = page.evaluate(() => window.__am.start());
    if (kind === 'stop-while-starting') {
      await page.evaluate(() => window.__am.stop());
      await startP;
    } else {
      await startP;
      await page.waitForFunction(() => window.__am.snapshot().frameCount >= 2 && window.__am.snapshot().detections.length === 1, undefined, { timeout: 10_000 });
      if (kind === 'stop-during-delay') {
        await page.evaluate(() => window.__am.fault('delay', 1500));
        await page.waitForTimeout(300);
      }
      await page.evaluate(() => window.__am.stop());
      await page.evaluate(() => window.__am.fault('none'));
    }
    const s = await snapshot(page);
    cycles.push({ i, kind, state: s.state, tracks: s.tracks.map((t) => t.readyState), frameCount: s.frameCount, drawn: s.drawnFrameId, workers: s.workers });
    expect(s.state, `cycle ${i}`).toBe('stopped');
    expect(s.tracks.every((t) => t.readyState === 'ended'), `cycle ${i}`).toBe(true);
    expect(s.drawnFrameId, `cycle ${i}`).toBeNull();
  }
  // 정지 뒤 늦게 끝난 지연 검출 결과가 다음 세션에 그려지지 않는다
  await page.evaluate(() => window.__am.start());
  const seq0 = await lastSeq(page);
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 10, undefined, { timeout: 10_000 });
  const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
  const s = await snapshot(page);
  const q = await qa3(page);
  const evidence = { cycles, final: { state: s.state, detections: s.detections.length, workers: s.workers, frameCount: s.frameCount }, qaWorkers: { ...q.workers, live: q.live }, renders: renders.length, rendersMismatch: renders.filter((r) => r.frameId !== r.detectionFrameId).length, console: appConsoleProblems(cons), qaErrors: q.errors };
  save3('explore-start-stop-cycles', evidence);
  console.log('[explore start/stop]', JSON.stringify(evidence));
  expect(s.detections).toHaveLength(1);
  expect(q.workers.constructed).toBe(1);
  expect(q.live).toBe(1);
  expect(s.workers).toEqual({ created: 1, live: 1 });
  expect(evidence.rendersMismatch).toBe(0);
  expect(errors).toEqual([]);
  expect(evidence.console).toEqual([]);
});

test('탐색: 표시 모드를 20번 연타하는 동안 얼굴이 계속 가려지고, 동기 기록은 모두 drawn == detection', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  const seq0 = await lastSeq(page);
  await startSampler(page);
  for (let i = 0; i < 20; i++) {
    await hookSet(page, 'displayMode', i % 2 === 0 ? 'async' : 'sync');
    await page.waitForTimeout(37 + ((i * 53) % 150));
  }
  await page.waitForTimeout(1500);
  const samples = await stopSampler(page);
  const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
  const drawn = samples.filter((x) => x.face >= 0);
  const evidence = {
    samples: summarize(samples),
    renders: renders.length,
    syncMismatch: renders.filter((r) => r.mode === 'sync' && r.frameId !== r.detectionFrameId).length,
    asyncCover: renders.filter((r) => r.mode === 'async' && r.fullCover).length,
    lowFace: drawn.filter((x) => x.face <= 0.9).length,
    blankSamples: samples.filter((x) => x.drawn === null).length,
  };
  save3('explore-display-mode-toggle', evidence);
  console.log('[explore display toggle]', JSON.stringify(evidence));
  expect(evidence.syncMismatch).toBe(0);
  expect(evidence.lowFace).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: 비동기 정상 상태에서 목표 FPS 1·4·15일 때 전체 덮개가 깜빡이지 않는다 (fail-closed 제한 시간)', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  await hookSet(page, 'displayMode', 'async');
  const runs: Record<string, unknown>[] = [];
  for (const fps of [1, 4, 15]) {
    await hookSet(page, 'targetFps', fps);
    await page.waitForTimeout(3000);
    const seq0 = await lastSeq(page);
    await page.waitForTimeout(6000);
    const renders = await page.evaluate((seq) => window.__am.renders(seq), seq0);
    const s = await snapshot(page);
    const run = { fps, renders: renders.length, cover: renders.filter((r) => r.fullCover).length, renderFps: s.renderFps, inferenceFps: s.inferenceFps, maxLag: Math.max(...renders.filter((r) => r.detectionFrameId !== null).map((r) => r.frameId - r.detectionFrameId!)) };
    runs.push(run);
  }
  save3('explore-async-fps-cover', runs);
  console.log('[explore async fps]', JSON.stringify(runs));
  for (const r of runs) expect(r.cover, JSON.stringify(r)).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: 비동기 + 강도 0(모자이크 끔)에서도 fail-closed 덮개는 화면 전체를 가린다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  await hookSet(page, 'displayMode', 'async');
  await hookSet(page, 'strength', 0);
  await page.waitForTimeout(800);
  const rawFace = await page.evaluate((f) => window.__qa3.flatness(f), FACE);
  await page.evaluate(() => window.__am.fault('error'));
  await page.waitForFunction(() => window.__am.snapshot().fullCover);
  await page.waitForTimeout(500);
  const coveredFace = await page.evaluate((f) => window.__qa3.flatness(f), FACE);
  const whole = await page.evaluate(() => window.__qa3.flatness({ x: 0, y: 0, width: 640, height: 480 }));
  await shot3(page, 'p3-21-async-strength0-error-cover');
  await page.evaluate(() => window.__am.fault('none'));
  await page.waitForFunction(() => window.__am.snapshot().failReason === null && !window.__am.snapshot().fullCover, undefined, { timeout: 10_000 });
  const evidence = { rawFace, coveredFace, whole };
  save3('explore-async-strength0-cover', evidence);
  console.log('[explore strength0 cover]', JSON.stringify(evidence));
  expect(rawFace).toBeLessThan(0.8);
  expect(coveredFace).toBeGreaterThan(0.95);
  expect(whole).toBeGreaterThan(0.95);
  expect(errors).toEqual([]);
});

test('탐색: 비동기로 시작할 때 첫 검출 전 프레임부터 화면 전체를 가린다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa3(page);
  await page.goto('/');
  await waitReady(page, 'worker');
  await hookSet(page, 'displayMode', 'async');
  await page.evaluate(() => window.__am.fault('delay', 1500));
  await startSampler(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForTimeout(1200);
  await shot3(page, 'p3-22-async-start-waiting');
  await page.evaluate(() => window.__am.fault('none'));
  await page.waitForFunction(() => window.__am.snapshot().failReason === null && window.__am.snapshot().detections.length === 1, undefined, { timeout: 10_000 });
  await page.waitForTimeout(500);
  const samples = await stopSampler(page);
  const renders = await page.evaluate(() => window.__am.renders());
  const firstDrawn = samples.findIndex((x) => x.drawn !== null);
  const beforeFirstResult = renders.slice(0, renders.findIndex((r) => !r.fullCover));
  const evidence = { samples: summarize(samples), firstDrawnSample: samples[firstDrawn], coveredBeforeFirstResult: beforeFirstResult.length, firstUncovered: renders.find((r) => !r.fullCover), notes: [...new Set(samples.map((x) => x.note))] };
  save3('explore-async-start', evidence);
  console.log('[explore async start]', JSON.stringify(evidence));
  expect(beforeFirstResult.length).toBeGreaterThan(5);
  expect(beforeFirstResult.every((r) => r.fullCover)).toBe(true);
  expect(Math.min(...samples.filter((x) => x.face >= 0).map((x) => x.face))).toBeGreaterThan(0.9);
  expect(evidence.notes).toContain('Waiting for the first detection — covering the whole frame.');
  expect(errors).toEqual([]);
});

test('탐색: Worker를 불러오는 중에 Worker 오류가 나면 "불러오는 중"에 머물지 않고 오류가 나온다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  await hookSet(page, 'location', 'main');
  await waitReady(page, 'main');
  // Worker의 ES 모듈 WASM 로더를 3초 늦춰 Worker 초기화를 붙잡는다
  await page.route('**/wasm/vision_wasm_module_internal.js*', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  await hookSet(page, 'location', 'worker');
  await page.waitForFunction(() => window.__am.snapshot().workers.live === 1);
  await page.waitForTimeout(300);
  const crashed = await page.evaluate(() => window.__am.fault('crash'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState !== 'loading', undefined, { timeout: 10_000 });
  const s = await snapshot(page);
  const text = await page.locator('#detector').textContent();
  await page.unroute('**/wasm/vision_wasm_module_internal.js*');
  const evidence = { crashed, detectorState: s.detectorState, detectorError: s.detectorError, text, workers: s.workers };
  save3('explore-crash-while-loading', evidence);
  console.log('[explore crash while loading]', JSON.stringify(evidence));
  expect(crashed).toBe(true);
  expect(s.detectorState).toBe('error');
  expect(text).toMatch(/worker/i);
  expect(text).toMatch(READABLE_TEXT);
  expect(s.workers.live).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: 메인 스레드 실행 중 fault("crash")는 false를 돌려주고 아무것도 바꾸지 않는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  await hookSet(page, 'location', 'main');
  await waitReady(page, 'main');
  const r = await page.evaluate(() => window.__am.fault('crash'));
  await page.waitForTimeout(500);
  const s = await snapshot(page);
  save3('explore-crash-main', { returned: r, detectorState: s.detectorState, detections: s.detections.length });
  expect(r).toBe(false);
  expect(s.detectorState).toBe('ready');
  expect(errors).toEqual([]);
});

test('탐색: 응답하지 않는 Worker(결과 메시지 유실) — 화면은 가려진 채 멈추고, 실행 장치·신뢰도 변경으로는 회복하지 못하며, 실행 위치를 바꾸면 회복한다', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  const wp = onEachWorker(page, workerPatch);
  await startRunning(page);
  await wp.applied();
  const out: Record<string, unknown> = {};
  await setInWorkers(page, { __qaDrop: true });
  await startSampler(page);
  await page.waitForTimeout(6000);
  const hung = await stopSampler(page);
  const s1 = await snapshot(page);
  out.hung6s = { samples: summarize(hung), snap: { detectorState: s1.detectorState, failReason: s1.failReason, frameCount: s1.frameCount, workers: s1.workers }, detectorText: await page.locator('#detector').textContent(), note: await page.locator('#stage-note').textContent() };
  await shot3(page, 'p3-23-hung-worker');
  // 실행 장치를 바꾸면? (같은 검출기의 updateOptions가 멈춘 detect 뒤에 줄을 선다)
  await hookSet(page, 'delegate', 'CPU');
  await page.waitForTimeout(5000);
  const s2 = await snapshot(page);
  out.afterDelegateChange5s = { detectorState: s2.detectorState, failReason: s2.failReason, detectorText: await page.locator('#detector').textContent(), note: await page.locator('#stage-note').textContent() };
  await shot3(page, 'p3-24-hung-worker-delegate-change');
  // 실행 위치를 바꾸면 이전 Worker를 끝내고 회복
  const t0 = Date.now();
  await hookSet(page, 'location', 'main');
  await waitReady(page, 'main', 15_000);
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 1 && window.__am.snapshot().failReason === null, undefined, { timeout: 15_000 });
  const s3 = await snapshot(page);
  out.afterLocationChange = { ms: Date.now() - t0, detectorState: s3.detectorState, location: s3.location, delegate: s3.activeDelegate, workers: s3.workers };
  save3('explore-hung-worker', out);
  console.log('[explore hung worker]', JSON.stringify(out));
  // 가려진 채 멈춘다 (원본 노출 없음), 안내는 한국어
  expect(Math.min(...hung.filter((x) => x.face >= 0).map((x) => x.face))).toBeGreaterThan(0.9);
  expect(s1.failReason).toBe('stalled');
  expect(out.hung6s as { note: string }).toHaveProperty('note');
  expect((out.hung6s as { note: string }).note).toMatch(READABLE_TEXT);
  expect(s3.location).toBe('main');
  expect(s3.workers.live).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: Worker 안의 처리되지 않은 Promise 거부는 화면 상태에 나오는가', async ({ page }) => {
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa3(page);
  await startRunning(page);
  await page.workers()[0]!.evaluate(() => {
    void Promise.reject(new Error('QA: Worker 안 처리되지 않은 거부'));
  });
  await page.waitForTimeout(1500);
  const s = await snapshot(page);
  const evidence = { detectorState: s.detectorState, detectorText: await page.locator('#detector').textContent(), detections: s.detections.length, console: cons.filter((c) => c.text.includes('QA:')) };
  save3('explore-worker-unhandled-rejection', { ...evidence, pageErrors: errors.map((e) => e.message) });
  console.log('[explore worker unhandled rejection]', JSON.stringify(evidence), errors.map((e) => e.message));
  // 기록용: 앱과 무관한 거부라 검출은 계속된다. 화면 상태에는 나오지 않는다 (Worker의 error 이벤트가 오지 않음).
  expect(s.detections).toHaveLength(1);
  expect(errors.map((e) => e.message)).toEqual(['QA: Worker 안 처리되지 않은 거부']);
});

test('탐색: Worker가 결과를 보내다 한 번 실패하면(postMessage 예외) 이후 요청이 모두 멈추는가, 화면 상태에 나오는가', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  const wp = onEachWorker(page, workerPatch);
  await startRunning(page);
  await wp.applied();
  // 다음 결과 메시지 하나만 보내기 전에 던지게 한다
  await page.workers()[0]!.evaluate(() => {
    const g = self as unknown as { postMessage: (m: unknown, t?: unknown) => void };
    const post = g.postMessage;
    let armed = true;
    g.postMessage = (m: unknown, t?: unknown) => {
      if (armed && (m as { type?: string } | null)?.type === 'result') {
        armed = false;
        throw new DOMException('QA: 결과를 복제하지 못함', 'DataCloneError');
      }
      post(m, t);
    };
  });
  await startSampler(page);
  await page.waitForTimeout(5000);
  const samples = await stopSampler(page);
  const s = await snapshot(page);
  const evidence = {
    samples: summarize(samples),
    snap: { detectorState: s.detectorState, failReason: s.failReason, frameCount: s.frameCount, workers: s.workers, detections: s.detections.length },
    detectorText: await page.locator('#detector').textContent(),
    note: (await page.locator('#stage-note').isVisible()) ? await page.locator('#stage-note').textContent() : null,
    pageErrors: errors.map((e) => e.message),
  };
  await shot3(page, 'p3-25-worker-reply-failure');
  save3('explore-worker-reply-failure', evidence);
  console.log('[explore worker reply failure]', JSON.stringify(evidence));
  // 원본 노출은 없어야 한다
  expect(Math.min(...samples.filter((x) => x.face >= 0).map((x) => x.face))).toBeGreaterThan(0.9);
});
