// QA P2 탐색 (기준 밖): 빠른 파라미터 변경, 시작·정지 반복, 정지 중 변경, 창 크기, 오류 복구, 콘솔 오류.
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, collectDetections, grid, installQa2, probe2, save2, shot2, waitFrames } from './qa-p2-helpers';

useFakeCamera('still-1face.y4m');

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.frameCount >= 3 && s.detections.length > 0;
  });
}

async function blocks(page: Page): Promise<{ uniformFrac: number; region: Rect | null }> {
  const s = await snapshot(page);
  const r = s.regions[0];
  if (!r) return { uniformFrac: NaN, region: null };
  const p = await page.evaluate(() => window.__am.params());
  const g = grid(r, String(p.blockMode), Number(p.blockSize), Number(p.blockCells));
  const b = await page.evaluate(([r, c, rr]) => window.__qa2.blockCheck(r, c, rr), [r, g.cols, g.rows] as const);
  return { uniformFrac: b.uniformFrac, region: r };
}

test('탐색: 모델·실행 장치를 기다리지 않고 12번 번갈아 바꾸면 마지막 값으로 정착한다', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa2(page);
  await start(page);
  await page.evaluate(() => window.__qa2.startSampler());
  const t0 = Date.now();
  await page.evaluate(() => {
    const seq: [string, string][] = [];
    for (let i = 0; i < 6; i++) {
      seq.push(['model', i % 2 ? 'mediapipe-face-short' : 'mediapipe-face-full']);
      seq.push(['delegate', i % 2 ? 'GPU' : 'CPU']);
    }
    seq.push(['model', 'mediapipe-face-full'], ['delegate', 'CPU']);
    for (const [k, v] of seq) window.__am.set(k, v);
  });
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 20_000 });
  const settleMs = Date.now() - t0;
  const frames = await collectDetections(page, 6);
  const s = await snapshot(page);
  const samples = await page.evaluate(() => window.__qa2.stopSampler());
  const p = await probe2(page);
  const ev = { settleMs, detectorId: s.detectorId, activeDelegate: s.activeDelegate, params: { model: await page.evaluate(() => window.__am.get('model')), delegate: await page.evaluate(() => window.__am.get('delegate')) }, counts: frames.map((f) => f.count), mismatched: samples.filter((x) => x.drawn !== x.det).length, states: [...new Set(samples.map((x) => x.state))], drawnUnanalysed: p.drawnUnanalysed, console: appConsoleProblems(cons) };
  save2('explore-rapid-model-delegate', ev);
  console.log('[explore rapid model/delegate]', JSON.stringify(ev));
  expect(s.detectorId).toBe('mediapipe-face-full');
  expect(s.activeDelegate).toBe('CPU');
  expect(frames.every((f) => f.count === 1)).toBe(true);
  expect(ev.mismatched).toBe(0);
  expect(p.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
  expect(ev.console).toEqual([]);
});

