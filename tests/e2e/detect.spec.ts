import { expect, test } from '@playwright/test';
import { iou } from '../../src/core/geometry';
import { collectPageErrors, snapshot, startApp, useFakeCamera } from './helpers';
import { nextFrames, regionStats, toCanvasRect } from './pixels';

// P2 검출: 정지 1인 픽스처 (원본 portrait.jpg를 x 80부터 640×480으로 자른 것; 얼굴은 대략 x 195–450, y 30–360)
useFakeCamera('still-1face.y4m');

test('정면 얼굴 하나를 점수 0.5 이상으로 찾고 박스가 얼굴 위에 있다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 3);
  const s = await snapshot(page);
  expect(s.detectorState).toBe('ready');
  expect(s.detectorId).toBe('mediapipe-face-short');
  expect(s.location).toBe('worker'); // P3: 기본 실행 위치
  expect(s.workers.live).toBe(1);
  expect(s.detections).toHaveLength(1);
  const d = s.detections[0]!;
  expect(d.label).toBe('face');
  expect(d.score).toBeGreaterThanOrEqual(0.5);
  const cx = d.box.x + d.box.width / 2;
  const cy = d.box.y + d.box.height / 2;
  expect(cx).toBeGreaterThan(195);
  expect(cx).toBeLessThan(450);
  expect(cy).toBeGreaterThan(30);
  expect(cy).toBeLessThan(360);
  expect(d.box.width).toBeGreaterThan(120);
  expect(d.box.width).toBeLessThan(330);
  // 키포인트 6개(눈, 코, 입, 귀)가 박스 근처에 있다
  expect(d.keypoints).toHaveLength(6);
  for (const k of d.keypoints) {
    expect(k.x).toBeGreaterThan(d.box.x - 20);
    expect(k.x).toBeLessThan(d.box.x + d.box.width + 20);
    expect(k.y).toBeGreaterThan(d.box.y - 20);
    expect(k.y).toBeLessThan(d.box.y + d.box.height + 20);
  }
  // 모자이크 영역 = 박스 × 패딩 1.3 (중심 유지, 정수 픽셀로 바깥쪽 맞춤)
  expect(s.regions).toHaveLength(1);
  const r = s.regions[0]!;
  expect(r.width).toBeGreaterThanOrEqual(Math.floor(d.box.width * 1.3));
  expect(r.width).toBeLessThanOrEqual(Math.ceil(d.box.width * 1.3) + 1);
  expect(Math.abs(r.x + r.width / 2 - cx)).toBeLessThanOrEqual(1);
  expect(s.inferenceFps).toBeGreaterThan(4);
  expect(s.inferenceMs).toBeGreaterThan(0);
  expect(['GPU', 'CPU']).toContain(s.activeDelegate);
  await expect(page.locator('#detector')).toContainText('Detector ready');
  expect(errors).toEqual([]);
});

test('추론 해상도(320/480/원본)를 바꿔도 같은 자리에서 찾는다 (원본 좌표로 되돌림)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);
  const base = (await snapshot(page)).detections[0]!.box;
  for (const size of [320, 480, 0, 640]) {
    expect(await page.evaluate((v) => window.__am.set('inferenceSize', v), size)).toBe(true);
    await nextFrames(page, 2);
    const s = await snapshot(page);
    expect(s.detections, `size ${size}`).toHaveLength(1);
    expect(iou(s.detections[0]!.box, base), `size ${size}`).toBeGreaterThan(0.8);
  }
  expect(errors).toEqual([]);
});

test('디버그 오버레이를 켜면 박스·점수가 그려지고 끄면 사라진다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);
  const greenPixels = (): Promise<number> =>
    page.evaluate(() => {
      const c = document.getElementById('view') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 80 && d[i + 1]! > 170 && d[i + 2]! < 120) n++; // #22c55e
      return n;
    });
  const off = await greenPixels();
  await page.getByLabel('Debug overlay').check();
  expect(await page.evaluate(() => window.__am.get('debug'))).toBe(true);
  const on = await greenPixels();
  await page.getByLabel('Debug overlay').uncheck();
  const offAgain = await greenPixels();
  expect(on).toBeGreaterThan(off + 500);
  expect(offAgain).toBeLessThan(on / 4);
  expect(errors).toEqual([]);
});

// drawnFrameId는 렌더러가 기록하므로 다른 경로로 프레임을 그리면 어긋난다. 프레임과 검출 결과의 짝은 sync-moving.spec.ts가 픽셀로 본다.
test('동기 표시: 화면의 프레임은 언제나 검출이 끝난 바로 그 프레임이다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  // 페이지 안에서 매 프레임 표본을 모은다 (2초)
  const samples = await page.evaluate(
    () =>
      new Promise<{ drawn: number | null; detected: number | null; count: number }[]>((resolve) => {
        const out: { drawn: number | null; detected: number | null; count: number }[] = [];
        const t0 = performance.now();
        const tick = (): void => {
          const s = window.__am.snapshot();
          out.push({ drawn: s.drawnFrameId, detected: s.detectionFrameId, count: s.frameCount });
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
  );
  expect(samples.length).toBeGreaterThan(30);
  expect(samples.every((x) => x.drawn !== null && x.drawn === x.detected)).toBe(true);
  // 프레임 id는 줄지 않고, 그사이 여러 번 바뀐다
  const ids = samples.map((x) => x.drawn!);
  for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThanOrEqual(ids[i - 1]!);
  expect(new Set(ids).size).toBeGreaterThan(8);
  expect(errors).toEqual([]);
});

test('얼굴 영역은 시작하자마자 첫 프레임부터 모자이크되어 있다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().frameCount >= 1);
  const s = await snapshot(page);
  expect(s.frameCount).toBeLessThanOrEqual(2);
  const stats = await regionStats(page, await toCanvasRect(page, s.regions[0]!));
  expect(stats.flat).toBeGreaterThan(0.9);
  expect(errors).toEqual([]);
});

test('목표 1fps에서도 추론 FPS·렌더 FPS가 0으로 읽히지 않는다 (측정 창이 목표 FPS를 따른다)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  expect(await page.evaluate(() => window.__am.set('targetFps', 1))).toBe(true);
  await page.waitForTimeout(3000); // 8fps 때 프레임이 측정 창(2.5초)에서 빠질 때까지
  // 패널 모니터처럼 250ms마다 3초 동안 읽는다
  const readings = await page.evaluate(
    () =>
      new Promise<{ inference: number; render: number; stats: string }[]>((resolve) => {
        const out: { inference: number; render: number; stats: string }[] = [];
        const id = setInterval(() => {
          const s = window.__am.snapshot();
          out.push({ inference: s.inferenceFps, render: s.renderFps, stats: document.getElementById('stats')!.textContent ?? '' });
          if (out.length >= 12) {
            clearInterval(id);
            resolve(out);
          }
        }, 250);
      }),
  );
  console.log('[1fps]', JSON.stringify(readings.map((r) => Math.round(r.inference * 100) / 100)));
  for (const r of readings) {
    expect(r.inference).toBeGreaterThan(0.5);
    expect(r.inference).toBeLessThan(1.6);
    expect(r.render).toBeGreaterThan(0.5);
    expect(r.stats).not.toContain('Render 0.0 FPS');
  }
  expect(errors).toEqual([]);
});
