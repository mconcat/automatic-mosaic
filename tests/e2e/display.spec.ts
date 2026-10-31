import { expect, test, type Page } from '@playwright/test';
import type { RenderRecord } from '../../src/core/pipeline';
import type { Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, startApp, useFakeCamera } from './helpers';
import { toCanvasRect } from './pixels';

// P3 표시 모드: 동기(기본)는 그린 프레임 = 검출 프레임, 비동기는 카메라 속도로 그리고 최신 박스를 쓴다.
useFakeCamera('still-1face.y4m');

async function lastSeq(page: Page): Promise<number> {
  return (await page.evaluate(() => window.__am.renders().at(-1)?.seq)) ?? 0;
}

async function rendersFor(page: Page, ms: number): Promise<RenderRecord[]> {
  const seq = await lastSeq(page);
  await page.waitForTimeout(ms);
  return page.evaluate((s) => window.__am.renders(s), seq);
}

interface Sample {
  drawn: number | null;
  det: number | null;
  mode: string;
  cover: boolean;
  flat: number; // 얼굴 영역(캔버스 rect)의 평평함
}

// rAF마다 상태와 얼굴 영역 픽셀을 표본으로 모은다
function sample(page: Page, rect: Rect, ms: number): Promise<Sample[]> {
  return page.evaluate(
    ({ r, ms }) =>
      new Promise<Sample[]>((resolve) => {
        const ctx = (document.getElementById('view') as HTMLCanvasElement).getContext('2d')!;
        const x = Math.ceil(r.x + 3);
        const y = Math.ceil(r.y + 3);
        const w = Math.floor(r.width - 6);
        const h = Math.floor(r.height - 6);
        const out: Sample[] = [];
        const t0 = performance.now();
        const tick = (): void => {
          const s = window.__am.snapshot();
          const d = ctx.getImageData(x, y, w, h).data;
          let flat = 0;
          let pairs = 0;
          for (let i = 4; i < d.length; i += 4) {
            if ((i / 4) % w === 0) continue;
            pairs++;
            if (Math.max(Math.abs(d[i]! - d[i - 4]!), Math.abs(d[i + 1]! - d[i - 3]!), Math.abs(d[i + 2]! - d[i - 2]!)) <= 4) flat++;
          }
          out.push({ drawn: s.drawnFrameId, det: s.detectionFrameId, mode: s.displayMode, cover: s.fullCover, flat: flat / pairs });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
    { r: rect, ms },
  );
}

test('동기(기본): 그린 프레임마다 drawn = detection, 렌더 FPS = 추론 FPS', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const s0 = await snapshot(page);
  expect(s0.displayMode).toBe('sync');
  const rect = await toCanvasRect(page, s0.regions[0]!);
  const [recs, samples] = await Promise.all([rendersFor(page, 3000), sample(page, rect, 3000)]);
  const s = await snapshot(page);
  console.log('[sync]', JSON.stringify({ renders: recs.length, samples: samples.length, renderFps: s.renderFps, inferenceFps: s.inferenceFps, minFlat: Math.min(...samples.map((x) => x.flat)) }));
  expect(recs.length).toBeGreaterThan(18); // 목표 8fps × 3초
  for (const r of recs) expect([r.mode, r.frameId, r.fullCover]).toEqual(['sync', r.detectionFrameId, false]);
  expect(new Set(recs.map((r) => r.frameId)).size).toBe(recs.length); // 같은 프레임을 두 번 세지 않는다
  for (const x of samples) {
    expect(x.drawn).toBe(x.det);
    expect(x.flat).toBeGreaterThan(0.9);
  }
  expect(Math.abs(s.renderFps - s.inferenceFps)).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});

test('비동기: 카메라 속도로 그리고(렌더 FPS > 추론 FPS) 최신 박스(패딩 적용)로 얼굴을 계속 가린다. 동기로 돌아오면 다시 drawn = detection', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await page.getByLabel('Display mode').selectOption({ label: 'Async' });
  expect(await page.evaluate(() => window.__am.get('displayMode'))).toBe('async');
  await page.waitForTimeout(1500); // FPS 창이 채워지게
  const s0 = await snapshot(page);
  const rect = await toCanvasRect(page, s0.regions[0]!);
  const [recs, samples] = await Promise.all([rendersFor(page, 3000), sample(page, rect, 3000)]);
  const s = await snapshot(page);
  const lagging = recs.filter((r) => r.detectionFrameId !== null && r.detectionFrameId < r.frameId).length;
  const ev = {
    renderFps: Math.round(s.renderFps * 10) / 10,
    inferenceFps: Math.round(s.inferenceFps * 10) / 10,
    renders: recs.length,
    detectionFrames: new Set(recs.map((r) => r.detectionFrameId)).size,
    lagging,
    covered: recs.filter((r) => r.fullCover).length,
    minFlat: Math.min(...samples.map((x) => x.flat)),
    region: s.regions[0],
    box: s.detections[0]?.box,
  };
  console.log('[async]', JSON.stringify(ev));
  expect(s.renderFps).toBeGreaterThan(12); // 카메라 15fps
  expect(s.inferenceFps).toBeLessThan(10); // 목표 8fps
  expect(s.renderFps).toBeGreaterThan(s.inferenceFps * 1.5);
  expect(recs.length).toBeGreaterThan(36); // 15fps × 3초의 80%
  expect(ev.detectionFrames * 1.5).toBeLessThan(recs.length);
  expect(lagging).toBeGreaterThan(recs.length * 0.3); // 앞선 검출 프레임의 박스로 그린 프레임
  for (const r of recs) {
    expect(r.mode).toBe('async');
    expect(r.fullCover).toBe(false);
    expect(r.detectionFrameId).not.toBeNull();
    expect(r.detectionFrameId!).toBeLessThanOrEqual(r.frameId);
  }
  for (const x of samples) {
    expect(x.cover).toBe(false);
    expect(x.flat).toBeGreaterThan(0.9);
  }
  // 패딩도 그대로: 영역 폭 = 검출 폭 × 1.3
  expect(Math.abs(s.regions[0]!.width - s.detections[0]!.box.width * 1.3)).toBeLessThanOrEqual(2);

  await page.evaluate(() => window.__am.set('displayMode', 'sync'));
  const back = await rendersFor(page, 1500);
  expect(back.length).toBeGreaterThan(6);
  for (const r of back) expect([r.mode, r.frameId]).toEqual(['sync', r.detectionFrameId]);
  expect(errors).toEqual([]);
});
