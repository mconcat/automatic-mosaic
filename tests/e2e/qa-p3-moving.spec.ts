// QA P3-3 (움직이는 1인 픽스처): 기본 Worker에서 동기 표시는 그린 프레임마다 모자이크가 그 프레임의 얼굴 위에 있다.
// 비동기 표시는 기록용으로 얼굴과 모자이크의 어긋남(순간 노출 가능성)을 잰다 (설계상 비교 실험용).
// 머리 위치 분석은 sync-moving.spec.ts와 같은 방법이다 (회색 0x70 배경 위 240px 머리 사진).
import { expect, test, type Page } from '@playwright/test';
import type { AmSnapshot } from '../../src/test-hook';
import { collectPageErrors, snapshot, useFakeCamera } from './helpers';
import { hookSet, installQa3, qa3, save3, shot3, startRunning } from './qa-p3-helpers';

useFakeCamera('moving-1face.y4m');

interface Drawn {
  id: number;
  regions: number;
  flat: number; // 모자이크 영역 안 평평함 (블록이면 1에 가깝다)
  regionCx: number; // 모자이크 영역 가로 중심 (원본 px)
  headCx: number | null; // 그려진 픽셀에서 잰 머리 사진 가로 중심 (원본 px). 양쪽 가장자리가 다 잘리면 null
}

// rAF마다 확인해 새 프레임이 그려졌으면 그 화면을 분석한다 (스냅숏과 캔버스는 같은 render()에서 함께 바뀐다).
function sampleDrawn(page: Page, durationMs: number): Promise<Drawn[]> {
  return page.evaluate(
    (durationMs) =>
      new Promise<Drawn[]>((resolve) => {
        const HEAD = 240;
        const GREY = 0x70;
        const c = document.getElementById('view') as HTMLCanvasElement;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;

        const analyse = (s: AmSnapshot): Drawn => {
          const v = s.viewRect;
          const W = s.videoWidth;
          const sx = v.width / W;
          const sy = v.height / s.videoHeight;
          const toCanvasX = (x: number): number => (s.mirror ? v.x + v.width - x * sx : v.x + x * sx);
          const r = s.regions[0];
          let flat = 0;
          let regionCx = Number.NaN;
          if (r) {
            regionCx = r.x + r.width / 2;
            const x0 = Math.ceil(Math.min(toCanvasX(r.x), toCanvasX(r.x + r.width)) + 3);
            const x1 = Math.floor(Math.max(toCanvasX(r.x), toCanvasX(r.x + r.width)) - 3);
            const y0 = Math.ceil(v.y + r.y * sy + 3);
            const y1 = Math.floor(v.y + (r.y + r.height) * sy - 3);
            const w = x1 - x0;
            const d = ctx.getImageData(x0, y0, w, y1 - y0).data;
            let same = 0;
            let pairs = 0;
            for (let i = 4; i < d.length; i += 4) {
              if ((i / 4) % w === 0) continue;
              pairs++;
              if (Math.max(Math.abs(d[i]! - d[i - 4]!), Math.abs(d[i + 1]! - d[i - 3]!), Math.abs(d[i + 2]! - d[i - 2]!)) <= 4) same++;
            }
            flat = same / pairs;
          }
          // 머리 사진 가로 범위: 원본 y 150–330 띠에서 회색 배경과 다른 픽셀이 대부분인 열
          const by0 = Math.round(v.y + 150 * sy);
          const by1 = Math.round(v.y + 330 * sy);
          const band = ctx.getImageData(Math.floor(v.x), by0, Math.ceil(v.width), by1 - by0);
          const head: boolean[] = [];
          for (let x = 0; x < W; x++) {
            const cx = Math.min(band.width - 1, Math.max(0, Math.floor(toCanvasX(x + 0.5) - Math.floor(v.x))));
            let n = 0;
            let rows = 0;
            for (let y = 0; y < band.height; y += 3) {
              const k = (y * band.width + cx) * 4;
              rows++;
              if (Math.max(Math.abs(band.data[k]! - GREY), Math.abs(band.data[k + 1]! - GREY), Math.abs(band.data[k + 2]! - GREY)) > 24) n++;
            }
            head.push(n > rows * 0.6);
          }
          const left = head.indexOf(true);
          const right = head.lastIndexOf(true);
          let headCx: number | null = null;
          if (left > 2) headCx = left + HEAD / 2;
          else if (right >= 0 && right < W - 3) headCx = right + 1 - HEAD / 2;
          return { id: s.drawnFrameId!, regions: s.regions.length, flat, regionCx, headCx };
        };

        const out: Drawn[] = [];
        let lastId: number | null = null;
        const t0 = performance.now();
        const tick = (): void => {
          const s = window.__am.snapshot();
          if (s.drawnFrameId !== null && s.drawnFrameId !== lastId) {
            lastId = s.drawnFrameId;
            out.push(analyse(s));
          }
          if (performance.now() - t0 < durationMs) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
    durationMs,
  );
}


test('P3-3 움직이는 1인: Worker 동기 표시는 그린 프레임마다 그 프레임의 얼굴 위, 비동기는 어긋남을 기록', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = collectPageErrors(page);
  await installQa3(page);
  await startRunning(page);
  const s0 = await snapshot(page);
  expect(s0.location).toBe('worker');
  const q0 = await qa3(page);
  const sync = await sampleDrawn(page, 4200);
  const q1 = await qa3(page);
  await shot3(page, 'p3-14-moving-sync');
  await hookSet(page, 'displayMode', 'async');
  await page.waitForTimeout(1000);
  const asyncDrawn = await sampleDrawn(page, 4200);
  const sa = await snapshot(page);
  await shot3(page, 'p3-14b-moving-async');
  const stat = (xs: Drawn[]): Record<string, unknown> => {
    const m = xs.filter((d) => d.headCx !== null && d.regions === 1);
    const off = m.map((d) => Math.abs(d.regionCx - d.headCx!));
    // 모자이크 영역(패딩 1.3, 폭 약 292px)이 얼굴(폭 약 160px)을 가로로 다 덮지 못하는 어긋남: 약 66px 넘게
    return { drawn: xs.length, measured: m.length, noRegion: xs.filter((d) => d.regions !== 1).length, minFlat: Math.min(...xs.map((d) => d.flat)), maxOffset: Math.round(Math.max(...off)), over12: off.filter((o) => o >= 12).length, over40: off.filter((o) => o >= 40).length, over66: off.filter((o) => o > 66).length };
  };
  const evidence = { sync: stat(sync), async: stat(asyncDrawn), asyncFps: { render: sa.renderFps, inference: sa.inferenceFps }, syncDrawnUnanalysed: q1.frames.drawnUnanalysed - q0.frames.drawnUnanalysed };
  save3('qa-p3-3-moving', evidence);
  console.log('[P3-3 moving]', JSON.stringify(evidence));
  const ms = sync.filter((d) => d.headCx !== null);
  expect(sync.length).toBeGreaterThan(20);
  expect(ms.length).toBeGreaterThan(sync.length * 0.8);
  for (const d of sync) {
    expect(d.regions, `frame ${d.id}`).toBe(1);
    expect(d.flat, `frame ${d.id}`).toBeGreaterThan(0.9);
  }
  for (const d of ms) expect(Math.abs(d.regionCx - d.headCx!), `frame ${d.id}`).toBeLessThan(12);
  expect(evidence.syncDrawnUnanalysed).toBe(0);
  expect(errors).toEqual([]);
});
