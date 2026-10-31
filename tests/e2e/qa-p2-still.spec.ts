// QA P2 (정지 1인 픽스처): 검출(기준 1), 모자이크(3), 실시간 파라미터(4), 모델·실행 장치 전환(5), 동기 표시(6).
// 수치는 window.__am, 캔버스 픽셀, 프레임 신원 계측(qa-p2-helpers)에서 얻는다.
import { expect, test, type Page } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, collectDetections, grid, installQa2, probe2, save2, shot2, waitFrames } from './qa-p2-helpers';

useFakeCamera('still-1face.y4m');

// 손으로 잡은 정답 (still-1face.y4m 첫 프레임, 640×480 원본 좌표, 40px 격자 위에서 읽음)
const TRUTH = {
  face: { x: 205, y: 85, width: 235, height: 250 }, // 귀~귀, 이마 머리선~턱
  points: {
    leftEye: { x: 285, y: 172 },
    rightEye: { x: 372, y: 172 },
    nose: { x: 327, y: 228 },
    mouth: { x: 327, y: 268 },
  },
  center: { x: 325, y: 215 },
};

function iou(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.width * a.height + b.width * b.height - w * h);
}

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.frameCount >= 3 && s.detections.length > 0;
  });
}

async function hookSet(page: Page, key: string, value: unknown): Promise<void> {
  expect(await page.evaluate(([k, v]) => window.__am.set(k as string, v as never), [key, value] as const), `${key}=${String(value)}`).toBe(true);
}

async function region(page: Page): Promise<Rect> {
  const s = await snapshot(page);
  expect(s.regions, 'regions').toHaveLength(1);
  return s.regions[0]!;
}

test('P2-1 정지 1인: 얼굴 1개, 점수 ≥ 0.5, 박스가 얼굴 위', async ({ page }) => {
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa2(page);
  await start(page);
  const frames = await collectDetections(page, 16);
  const s = await snapshot(page);
  const d = s.detections[0]!;
  const box = d.box;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const pts = Object.fromEntries(Object.entries(TRUTH.points).map(([k, p]) => [k, contains(box, p)]));
  const iouTruth = iou(box, TRUTH.face);
  // MediaPipe 키포인트 0,1 = 두 눈 (화면 기준 오른쪽 눈이 먼저일 수 있어 가까운 쪽으로 맞춘다)
  const kp = d.keypoints.slice(0, 2);
  const eyeErr = Math.max(
    ...kp.map((k) => Math.min(Math.hypot(k.x - TRUTH.points.leftEye.x, k.y - TRUTH.points.leftEye.y), Math.hypot(k.x - TRUTH.points.rightEye.x, k.y - TRUTH.points.rightEye.y))),
  );
  const detectorText = await page.locator('#detector').textContent();
  const shots = [await shot2(page, 'p2-01-still-mosaic'), await shot2(page, 'p2-01b-still-mosaic-canvas', { canvasOnly: true })];
  await hookSet(page, 'debug', true);
  shots.push(await shot2(page, 'p2-02-still-debug-overlay'));
  await hookSet(page, 'debug', false);

  const evidence = {
    frames,
    detection: d,
    region: s.regions,
    center,
    pointsInside: pts,
    iouWithHandLabel: iouTruth,
    centerError: Math.hypot(center.x - TRUTH.center.x, center.y - TRUTH.center.y),
    eyeKeypointError: eyeErr,
    detectorText,
    activeDelegate: s.activeDelegate,
    delegateFallback: s.delegateFallback,
    shots,
  };
  save2('qa-p2-1-still-detection', evidence);
  console.log('[P2-1]', JSON.stringify({ ...evidence, frames: frames.map((f) => f.count) }));

  expect(frames.every((f) => f.count === 1), 'every analysed frame has exactly 1 face').toBe(true);
  expect(Math.min(...frames.flatMap((f) => f.scores))).toBeGreaterThanOrEqual(0.5);
  expect(d.label).toBe('face');
  expect(Object.values(pts).every(Boolean), JSON.stringify(pts)).toBe(true);
  expect(iouTruth).toBeGreaterThan(0.5);
  expect(evidence.centerError).toBeLessThan(35);
  expect(eyeErr).toBeLessThan(25);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});