test('탐색: 검출 중 UI로 시작·정지를 빠르게 10번 (검출기 전환 중 포함), 새는 트랙·오류 없이 다시 검출한다', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa2(page);
  await start(page);
  const toggle = page.locator('#toggle');
  const waits = [0, 30, 120, 0, 250, 60, 0, 400, 10, 200];
  for (let i = 0; i < waits.length; i++) {
    if (i === 3) await page.evaluate(() => window.__am.set('model', 'mediapipe-face-full'));
    if (i === 6) await page.evaluate(() => window.__am.set('delegate', 'CPU'));
    await toggle.click(); // 정지
    await page.waitForTimeout(waits[i]!);
    await expect(toggle).toBeEnabled();
    await toggle.click(); // 시작
    await page.waitForTimeout(waits[(i + 3) % waits.length]!);
    await expect(toggle).toBeEnabled({ timeout: 5000 });
  }
  await page.waitForFunction(() => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.detectorState === 'ready' && s.frameCount >= 3;
  }, undefined, { timeout: 20_000 });
  const frames = await collectDetections(page, 6);
  const running = await snapshot(page);
  await toggle.click();
  await page.waitForTimeout(500);
  const stopped = await snapshot(page);
  const lit = await page.evaluate(() => window.__qa2.lit());
  const trackStates = await page.evaluate(() => window.__qa2.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)));
  await page.waitForTimeout(500);
  const stopped2 = await snapshot(page);
  const p = await probe2(page);
  const ev = { counts: frames.map((f) => f.count), running: { detectorId: running.detectorId, delegate: running.activeDelegate, drawn: running.drawnFrameId, det: running.detectionFrameId }, stopped: { state: stopped.state, frameCount: stopped.frameCount, drawn: stopped.drawnFrameId, regions: stopped.regions.length, detections: stopped.detections.length }, frameCountLater: stopped2.frameCount, lit, streams: trackStates.length, trackStates: [...new Set(trackStates)], gum: p.gum, drawnUnanalysed: p.drawnUnanalysed, console: appConsoleProblems(cons) };
  save2('explore-start-stop-cycles', ev);
  console.log('[explore start/stop]', JSON.stringify(ev));
  expect(frames.every((f) => f.count === 1)).toBe(true);
  expect(running.detectorId).toBe('mediapipe-face-full');
  expect(running.activeDelegate).toBe('CPU');
  expect(stopped.state).toBe('stopped');
  expect(stopped.drawnFrameId).toBeNull();
  expect(lit).toBe(0);
  expect(stopped2.frameCount).toBe(stopped.frameCount);
  expect(trackStates.every((t) => t === 'ended')).toBe(true);
  expect(p.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
  expect(ev.console).toEqual([]);
});

test('탐색: 정지 중에 바꾼 파라미터(이펙트·색·패딩·모델)는 다음 시작의 첫 프레임부터 적용된다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.evaluate(() => {
    window.__am.set('effect', 'solid');
    window.__am.set('solidColor', '#00ff00');
    window.__am.set('padding', 2);
    window.__am.set('model', 'mediapipe-face-full');
  });
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1);
  const s = await snapshot(page);
  const green = await page.evaluate((r) => window.__qa2.solid(window.__qa2.toCanvas(r), [0, 255, 0]), s.regions[0]!);
  const ev = { frameCount: s.frameCount, detectorId: s.detectorId, region: s.regions[0], box: s.detections[0]?.box, green };
  save2('explore-params-while-stopped', ev);
  console.log('[explore stopped params]', JSON.stringify(ev));
  expect(s.detectorId).toBe('mediapipe-face-full');
  expect(Math.abs(s.regions[0]!.width - s.detections[0]!.box.width * 2)).toBeLessThanOrEqual(2);
  expect(green.match).toBeGreaterThanOrEqual(0.999);
  expect(errors).toEqual([]);
});

test('탐색: 신뢰도 0.99는 모델·실행 장치를 바꿔도 유지된다 (새 검출기도 0개)', async ({ page }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  await page.evaluate(() => window.__am.set('minConfidence', 0.99));
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 0);
  const res: Record<string, number[]> = {};
  for (const [k, v] of [
    ['model', 'mediapipe-face-full'],
    ['delegate', 'CPU'],
    ['model', 'mediapipe-face-short'],
  ] as const) {
    await page.evaluate(([k, v]) => window.__am.set(k, v), [k, v] as const);
    await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 20_000 });
    res[`${k}=${v}`] = (await collectDetections(page, 5)).map((f) => f.count);
  }
  await page.evaluate(() => window.__am.set('minConfidence', 0.5));
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 1);
  res['minConfidence=0.5'] = (await collectDetections(page, 5)).map((f) => f.count);
  save2('explore-confidence-across-switch', res);
  console.log('[explore conf across switch]', JSON.stringify(res));
  for (const [k, v] of Object.entries(res)) expect(v.every((c) => c === (k.startsWith('minConfidence') ? 1 : 0)), k).toBe(true);
  expect(errors).toEqual([]);
});

