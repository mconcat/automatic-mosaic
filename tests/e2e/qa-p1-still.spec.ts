// QA P1: 정지 영상 픽스처로 렌더·미러·정지·외부 요청을 수치로 확인하고, 기준 밖 동작도 탐색한다.
// P2 적응: 원본 비디오와 픽셀 비교하는 테스트는 모자이크 강도 0(unmasked)으로 P1 렌더 경로를 본다.
// 콘솔 오류·경고 검사에서는 MediaPipe WASM 자체 로그(isMediaPipeLog)를 뺀다.
import { expect, test, type Page } from '@playwright/test';
import { canvasThumb, collectPageErrors, flipThumb, isMediaPipeLog, litRatio, meanAbsDiff, snapshot, unmasked, useFakeCamera } from './helpers';
import { collectConsole, installProbes, lumaStd, probe, recordRequests, isExpectedUrl, saveEvidence, shot, viewAndRaw } from './qa-helpers';

useFakeCamera('still-1face.y4m');

const W = 160;
const H = 120;

async function waitRunning(page: Page, minFrames = 5): Promise<void> {
  await page.waitForFunction((n) => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.frameCount >= n;
  }, minFrames);
}

async function startViaUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start' }).click();
  await waitRunning(page);
}

test('QA-3 still: 시작하면 실제 카메라 영상이 그려지고 렌더 FPS > 5', async ({ page }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  await unmasked(page);
  const idle = await snapshot(page);
  expect(idle.state).toBe('idle');
  const idleLit = litRatio(await canvasThumb(page));
  await shot(page, 'p1-01-idle');

  await startViaUi(page);
  await page.waitForTimeout(1500);

  const { view, raw, fit } = await viewAndRaw(page, W, H);
  const lit = litRatio(view);
  const std = lumaStd(view);
  // 미러 기본값 켬: 캔버스 = 원본 비디오를 좌우로 뒤집은 것
  const diffVsFlippedRaw = meanAbsDiff(view, flipThumb(raw, W, H));
  const diffVsRaw = meanAbsDiff(view, raw);

  const s0 = await snapshot(page);
  const p0 = await probe(page);
  const t0 = Date.now();
  await page.waitForTimeout(2000);
  const s1 = await snapshot(page);
  const p1 = await probe(page);
  const dt = (Date.now() - t0) / 1000;
  const measuredFps = (s1.frameCount - s0.frameCount) / dt;

  await shot(page, 'p1-02-running-still-mirror-on');
  await shot(page, 'p1-02b-canvas-still-mirror-on', { canvasOnly: true });

  const evidence = {
    idleState: idle.state,
    idleLitRatio: idleLit,
    fitRect: fit,
    litRatio: lit,
    lumaStd: std,
    diffVsFlippedRaw,
    diffVsRaw,
    hookRenderFps: [s0.renderFps, s1.renderFps],
    frameCountDelta: s1.frameCount - s0.frameCount,
    secondsMeasured: dt,
    measuredFps,
    rvfcDelta: p1.rvfc - p0.rvfc,
    drawsDelta: p1.draws - p0.draws,
    video: [s1.videoWidth, s1.videoHeight],
    stats: await page.locator('#stats').textContent(),
    status: await page.locator('#status').textContent(),
    tracks: s1.tracks,
    console: consoleLog,
  };
  saveEvidence('qa3-still-render', evidence);
  console.log('[QA-3 still]', JSON.stringify(evidence));

  expect(idleLit).toBe(0);
  expect(s1.state).toBe('running');
  expect(lit).toBeGreaterThan(0.5);
  expect(std).toBeGreaterThan(20); // 단색이 아니라 그림이다
  expect(diffVsFlippedRaw).toBeLessThan(4);
  expect(diffVsRaw).toBeGreaterThan(10);
  expect(s0.renderFps).toBeGreaterThan(5);
  expect(s1.renderFps).toBeGreaterThan(5);
  expect(measuredFps).toBeGreaterThan(5);
  expect(p1.draws - p0.draws).toBeGreaterThan(10);
  expect(errors).toEqual([]);
  expect(p1.errors).toEqual([]);
  expect(consoleLog.filter((m) => m.type === 'error' && !isMediaPipeLog(m.text))).toEqual([]);
});