test('P2-3 모자이크: 박스 안 블록 균일, 박스 밖 = 모자이크 없는 렌더, 강도 0이면 디테일', async ({ page }) => {
  const errors = collectPageErrors(page);
  await installQa2(page);
  await start(page);
  await waitFrames(page, 2);

  const r = await region(page);
  const p = await page.evaluate(() => window.__am.params());
  const g = grid(r, String(p.blockMode), Number(p.blockSize), Number(p.blockCells));
  const canvasRect = await page.evaluate((r) => window.__qa2.toCanvas(r), r);
  const vr = (await snapshot(page)).viewRect;
  const scale = vr.width / 640;
  const blocks = await page.evaluate(([r, c, rr]) => window.__qa2.blockCheck(r, c, rr), [r, g.cols, g.rows] as const);
  const spacingX = await page.evaluate((c) => window.__qa2.spacing(c, 'x'), canvasRect);
  const spacingY = await page.evaluate((c) => window.__qa2.spacing(c, 'y'), canvasRect);
  const maskedDetail = await page.evaluate((c) => window.__qa2.detail(c), canvasRect);
  // 같은 분석 프레임을 강도 0(이펙트 없음)으로 다시 그려 비교
  const same = await page.evaluate((r) => window.__qa2.sameFrame('strength', 0, [r]), r);

  await hookSet(page, 'strength', 0);
  const plainDetail = await page.evaluate((c) => window.__qa2.detail(c), canvasRect);
  const plainBlocks = await page.evaluate(([r, c, rr]) => window.__qa2.blockCheck(r, c, rr), [r, g.cols, g.rows] as const);
  const shots = [await shot2(page, 'p2-03-strength0-canvas', { canvasOnly: true })];
  await hookSet(page, 'strength', 0.5);
  const halfDetail = await page.evaluate((c) => window.__qa2.detail(c), canvasRect);
  await hookSet(page, 'strength', 1);
  shots.push(await shot2(page, 'p2-03b-strength1-canvas', { canvasOnly: true }));

  const evidence = {
    region: r,
    canvasRect,
    grid: g,
    expectedBlockCanvasPx: { x: (r.width / g.cols) * scale, y: (r.height / g.rows) * scale },
    blocks,
    spacingX,
    spacingY,
    maskedDetail,
    sameFrame: same,
    plainDetail,
    plainBlocks,
    halfDetail,
    shots,
  };
  save2('qa-p2-3-mosaic', evidence);
  console.log('[P2-3]', JSON.stringify(evidence));

  // 블록 안쪽 픽셀은 같다 (허용 2/255)
  expect(blocks.uniformFrac).toBeGreaterThanOrEqual(0.98);
  expect(blocks.p95Range).toBeLessThanOrEqual(2);
  // 얼굴 내용이 블록으로 남아 있다 (한 색으로 덮은 것이 아님)
  expect(blocks.distinct).toBeGreaterThan(blocks.blocks * 0.5);
  expect(blocks.meanAdjDiff).toBeGreaterThan(3);
  // 픽셀에서 잰 블록 간격 ≈ 기대 블록 크기
  expect(Math.abs(spacingX.median - evidence.expectedBlockCanvasPx.x)).toBeLessThan(evidence.expectedBlockCanvasPx.x * 0.25);
  // 박스 밖: 같은 프레임의 모자이크 없는 렌더와 같다. 박스 안은 다르다.
  expect(same.frameA).toBe(same.frameB);
  expect(same.outside.max).toBeLessThanOrEqual(2);
  expect(same.outside.mean).toBeLessThan(0.01);
  expect(same.inside.mean).toBeGreaterThan(5);
  // 강도 0: 디테일 (블록이 아니다)
  expect(plainBlocks.uniformFrac).toBeLessThan(0.3);
  expect(plainDetail.flat).toBeLessThan(0.6);
  expect(plainDetail.distinct).toBeGreaterThan(maskedDetail.distinct * 3);
  expect(maskedDetail.flat).toBeGreaterThan(0.95);
  expect(errors).toEqual([]);
});