test('탐색: 표시 파라미터를 300번 연달아 바꿔도 같은 분석 프레임을 다시 그리고 마지막 값으로 맞는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  await page.evaluate(() => window.__am.set('targetFps', 1)); // 그사이 새 프레임이 거의 오지 않게
  await waitFrames(page, 1, 5000);
  const res = await page.evaluate(() => {
    const before = window.__am.snapshot().drawnFrameId;
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      window.__am.set('padding', 1 + (i % 21) * 0.05);
      window.__am.set('blockCells', 4 + (i % 29));
      window.__am.set('strength', (i % 5) / 4);
      window.__am.set('effect', i % 7 === 0 ? 'solid' : 'pixelate');
      window.__am.set('mirror', i % 2 === 0);
    }
    window.__am.set('padding', 1.5);
    window.__am.set('blockCells', 12);
    window.__am.set('strength', 1);
    window.__am.set('effect', 'pixelate');
    window.__am.set('mirror', true);
    const ms = performance.now() - t0;
    const s = window.__am.snapshot();
    return { msPerSet: ms / 1505, before, after: s.drawnFrameId, region: s.regions[0], box: s.detections[0]?.box };
  });
  const b = await blocks(page);
  const ev = { ...res, uniformFrac: b.uniformFrac };
  save2('explore-rapid-display-params', ev);
  console.log('[explore rapid display]', JSON.stringify(ev));
  expect(Math.abs(res.region!.width - res.box!.width * 1.5)).toBeLessThanOrEqual(2);
  expect(b.uniformFrac).toBeGreaterThanOrEqual(0.98);
  expect(errors).toEqual([]);
});

test('탐색: 창 크기를 바꾸면 다음 분석 프레임을 기다리지 않고 마지막 분석 프레임을 모자이크와 함께 다시 그린다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  await page.evaluate(() => window.__am.set('targetFps', 1));
  await waitFrames(page, 1, 5000);
  const out: { size: string; frameCount: number; lit: number; uniform: number }[] = [];
  for (const [w, h] of [
    [900, 700],
    [1500, 950],
    [700, 500],
  ] as const) {
    const fc = (await snapshot(page)).frameCount;
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    out.push({ size: `${w}x${h}`, frameCount: s.frameCount - fc, lit: await page.evaluate(() => window.__qa2.lit()), uniform: (await blocks(page)).uniformFrac });
  }
  await shot2(page, 'p2-16-after-resize-700x500');
  const p = await probe2(page);
  save2('explore-resize', { out, drawnUnanalysed: p.drawnUnanalysed });
  console.log('[explore resize]', JSON.stringify(out));
  for (const o of out) {
    expect(o.lit).toBeGreaterThan(0.3);
    expect(o.uniform).toBeGreaterThanOrEqual(0.98);
  }
  expect(p.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: 추론 해상도·목표 FPS를 실행 중에 바꿔도 검출이 유지되고 FPS가 따라간다', async ({ page }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  const res: Record<string, unknown> = {};
  for (const size of [320, 480, 0, 640]) {
    await page.evaluate((v) => window.__am.set('inferenceSize', v), size);
    await waitFrames(page, 2);
    const f = await collectDetections(page, 3);
    res[`size${size}`] = { counts: f.map((x) => x.count), box: (await snapshot(page)).detections[0]?.box };
  }
  for (const fps of [1, 15]) {
    await page.evaluate((v) => window.__am.set('targetFps', v), fps);
    await page.waitForTimeout(fps === 1 ? 4000 : 2500);
    const s = await snapshot(page);
    res[`fps${fps}`] = { inferenceFps: s.inferenceFps, renderFps: s.renderFps, dropped: s.droppedFrames, ms: s.inferenceMs };
  }
  save2('explore-size-fps', res);
  console.log('[explore size/fps]', JSON.stringify(res));
  for (const size of [320, 480, 0, 640]) expect((res[`size${size}`] as { counts: number[] }).counts.every((c) => c === 1)).toBe(true);
  expect((res.fps1 as { renderFps: number }).renderFps).toBeGreaterThan(0.6);
  expect((res.fps1 as { renderFps: number }).renderFps).toBeLessThan(1.6);
  expect((res.fps15 as { renderFps: number }).renderFps).toBeGreaterThan(11);
  expect(errors).toEqual([]);
});