test('QA-4 미러 토글이 렌더 이미지를 좌우로 뒤집는다 (원본 비디오와 픽셀 비교)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await unmasked(page);
  await startViaUi(page);
  const mirror = page.getByLabel('Mirror');
  const rows: { label: string; hookMirror: boolean; checkbox: boolean; diffVsRaw: number; diffVsFlippedRaw: number }[] = [];

  async function measure(label: string, expectMirror: boolean): Promise<void> {
    await page.waitForTimeout(300);
    const { view, raw } = await viewAndRaw(page, W, H);
    const row = {
      label,
      hookMirror: (await snapshot(page)).mirror,
      checkbox: await mirror.isChecked(),
      diffVsRaw: meanAbsDiff(view, raw),
      diffVsFlippedRaw: meanAbsDiff(view, flipThumb(raw, W, H)),
    };
    rows.push(row);
    const same = expectMirror ? row.diffVsFlippedRaw : row.diffVsRaw;
    const other = expectMirror ? row.diffVsRaw : row.diffVsFlippedRaw;
    expect(row.hookMirror, label).toBe(expectMirror);
    expect(row.checkbox, label).toBe(expectMirror);
    expect(same, label).toBeLessThan(4);
    expect(other, label).toBeGreaterThan(10);
  }

  await measure('기본(켬)', true);
  await mirror.uncheck();
  await measure('UI 끔', false);
  await shot(page, 'p1-03-running-still-mirror-off');
  await shot(page, 'p1-03b-canvas-still-mirror-off', { canvasOnly: true });
  await mirror.check();
  await measure('UI 켬', true);
  await page.evaluate(() => window.__am.set('mirror', false));
  await measure('__am.set(false)', false);
  await page.evaluate(() => window.__am.set('mirror', true));
  await measure('__am.set(true)', true);

  // 캔버스 전체 썸네일끼리도: 켬/끔 이미지가 서로 좌우 반전 관계
  await mirror.uncheck();
  await page.waitForTimeout(300);
  const off = await canvasThumb(page);
  await mirror.check();
  await page.waitForTimeout(300);
  const on = await canvasThumb(page);
  const full = { onVsOff: meanAbsDiff(on, off), onVsFlippedOff: meanAbsDiff(on, flipThumb(off)) };

  saveEvidence('qa4-mirror', { rows, full });
  console.log('[QA-4 mirror]', JSON.stringify({ rows, full }));
  expect(full.onVsOff).toBeGreaterThan(10);
  expect(full.onVsFlippedOff).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test('QA-6 정지하면 모든 MediaStreamTrack이 ended가 되고 렌더 루프가 멈춘다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  await startViaUi(page);
  await page.waitForTimeout(500);
  const before = await probe(page);
  expect(before.trackStates.every((t) => t === 'live')).toBe(true);

  await page.getByRole('button', { name: 'Stop' }).click();
  const s0 = await snapshot(page);
  const p0 = await probe(page);
  await page.waitForTimeout(1200);
  const s1 = await snapshot(page);
  const p1 = await probe(page);
  const srcObject = await page.evaluate(() => (document.getElementById('source') as HTMLVideoElement).srcObject);
  const videoPaused = await page.evaluate(() => (document.getElementById('source') as HTMLVideoElement).paused);
  const lit = litRatio(await canvasThumb(page));
  await shot(page, 'p1-04-stopped');

  // 다시 시작했다가 정지해도 두 번째 스트림까지 모두 끝난다.
  await startViaUi(page);
  const mid = await probe(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.waitForTimeout(300);
  const p2 = await probe(page);

  const evidence = {
    beforeStop: before,
    afterStop: { snapshot: s0, probe: p0 },
    after1200ms: { snapshot: s1, probe: p1 },
    deltasAfterStop: { frameCount: s1.frameCount - s0.frameCount, rvfc: p1.rvfc - p0.rvfc, draws: p1.draws - p0.draws, bitmaps: p1.bitmaps - p0.bitmaps },
    srcObjectIsNull: srcObject === null,
    videoPaused,
    canvasLitRatioAfterStop: lit,
    status: await page.locator('#status').textContent(),
    restartLiveTracks: mid.trackStates,
    afterSecondStop: p2,
    console: consoleLog,
  };
  saveEvidence('qa6-stop', evidence);
  console.log('[QA-6 stop]', JSON.stringify(evidence));

  expect(s0.state).toBe('stopped');
  expect(s0.tracks.length).toBeGreaterThan(0);
  expect(s0.tracks.every((t) => t.readyState === 'ended')).toBe(true);
  expect(p0.streamCount).toBe(1);
  expect(p0.trackStates.every((t) => t === 'ended')).toBe(true);
  expect(s1.frameCount).toBe(s0.frameCount);
  expect(p1.rvfc).toBe(p0.rvfc);
  expect(p1.draws).toBe(p0.draws);
  expect(p1.bitmaps).toBe(p0.bitmaps);
  expect(s1.renderFps).toBe(0);
  expect(srcObject).toBeNull();
  expect(lit).toBe(0);
  expect(mid.streamCount).toBe(2);
  expect(p2.trackStates.every((t) => t === 'ended')).toBe(true);
  expect(errors).toEqual([]);
  expect(p2.errors).toEqual([]);
});

test('QA-7 세션 전체에서 앱 자신·공식 저장소 밖 요청 0건 (컨텍스트 단위 기록)', async ({ page, context }) => {
  const log = await recordRequests(context);
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await startViaUi(page);
  await page.waitForTimeout(1500);
  await page.getByLabel('Mirror').uncheck();
  await page.getByLabel('Mirror').check();
  await page.getByRole('button', { name: 'Stop' }).click();
  await startViaUi(page);
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await startViaUi(page);
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.waitForTimeout(1000);
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));

  const evidence = { requestCount: log.all.length, requests: log.all, external: log.external, resourceEntries: resources };
  saveEvidence('qa7-requests', evidence);
  console.log('[QA-7 requests]', JSON.stringify(evidence));
  expect(log.all.length).toBeGreaterThan(0);
  expect(log.external).toEqual([]);
  expect(resources.filter((u) => !isExpectedUrl(u))).toEqual([]);
  expect(errors).toEqual([]);
});