test('P2-4 실시간 파라미터 (패널 UI): 블록 크기·신뢰도·단색·패딩, 새로고침·재시작 없음', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  let navigations = 0;
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  await installQa2(page);
  await start(page);
  await page.evaluate(() => ((window as unknown as { __loadId: number }).__loadId = Math.random()));
  const loadId = await page.evaluate(() => (window as unknown as { __loadId: number }).__loadId);
  const fc: number[] = [(await snapshot(page)).frameCount];
  const mark = async (): Promise<void> => {
    fc.push((await snapshot(page)).frameCount);
  };
  const ev: Record<string, unknown> = {};
  const shots: string[] = [];

  // ── 블록 크기: 절대 8px → 32px, 상대 24칸 → 6칸 (UI 입력)
  await page.getByLabel('Block size mode').selectOption({ label: 'Absolute (px)' });
  const sizeInput = page.getByLabel('Block size (px)');
  const blockRuns: Record<string, unknown> = {};
  const measureBlocks = async (name: string): Promise<{ spacing: number; uniform: number; cols: number }> => {
    const r = await region(page);
    const p = await page.evaluate(() => window.__am.params());
    const g = grid(r, String(p.blockMode), Number(p.blockSize), Number(p.blockCells));
    const c = await page.evaluate((r) => window.__qa2.toCanvas(r), r);
    const sp = await page.evaluate((c) => window.__qa2.spacing(c, 'x'), c);
    const bc = await page.evaluate(([r, cc, rr]) => window.__qa2.blockCheck(r, cc, rr), [r, g.cols, g.rows] as const);
    const out = { spacing: sp.median, uniform: bc.uniformFrac, cols: g.cols, rows: g.rows, params: { mode: p.blockMode, size: p.blockSize, cells: p.blockCells } };
    blockRuns[name] = out;
    return out;
  };
  await sizeInput.fill('8');
  await sizeInput.press('Enter');
  await waitFrames(page, 1);
  const abs8 = await measureBlocks('abs8');
  shots.push(await shot2(page, 'p2-04-block-abs8-canvas', { canvasOnly: true }));
  await sizeInput.fill('32');
  await sizeInput.press('Enter');
  await waitFrames(page, 1);
  const abs32 = await measureBlocks('abs32');
  shots.push(await shot2(page, 'p2-04b-block-abs32-canvas', { canvasOnly: true }));
  await page.getByLabel('Block size mode').selectOption({ label: 'Relative (cells across region)' });
  const cellsInput = page.getByLabel('Block count (cells)');
  await cellsInput.fill('24');
  await cellsInput.press('Enter');
  const rel24 = await measureBlocks('rel24');
  await cellsInput.fill('6');
  await cellsInput.press('Enter');
  const rel6 = await measureBlocks('rel6');
  await cellsInput.fill('10');
  await cellsInput.press('Enter');
  ev.blocks = blockRuns;
  await mark();

  // ── 신뢰도 0.99 → 0개, 0.5 → 다시 1개 (UI 숫자 입력, Enter)
  const conf = page.getByLabel('Min confidence');
  await conf.fill('0.99');
  await conf.press('Enter');
  expect(await page.evaluate(() => window.__am.get('minConfidence'))).toBe(0.99);
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 0, undefined, { timeout: 5000 });
  const at099 = await collectDetections(page, 10);
  const s099 = await snapshot(page);
  const face099 = await page.evaluate(() => window.__qa2.detail(window.__qa2.toCanvas({ x: 181, y: 85, width: 292, height: 292 })));
  shots.push(await shot2(page, 'p2-05-confidence-099'));
  await conf.fill('0.5');
  await conf.press('Enter');
  await page.waitForFunction(() => window.__am.snapshot().detections.length === 1, undefined, { timeout: 5000 });
  const at05 = await collectDetections(page, 10);
  ev.confidence = { at099: at099.map((f) => f.count), regions099: s099.regions.length, faceDetailAt099: face099, at05: at05.map((f) => f.count), scores05: at05.map((f) => f.scores) };
  await mark();

  // ── 이펙트 → 단색 (UI 선택), 색 바꾸기
  const before = await region(page);
  await page.getByRole('complementary', { name: 'Advanced settings' }).getByLabel('Effect').selectOption({ label: 'Solid fill' });
  expect(await page.evaluate(() => window.__am.get('effect'))).toBe('solid');
  const solidBlack = await page.evaluate((r) => window.__qa2.solid(window.__qa2.toCanvas(r), [0, 0, 0]), before);
  await hookSet(page, 'solidColor', '#ff00ff');
  await waitFrames(page, 1);
  const rSolid = await region(page);
  const solidMagenta = await page.evaluate((r) => window.__qa2.solid(window.__qa2.toCanvas(r), [255, 0, 255]), rSolid);
  const solidVsPixelate = await page.evaluate((r) => window.__qa2.sameFrame('effect', 'pixelate', [r]), rSolid);
  shots.push(await shot2(page, 'p2-06-solid-magenta'));
  ev.solid = { region: rSolid, solidBlack, solidMagenta, solidVsPixelate };
  await mark();

  // ── 패딩 1.0 → 1.5 → 2.0 (UI 숫자 입력): 영역과 단색 면적
  const pad = page.getByLabel('Padding');
  const pads: Record<string, { region: Rect; magentaPx: number; detBox: Rect }> = {};
  for (const v of ['1', '1.5', '2']) {
    await pad.fill(v);
    await pad.press('Enter');
    await waitFrames(page, 1);
    const s = await snapshot(page);
    pads[v] = { region: s.regions[0]!, magentaPx: await page.evaluate(() => window.__qa2.countColor([255, 0, 255])), detBox: s.detections[0]!.box };
    if (v !== '1.5') shots.push(await shot2(page, `p2-07-padding-${v}-canvas`, { canvasOnly: true }));
  }
  await pad.fill('1.3');
  await pad.press('Enter');
  ev.padding = pads;
  await mark();

  const end = await snapshot(page);
  const p2 = await probe2(page);
  const loadIdAfter = await page.evaluate(() => (window as unknown as { __loadId: number }).__loadId);
  ev.session = { navigations, loadId, loadIdAfter, frameCounts: fc, gum: p2.gum, tracks: end.tracks, state: end.state, drawnUnanalysed: p2.drawnUnanalysed };
  ev.shots = shots;
  save2('qa-p2-4-live-params', ev);
  console.log('[P2-4]', JSON.stringify(ev));

  // 블록 크기: 커지면 픽셀에서 잰 블록 간격도 커진다
  expect(abs32.spacing).toBeGreaterThan(abs8.spacing * 3);
  expect(rel6.spacing).toBeGreaterThan(rel24.spacing * 3);
  expect(Math.min(abs8.uniform, abs32.uniform, rel24.uniform, rel6.uniform)).toBeGreaterThanOrEqual(0.95);
  // 신뢰도
  expect(at099.every((f) => f.count === 0)).toBe(true);
  expect(s099.regions).toHaveLength(0);
  expect(face099.flat).toBeLessThan(0.6); // 가리지 않은 얼굴
  expect(at05.every((f) => f.count === 1)).toBe(true);
  // 단색
  expect(solidBlack.match).toBeGreaterThanOrEqual(0.999);
  expect(solidMagenta.match).toBeGreaterThanOrEqual(0.999);
  expect(solidVsPixelate.outside.max).toBeLessThanOrEqual(2);
  // 패딩: 영역 폭 = 검출 폭 × 패딩 (±2px), 면적 증가
  for (const [v, x] of Object.entries(pads)) expect(Math.abs(x.region.width - x.detBox.width * Number(v))).toBeLessThanOrEqual(2);
  expect(pads['1.5']!.region.width).toBeGreaterThan(pads['1']!.region.width * 1.4);
  expect(pads['2']!.region.width).toBeGreaterThan(pads['1.5']!.region.width * 1.25);
  expect(pads['2']!.magentaPx).toBeGreaterThan(pads['1.5']!.magentaPx * 1.5);
  expect(pads['1.5']!.magentaPx).toBeGreaterThan(pads['1']!.magentaPx * 1.9);
  // 새로고침·재시작 없음: 같은 문서, 카메라 1번만 열림, frameCount는 계속 증가, 계속 running
  expect(navigations).toBe(1);
  expect(loadIdAfter).toBe(loadId);
  expect(p2.gum).toBe(1);
  for (let i = 1; i < fc.length; i++) expect(fc[i]!).toBeGreaterThan(fc[i - 1]!);
  expect(end.state).toBe('running');
  expect(end.tracks.every((t) => t.readyState === 'live')).toBe(true);
  expect(p2.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});