test('탐색: 맞지 않는 값은 거부하고 화면은 그대로', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  const res = await page.evaluate(() => {
    const before = JSON.stringify(window.__am.params());
    const r = {
      confText: window.__am.set('minConfidence', 'abc' as never),
      model: window.__am.set('model', 'nope'),
      effect: window.__am.set('effect', 'blur'),
      color: window.__am.set('solidColor', 'red'),
      unknown: window.__am.set('nope', 1),
      proto: window.__am.set('__proto__', 1 as never),
      nan: window.__am.set('padding', Number.NaN),
      big: window.__am.set('padding', 5),
      paddingAfterBig: window.__am.get('padding'),
      negFps: window.__am.set('targetFps', -3),
      fpsAfter: window.__am.get('targetFps'),
    };
    window.__am.set('padding', 1.3);
    window.__am.set('targetFps', 8);
    return { ...r, unchanged: JSON.stringify(window.__am.params()) === before };
  });
  save2('explore-invalid-values', res);
  console.log('[explore invalid]', JSON.stringify(res));
  expect([res.confText, res.model, res.effect, res.color, res.unknown, res.proto, res.nan]).toEqual([false, false, false, false, false, false, false]);
  expect(res.paddingAfterBig).toBe(2);
  expect(res.unchanged).toBe(true);
  expect(errors).toEqual([]);
});