// ---- 기준 밖 탐색 ----

test('탐색: __am.start()/stop()을 기다리지 않고 10번 번갈아 불러도 새는 트랙이 없다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  await page.evaluate(async () => {
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      pending.push(window.__am.start());
      window.__am.stop();
    }
    await Promise.all(pending);
  });
  await page.waitForTimeout(1500); // 늦게 도착하는 getUserMedia 결과까지 기다린다
  const s = await snapshot(page);
  const p = await probe(page);
  const live = await page.evaluate(() => window.__qa!.streams.flatMap((st) => st.getTracks()).filter((t) => t.readyState === 'live').length);
  saveEvidence('explore-rapid-hook-start-stop', { snapshot: s, probe: p, live, console: consoleLog });
  console.log('[explore rapid hook]', JSON.stringify({ state: s.state, frameCount: s.frameCount, streams: p.streamCount, live }));
  expect(s.state).toBe('stopped');
  expect(live).toBe(0);
  expect(errors).toEqual([]);
  expect(p.errors).toEqual([]);

  // 그 뒤에도 정상 시작
  await page.evaluate(() => window.__am.start());
  await waitRunning(page);
  expect((await snapshot(page)).state).toBe('running');
});

test('탐색: UI로 시작→정지를 빠르게 10번 반복해도 새는 트랙·오류가 없다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  const toggle = page.locator('#toggle');
  for (let i = 0; i < 10; i++) {
    await toggle.click(); // 시작
    await expect(toggle).toHaveText('Stop');
    await expect(toggle).toBeEnabled(); // running
    await toggle.click(); // 정지
    await expect(toggle).toHaveText('Start');
  }
  await page.waitForTimeout(500);
  const s = await snapshot(page);
  const p = await probe(page);
  saveEvidence('explore-rapid-ui-start-stop', { snapshot: s, probe: p, console: consoleLog });
  console.log('[explore rapid ui]', JSON.stringify({ state: s.state, streams: p.streamCount, states: p.trackStates }));
  expect(s.state).toBe('stopped');
  expect(p.streamCount).toBe(10);
  expect(p.trackStates.every((t) => t === 'ended')).toBe(true);
  expect(errors).toEqual([]);
  expect(p.errors).toEqual([]);
  expect(consoleLog.filter((m) => (m.type === 'error' || m.type === 'warning') && !isMediaPipeLog(m.text))).toEqual([]);
});