test('P2-5/6 모델 short↔full, 실행 장치 GPU↔CPU 실행 중 전환 + 동기 표시 (rAF 표본, 프레임 신원)', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const cons = collectConsole(page);
  await installQa2(page);
  await start(page);
  await page.evaluate(() => window.__qa2.startSampler());
  const steps: Record<string, unknown>[] = [];
  const shots: string[] = [];

  const step = async (name: string, label: string, option: string, expectId: string, expectDelegate: string): Promise<void> => {
    const t0 = Date.now();
    await page.getByLabel(label).selectOption({ label: option });
    await page.waitForFunction(
      ([id, dlg]) => {
        const s = window.__am.snapshot();
        return s.detectorState === 'ready' && s.detectorId === id && s.activeDelegate === dlg;
      },
      [expectId, expectDelegate] as const,
      { timeout: 20_000 },
    );
    const readyMs = Date.now() - t0;
    const frames = await collectDetections(page, 6);
    const s = await snapshot(page);
    const detectorText = await page.locator('#detector').textContent();
    const monitorDelegate = await page
      .locator('.tp-lblv', { has: page.locator('.tp-lblv_l', { hasText: /^Delegate$/ }) })
      .last()
      .locator('input, textarea')
      .first()
      .inputValue()
      .catch(() => null);
    steps.push({ name, readyMs, detectorId: s.detectorId, activeDelegate: s.activeDelegate, fallback: s.delegateFallback, counts: frames.map((f) => f.count), scores: frames.map((f) => f.scores[0]), detectorText, monitorDelegate, state: s.state });
    expect(s.state).toBe('running');
    expect(frames.every((f) => f.count === 1), name).toBe(true);
    expect(detectorText).toContain(expectDelegate);
  };

  await step('short→full', 'Model', 'BlazeFace full-range', 'mediapipe-face-full', 'GPU');
  shots.push(await shot2(page, 'p2-08-full-range-gpu'));
  await step('GPU→CPU (full)', 'Delegate', 'CPU', 'mediapipe-face-full', 'CPU');
  shots.push(await shot2(page, 'p2-09-full-range-cpu'));
  await step('full→short (CPU)', 'Model', 'BlazeFace short-range', 'mediapipe-face-short', 'CPU');
  await step('CPU→GPU (short)', 'Delegate', 'GPU', 'mediapipe-face-short', 'GPU');

  const samples = await page.evaluate(() => window.__qa2.stopSampler());
  const p = await probe2(page);
  const mismatched = samples.filter((x) => x.drawn !== x.det);
  const loading = samples.filter((x) => x.state === 'loading');
  // 불러오는 동안 새로 그려진 프레임 수 (진행 중이던 한 프레임은 끝날 수 있다)
  let drawnWhileLoading = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.state === 'loading' && samples[i - 1]!.state === 'loading' && samples[i]!.frameCount !== samples[i - 1]!.frameCount) drawnWhileLoading++;
  }
  const ev = {
    steps,
    rafSamples: samples.length,
    loadingSamples: loading.length,
    mismatched: mismatched.slice(0, 10),
    mismatchedCount: mismatched.length,
    drawnWhileLoading,
    frameProbe: { ...p, drawnIds: p.drawnIds.length },
    shots,
  };
  save2('qa-p2-5-6-switching', ev);
  console.log('[P2-5/6]', JSON.stringify(ev));

  expect(samples.length).toBeGreaterThan(50);
  expect(loading.length).toBeGreaterThan(3);
  expect(mismatched).toEqual([]);
  expect(drawnWhileLoading).toBeLessThanOrEqual(4); // 전환 4번 × 진행 중이던 프레임 최대 1개
  // 화면에 그려진 모든 비트맵은 MediaPipe가 분석(WebGL 업로드)한 카메라 프레임이다
  expect(p.uploads).toBeGreaterThan(0);
  expect(p.drawn).toBeGreaterThan(10);
  expect(p.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
  expect(appConsoleProblems(cons)).toEqual([]);
});