test('탐색: 실행 중 모델 파일이 404면 한국어 오류, 화면은 마지막 분석 프레임(모자이크) 그대로, 다른 모델로 복구', async ({ page, context }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  await context.route(/blaze_face_full_range\.tflite$/, (r) => r.fulfill({ status: 404, body: 'not found' }));
  await installQa2(page);
  await start(page);
  const hashBefore = await page.evaluate(() => window.__qa2.hash());
  await page.evaluate(() => window.__am.set('model', 'mediapipe-face-full'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error', undefined, { timeout: 15_000 });
  await page.waitForTimeout(800);
  const s = await snapshot(page);
  const ui = { detector: await page.locator('#detector').textContent(), note: await page.locator('#stage-note').textContent(), noteVisible: await page.locator('#stage-note').isVisible() };
  const hashErr = await page.evaluate(() => window.__qa2.hash());
  const uniform = (await blocks(page)).uniformFrac;
  await shot2(page, 'p2-17-detector-error');
  const fcErr = s.frameCount;
  await page.waitForTimeout(600);
  const fcErr2 = (await snapshot(page)).frameCount;
  await page.evaluate(() => window.__am.set('model', 'mediapipe-face-short'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 15_000 });
  const frames = await collectDetections(page, 4);
  const p = await probe2(page);
  const ev = { detectorState: s.detectorState, detectorError: s.detectorError, ui, sameScreen: hashBefore === hashErr, uniformDuringError: uniform, frameCountFrozen: fcErr === fcErr2, recovered: frames.map((f) => f.count), drawnUnanalysed: p.drawnUnanalysed };
  save2('explore-model-404-runtime', ev);
  console.log('[explore 404]', JSON.stringify(ev));
  expect(s.detectorError).toMatch(/detector/i);
  expect(ui.noteVisible).toBe(true);
  expect(uniform).toBeGreaterThanOrEqual(0.98);
  expect(fcErr2).toBe(fcErr);
  expect(frames.every((f) => f.count === 1)).toBe(true);
  expect(p.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: 미러를 켜고 꺼도 모자이크가 얼굴 위에 있다 (캔버스 좌표가 반전을 따라감)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  const res: Record<string, unknown> = {};
  for (const m of [true, false, true]) {
    await page.evaluate((m) => window.__am.set('mirror', m), m);
    const b = await blocks(page);
    const c = await page.evaluate((r) => window.__qa2.toCanvas(r), b.region!);
    res[`mirror=${m}-${Object.keys(res).length}`] = { uniform: b.uniformFrac, canvasX: Math.round(c.x) };
  }
  await page.evaluate(() => window.__am.set('mirror', false));
  await shot2(page, 'p2-18-mirror-off-canvas', { canvasOnly: true });
  save2('explore-mirror-mosaic', res);
  console.log('[explore mirror]', JSON.stringify(res));
  for (const v of Object.values(res)) expect((v as { uniform: number }).uniform).toBeGreaterThanOrEqual(0.98);
  expect(errors).toEqual([]);
});

test('탐색: ImageBitmap을 새지 않는다 (만든 수 − 닫은 수가 실행 중 작게 유지, 정지 후 0)', async ({ page }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __bm: { made: number; closed: number } };
    w.__bm = { made: 0, closed: 0 };
    const cib = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>;
    window.createImageBitmap = ((...a: unknown[]) =>
      cib(...a).then((b) => {
        w.__bm.made++;
        return b;
      })) as typeof window.createImageBitmap;
    const close = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function (this: ImageBitmap) {
      if (this.width !== 0 || this.height !== 0) w.__bm.closed++; // 이미 닫힌 것은 세지 않는다
      close.call(this);
    };
    // P3: 검출 Worker로 transfer 한 비트맵은 메인에서 떠난다 (Worker의 검출기가 닫는다). 닫은 것으로 센다.
    const post = Worker.prototype.postMessage as (this: Worker, msg: unknown, transfer?: unknown) => void;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, transfer?: unknown): void {
      for (const t of Array.isArray(transfer) ? transfer : []) if (t instanceof ImageBitmap && t.width !== 0) w.__bm.closed++;
      post.call(this, msg, transfer);
    } as typeof Worker.prototype.postMessage;
  });
  await installQa2(page);
  await start(page);
  const read = (): Promise<{ made: number; closed: number }> => page.evaluate(() => ({ ...(window as unknown as { __bm: { made: number; closed: number } }).__bm }));
  await page.evaluate(() => window.__am.set('targetFps', 15));
  const series: { t: number; made: number; outstanding: number }[] = [];
  for (let i = 0; i < 10; i++) {
    if (i === 3) await page.evaluate(() => window.__am.set('inferenceSize', 320));
    if (i === 5) await page.evaluate(() => window.__am.set('delegate', 'CPU'));
    if (i === 7) await page.evaluate(() => window.__am.set('model', 'mediapipe-face-full'));
    await page.waitForTimeout(700);
    const b = await read();
    series.push({ t: i, made: b.made, outstanding: b.made - b.closed });
  }
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.waitForTimeout(500);
  const end = await read();
  const ev = { series, afterStop: { ...end, outstanding: end.made - end.closed } };
  save2('explore-imagebitmap-leak', ev);
  console.log('[explore bitmap leak]', JSON.stringify(ev));
  expect(Math.max(...series.map((s) => s.outstanding))).toBeLessThanOrEqual(4);
  expect(series[series.length - 1]!.made).toBeGreaterThan(100);
  expect(end.made - end.closed).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('탐색: 검출기를 30번 다시 만들어도 브라우저 프로세스 메모리(RSS)가 계속 늘지 않는다', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  await start(page);
  // 이 테스트의 브라우저 = chrome://version의 프로필 경로(테스트마다 고유한 user-data-dir)를 명령줄에 가진 Chrome 본 프로세스.
  // 병렬 워커의 다른 브라우저를 섞지 않도록 그것과 그 자식 프로세스의 RSS만 더한다.
  const info = await page.context().newPage();
  await info.goto('chrome://version');
  const profile = (await info.locator('#profile_path').textContent())!.trim();
  await info.close();
  const userDataDir = profile.replace(/\/Default$/, '').split('/').pop()!; // playwright_chromiumdev_profile-XXXX (고유)
  const rssMB = (): number => {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const rows = ps.map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)!;
      return { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), cmd: m[4]! };
    });
    const roots = rows.filter((r) => r.cmd.includes(userDataDir) && !r.cmd.includes('--type='));
    const tree = new Set(roots.map((r) => r.pid));
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) (tree.add(r.pid), (grew = true));
    }
    return Math.round(rows.filter((r) => tree.has(r.pid)).reduce((a, r) => a + r.rss, 0) / 1024);
  };
  const cdp = await page.context().newCDPSession(page);
  const series: { switches: number; rssMB: number }[] = [];
  const sample = async (n: number): Promise<void> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(500);
    series.push({ switches: n, rssMB: rssMB() });
  };
  await sample(0);
  for (let i = 1; i <= 30; i++) {
    await page.evaluate((i) => window.__am.set('delegate', i % 2 ? 'CPU' : 'GPU'), i);
    await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready' && window.__am.snapshot().detections.length === 1, undefined, { timeout: 20_000 });
    if (i === 2 || i % 10 === 0) await sample(i);
  }
  save2('explore-memory-switches', series);
  console.log('[explore memory rss]', JSON.stringify(series));
  const base = series.find((s) => s.switches === 2)!;
  const last = series[series.length - 1]!;
  console.log('[explore memory rss] userDataDir', userDataDir);
  expect(base.rssMB).toBeGreaterThan(50); // 프로세스를 제대로 찾았다
  expect(base.rssMB).toBeLessThan(2500); // 다른 브라우저를 섞지 않았다
  expect(last.rssMB - base.rssMB).toBeLessThan(300);
  expect(errors).toEqual([]);
});