test('탐색: 연결 중(starting)에 정지하면 늦게 열린 스트림도 정지되고 stopped로 남는다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installProbes(page);
  await page.goto('/');
  await page.evaluate(() => {
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      await new Promise((r) => setTimeout(r, 400));
      return gum(c);
    };
  });
  const pending = page.evaluate(() => window.__am.start());
  await expect.poll(async () => (await snapshot(page)).state).toBe('starting');
  // starting 동안 버튼 상태 (사용자는 취소할 수 없다)
  const btn = {
    text: await page.locator('#toggle').textContent(),
    disabled: await page.locator('#toggle').isDisabled(),
    placeholder: (await page.locator('.placeholder').isVisible()) ? await page.locator('.placeholder').textContent() : null,
  };
  await shot(page, 'p1-09-starting');
  await page.evaluate(() => window.__am.stop());
  await pending;
  await page.waitForTimeout(800);
  const s = await snapshot(page);
  const p = await probe(page);
  saveEvidence('explore-stop-while-starting', { buttonWhileStarting: btn, snapshot: s, probe: p });
  console.log('[explore stop while starting]', JSON.stringify({ btn, state: s.state, p }));
  expect(s.state).toBe('stopped');
  expect(p.trackStates.every((t) => t === 'ended')).toBe(true);
  expect(s.frameCount).toBe(0);
  expect(errors).toEqual([]);
});

test('탐색: 미러 체크박스를 빠르게 41번 눌러도 상태와 화면이 일치한다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await unmasked(page);
  await startViaUi(page);
  const mirror = page.getByLabel('Mirror');
  for (let i = 0; i < 41; i++) await mirror.click({ delay: 0 });
  await page.waitForTimeout(400);
  const { view, raw } = await viewAndRaw(page, W, H);
  const r = {
    checked: await mirror.isChecked(),
    hook: (await snapshot(page)).mirror,
    diffVsRaw: meanAbsDiff(view, raw),
    diffVsFlippedRaw: meanAbsDiff(view, flipThumb(raw, W, H)),
  };
  saveEvidence('explore-rapid-mirror', r);
  console.log('[explore rapid mirror]', JSON.stringify(r));
  expect(r.checked).toBe(false);
  expect(r.hook).toBe(false);
  expect(r.diffVsRaw).toBeLessThan(4);
  expect(errors).toEqual([]);
});

test('탐색: 실행 중 창 크기를 바꿔도 캔버스가 기기 픽셀에 맞고 계속 그려진다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await startViaUi(page);
  const sizes: { vw: number; vh: number; buf: number[]; css: number[]; lit: number; fps: number }[] = [];
  for (const [vw, vh] of [
    [800, 600],
    [1600, 1000],
    [1024, 400],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width: vw, height: vh });
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const c = document.getElementById('view') as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      return { buf: [c.width, c.height], css: [r.width, r.height] };
    });
    sizes.push({ vw, vh, ...m, lit: litRatio(await canvasThumb(page)), fps: (await snapshot(page)).renderFps });
  }
  await shot(page, 'p1-08-after-resize');
  saveEvidence('explore-resize', sizes);
  console.log('[explore resize]', JSON.stringify(sizes));
  for (const s of sizes) {
    expect(Math.abs(s.buf[0]! - s.css[0]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.buf[1]! - s.css[1]!)).toBeLessThanOrEqual(1);
    expect(s.lit).toBeGreaterThan(0.2);
    expect(s.fps).toBeGreaterThan(5);
  }
  expect(errors).toEqual([]);
});

test('탐색: 시작 버튼 더블클릭은 스트림을 하나만 연다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installProbes(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).dblclick();
  await page.waitForTimeout(1000);
  const s = await snapshot(page);
  const p = await probe(page);
  console.log('[explore dblclick]', JSON.stringify({ state: s.state, streams: p.streamCount, tracks: p.trackStates }));
  saveEvidence('explore-dblclick', { snapshot: s, probe: p });
  expect(p.streamCount).toBe(1);
  expect(['running', 'stopped']).toContain(s.state);
  expect(p.trackStates.filter((t) => t === 'live').length).toBe(s.state === 'running' ? 1 : 0);
  expect(errors).toEqual([]);
});

const ERROR_CASES = [
  { name: 'NotFoundError', code: 'not-found' },
  { name: 'NotReadableError', code: 'not-readable' },
  { name: 'AbortError', code: 'not-readable' },
  { name: 'SecurityError', code: 'not-allowed' },
  { name: 'TypeError', code: 'unknown' },
] as const;