test('P2-6 검출기를 불러오는 동안·다시 만드는 동안 원본 프레임이 보이지 않는다', async ({ page, context }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  const delayed: string[] = [];
  const delays: Record<string, number> = { blaze_face_short_range: 4000, blaze_face_full_range: 3000 };
  await context.route(/\/blaze_face_(short|full)_range\.tflite$/, async (route) => {
    const key = Object.keys(delays).find((k) => route.request().url().includes(k))!;
    delayed.push(`${key} ${delays[key]}ms`);
    await new Promise((r) => setTimeout(r, delays[key]));
    await route.continue();
  });
  await installQa2(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running');

  // 카메라는 켜졌지만 검출기는 아직 불러오는 중: 화면은 비어 있어야 한다
  const during: { t: number; lit: number; detector: string; drawn: number | null; note: string | null }[] = [];
  for (let i = 0; i < 6; i++) {
    const s = await snapshot(page);
    if (s.detectorState !== 'loading') break;
    during.push({ t: i * 300, lit: await page.evaluate(() => window.__qa2.lit()), detector: s.detectorState, drawn: s.drawnFrameId, note: await page.locator('#stage-note').textContent() });
    if (i === 1) await shot2(page, 'p2-10-loading-blank');
    await page.waitForTimeout(300);
  }
  const videoLive = await page.evaluate(() => (document.getElementById('source') as HTMLVideoElement).videoWidth);
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1, undefined, { timeout: 15_000 });
  const first = await snapshot(page);
  const r = first.regions[0]!;
  const p = await page.evaluate(() => window.__am.params());
  const g = grid(r, String(p.blockMode), Number(p.blockSize), Number(p.blockCells));
  const firstBlocks = await page.evaluate(([r, c, rr]) => window.__qa2.blockCheck(r, c, rr), [r, g.cols, g.rows] as const);
  const probeAtFirst = await probe2(page);

  // 다시 만드는 동안 (full-range 모델 3초 지연): 마지막 분석 프레임이 그대로 남는다
  await waitFrames(page, 3);
  const hashBefore = await page.evaluate(() => window.__qa2.hash());
  const fcBefore = (await snapshot(page)).frameCount;
  await hookSet(page, 'model', 'mediapipe-face-full');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'loading');
  const reload: { hash: number; fc: number; note: string | null; drawn: number | null; det: number | null }[] = [];
  for (let i = 0; i < 6; i++) {
    const s = await snapshot(page);
    if (s.detectorState !== 'loading') break;
    reload.push({ hash: await page.evaluate(() => window.__qa2.hash()), fc: s.frameCount, note: await page.locator('#stage-note').textContent(), drawn: s.drawnFrameId, det: s.detectionFrameId });
    if (i === 1) await shot2(page, 'p2-11-reloading-last-frame');
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready', undefined, { timeout: 15_000 });
  await waitFrames(page, 2);
  const pEnd = await probe2(page);

  const ev = { delayed, during, videoWidthWhileLoading: videoLive, firstFrame: { frameCount: first.frameCount, region: r, blocks: firstBlocks }, probeAtFirst: { ...probeAtFirst, drawnIds: probeAtFirst.drawnIds.length }, hashBefore, fcBefore, reload, probeEnd: { ...pEnd, drawnIds: pEnd.drawnIds.length } };
  save2('qa-p2-6-loading', ev);
  console.log('[P2-6 loading]', JSON.stringify(ev));

  expect(during.length).toBeGreaterThanOrEqual(3);
  expect(videoLive).toBe(640); // 카메라는 이미 프레임을 내고 있었다
  for (const x of during) {
    expect(x.lit).toBe(0);
    expect(x.drawn).toBeNull();
    expect(x.note).toMatch(/loading detector/i);
  }
  // 처음 그린 프레임부터 모자이크, 그 전에 분석
  expect(firstBlocks.uniformFrac).toBeGreaterThanOrEqual(0.98);
  expect(probeAtFirst.drawnUnanalysed).toBe(0);
  expect(probeAtFirst.firstUploadAt!).toBeLessThan(probeAtFirst.firstDrawAt!);
  // 다시 만드는 동안: 화면·frameCount 고정 (진행 중이던 한 프레임은 끝날 수 있어 첫 표본은 뺀다)
  expect(reload.length).toBeGreaterThanOrEqual(3);
  const settled = reload.slice(1);
  expect(new Set(settled.map((x) => x.hash)).size).toBe(1);
  expect(new Set(settled.map((x) => x.fc)).size).toBe(1);
  for (const x of reload) {
    expect(x.drawn).toBe(x.det);
    expect(x.note).toContain('Reloading detector');
  }
  expect(reload[0]!.fc - fcBefore).toBeLessThanOrEqual(1);
  expect(hashBefore).toBeGreaterThan(0);
  expect(pEnd.drawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
});