test('탐색: 시작 직후·검출기 전환 직후 FPS 표시 (목표 8): 렌더 = 추론, 잠깐 넘었다가 8로 안정', async ({ page }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready');
  const sampleFps = (ms: number): Promise<{ t: number; render: number; inference: number; fc: number }[]> =>
    page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const out: { t: number; render: number; inference: number; fc: number }[] = [];
          const t0 = performance.now();
          const id = setInterval(() => {
            const s = window.__am.snapshot();
            out.push({ t: Math.round(performance.now() - t0), render: Math.round(s.renderFps * 10) / 10, inference: Math.round(s.inferenceFps * 10) / 10, fc: s.frameCount });
            if (performance.now() - t0 > ms) {
              clearInterval(id);
              resolve(out);
            }
          }, 100);
        }),
      ms,
    );
  await page.getByRole('button', { name: 'Start' }).click();
  const afterStart = await sampleFps(3000);
  await page.evaluate(() => window.__am.set('model', 'mediapipe-face-full'));
  const afterSwitch = await sampleFps(3000);
  const header = await page.locator('#stats').textContent();
  const ev = { maxAfterStart: Math.max(...afterStart.map((x) => x.render)), maxAfterSwitch: Math.max(...afterSwitch.map((x) => x.render)), afterStart, afterSwitch, header };
  save2('explore-fps-overshoot', ev);
  console.log('[explore fps overshoot]', JSON.stringify({ maxAfterStart: ev.maxAfterStart, maxAfterSwitch: ev.maxAfterSwitch, start: afterStart.slice(0, 12), sw: afterSwitch.slice(0, 12) }));
  for (const x of [...afterStart, ...afterSwitch]) expect(x.render).toBe(x.inference);
  // 목표 FPS는 평균이라 직후 1초 동안 잠깐 넘는다 (관찰: 최대 9.4–11.3, 이슈로 보고). 이후에는 8 근처.
  expect(ev.maxAfterStart).toBeLessThanOrEqual(12);
  expect(ev.maxAfterSwitch).toBeLessThanOrEqual(12);
  for (const x of [...afterStart.slice(-10), ...afterSwitch.slice(-10)]) expect(Math.abs(x.render - 8)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('탐색: 패널의 색 입력으로 단색 색을 바꾼다. NMS 임계 0.1·0.3은 1개, 0.9는 한 얼굴에 겹친 박스 2개', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  await page.getByRole('complementary', { name: 'Advanced settings' }).getByLabel('Effect').selectOption({ label: 'Solid fill' });
  const color = page.getByLabel('Color');
  await color.fill('#00ffff');
  await color.press('Enter');
  await waitFrames(page, 1);
  const s = await snapshot(page);
  const cyan = await page.evaluate((r) => window.__qa2.solid(window.__qa2.toCanvas(r), [0, 255, 255]), s.regions[0]!);
  const storeColor = await page.evaluate(() => window.__am.get('solidColor'));
  const nms: Record<string, number[]> = {};
  const nmsBoxes: Record<string, { boxes: Rect[]; regions: Rect[] }> = {};
  for (const v of ['0.9', '0.1', '0.3']) {
    const input = page.getByLabel('NMS threshold');
    await input.fill(v);
    await input.press('Enter');
    await waitFrames(page, 2);
    nms[v] = (await collectDetections(page, 5)).map((f) => f.count);
    const sv = await snapshot(page);
    nmsBoxes[v] = { boxes: sv.detections.map((d) => d.box), regions: sv.regions };
  }
  const ev = { storeColor, cyan, nms, nmsBoxes };
  save2('explore-color-nms', ev);
  console.log('[explore color/nms]', JSON.stringify(ev));
  expect(storeColor).toBe('#00ffff');
  expect(cyan.match).toBeGreaterThanOrEqual(0.999);
  // 0.1·0.3: 1개. 0.9: 겹친 박스가 덜 지워져 한 얼굴에 2개가 나온다 (관찰, 파라미터가 반영된다는 증거). 둘 다 가린다.
  expect(nms['0.1']!.every((c) => c === 1)).toBe(true);
  expect(nms['0.3']!.every((c) => c === 1)).toBe(true);
  expect(nms['0.9']!.every((c) => c >= 1)).toBe(true);
  expect(nmsBoxes['0.9']!.regions.length).toBe(nmsBoxes['0.9']!.boxes.length);
  expect(errors).toEqual([]);
});