for (const c of ERROR_CASES) {
  test(`탐색: getUserMedia ${c.name} → ${c.code} 한국어 안내, error 상태, 예외 없음`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.addInitScript((name) => {
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('qa', name));
    }, c.name);
    await page.goto('/');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForFunction(() => window.__am.snapshot().state === 'error');
    const s = await snapshot(page);
    console.log(`[explore ${c.name}]`, JSON.stringify({ code: s.errorCode, error: s.error }));
    expect(s.errorCode).toBe(c.code);
    expect(s.error).toMatch(/camera/i);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test('탐색: navigator.mediaDevices가 없으면 unsupported 안내', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined, configurable: true });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'error');
  const s = await snapshot(page);
  console.log('[explore unsupported]', JSON.stringify({ code: s.errorCode, error: s.error }));
  expect(s.errorCode).toBe('unsupported');
  expect(s.error).toMatch(/camera/i);
  expect(errors).toEqual([]);
});

// 알려진 문제: starting 동안 버튼을 disabled로 바꾸면 Chrome이 포커스를 body로 옮겨, 실행된 뒤 Enter/Space가 버튼에 닿지 않는다.
// 고쳐지면 이 테스트가 "예상 밖 통과"로 알려 준다. 그때 test.fail()을 지운다.
test('탐색: 키보드로 시작한 뒤 포커스가 버튼에 남아 Enter로 바로 정지할 수 있다', async ({ page }) => {
  test.fail(true, '시작 후 버튼 포커스 소실 (QA P1 이슈)');
  await page.goto('/');
  await page.keyboard.press('Tab');
  const focusedBefore = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.keyboard.press('Space');
  await waitRunning(page);
  const focusedAfter = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  saveEvidence('explore-keyboard-focus', { focusedBefore, focusedAfter });
  console.log('[explore keyboard]', JSON.stringify({ focusedBefore, focusedAfter }));
  expect(focusedBefore).toBe('toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect((await snapshot(page)).state).toBe('stopped');
});

test('탐색: 실행 중 카메라 권한을 회수하면', async ({ page, context }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  await startViaUi(page);
  await context.clearPermissions();
  await page.waitForTimeout(1500);
  const s = await snapshot(page);
  const p = await probe(page);
  const r = { state: s.state, errorCode: s.errorCode, frameCount: s.frameCount, renderFps: s.renderFps, tracks: p.trackStates, console: consoleLog };
  saveEvidence('explore-permission-revoked', r);
  console.log('[explore permission revoked]', JSON.stringify(r));
  // 관찰용: 회수 뒤 트랙이 끝났다면 disconnected 오류여야 하고, 계속 live라면 running이어야 한다.
  if (p.trackStates.every((t) => t === 'ended')) expect(s.state).toBe('error');
  else expect(s.state).toBe('running');
  expect(errors).toEqual([]);
});

test('탐색: 20초 연속 실행 동안 FPS가 안정적이고 JS 힙이 계속 늘지 않는다', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await page.goto('/');
  // P2: 동기 표시라 화면 FPS = 추론 FPS(기본 목표 8). P1 기준(>10)을 보려고 목표를 카메라와 같은 15로 둔다.
  await page.evaluate(() => window.__am.set('targetFps', 15));
  await startViaUi(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'JSHeapUsedSize')!.value;
  };
  const rows: { t: number; fps: number; frameCount: number; heapKB: number }[] = [];
  for (let i = 0; i <= 10; i++) {
    const s = await snapshot(page);
    rows.push({ t: i * 2, fps: s.renderFps, frameCount: s.frameCount, heapKB: Math.round((await heap()) / 1024) });
    if (i < 10) await page.waitForTimeout(2000);
  }
  saveEvidence('explore-long-run', { rows, console: consoleLog });
  console.log('[explore long run]', JSON.stringify(rows));
  for (const r of rows) expect(r.fps).toBeGreaterThan(10);
  expect(rows[10]!.heapKB - rows[1]!.heapKB).toBeLessThan(1024);
  expect(errors).toEqual([]);
  expect(consoleLog.filter((m) => (m.type === 'error' || m.type === 'warning') && !isMediaPipeLog(m.text))).toEqual([]);
});