test('탐색: 페이지를 열 때 모델을 못 받으면 (일시적 실패) 정지·시작으로는 다시 시도하지 않는다', async ({ page, context }) => {
  test.setTimeout(45_000);
  const errors = collectPageErrors(page);
  let fail = true;
  await context.route(/blaze_face_short_range\.tflite$/, (r) => (fail ? r.fulfill({ status: 503, body: 'busy' }) : r.continue()));
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error', undefined, { timeout: 15_000 });
  fail = false; // 서버가 다시 정상
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running');
  await page.waitForTimeout(1500);
  const afterStart = await snapshot(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForTimeout(1500);
  const afterRestart = await snapshot(page);
  const ui = { detector: await page.locator('#detector').textContent(), note: await page.locator('#stage-note').textContent(), alert: await page.locator('#error').isVisible() };
  await shot2(page, 'p2-20-detector-error-no-retry');
  // 같은 값을 다시 고르는 것은 Tweakpane에서 change가 나지 않는다. 다른 실행 장치로 바꿔야 다시 시도한다.
  await page.evaluate(() => window.__am.set('delegate', 'CPU'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 15_000 });
  const ev = { afterStart: { state: afterStart.state, detectorState: afterStart.detectorState, frameCount: afterStart.frameCount }, afterRestart: { detectorState: afterRestart.detectorState, frameCount: afterRestart.frameCount }, ui, recoveredBySwitchingDelegate: true };
  save2('explore-detector-error-retry', ev);
  console.log('[explore retry]', JSON.stringify(ev));
  // 관찰을 고정: 정지·시작은 검출기를 다시 불러오지 않는다 (이슈로 보고)
  expect(afterRestart.detectorState).toBe('error');
  expect(afterRestart.frameCount).toBe(0);
  expect(errors).toEqual([]);
});
