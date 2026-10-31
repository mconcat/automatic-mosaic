import { expect, test, type Page } from '@playwright/test';
import type { AmSnapshot } from '../../src/test-hook';
import { collectPageErrors, startApp, useFakeCamera } from './helpers';
import { nextFrames } from './pixels';

// 동기 표시를 픽셀로 확인한다: 그려진 프레임마다 모자이크 영역이 "그 프레임의" 얼굴 위에 있어야 한다.
// 정지 픽스처는 프레임이 모두 같아서 프레임 N을 프레임 N-1의 검출 결과로 그려도 구별되지 않는다.
// moving-1face: 회색(0x70) 배경 위에서 240×240 머리 사진(y 120–360)이 좌우로 왕복하고, 얼굴은 머리 사진 가로 가운데에 있다.
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

for (const fps of [8, 15]) {
  test(`목표 ${fps}fps: 그려진 프레임마다 그 프레임의 얼굴 위에 모자이크가 있다`, async ({ page }) => {
    test.setTimeout(45_000);
    const errors = collectPageErrors(page);
    await startApp(page);
    expect(await page.evaluate((v) => window.__am.set('targetFps', v), fps)).toBe(true);
    await nextFrames(page, 3);

    const drawn = await sampleDrawn(page, 4200); // 왕복 한 주기(4초)
    const measured = drawn.filter((d) => d.headCx !== null);
    const offsets = measured.map((d) => d.regionCx - d.headCx!);
    const heads = measured.map((d) => d.headCx!);
    console.log(
      `[sync ${fps}fps]`,
      JSON.stringify({
        drawn: drawn.length,
        measured: measured.length,
        noRegion: drawn.filter((d) => d.regions !== 1).length,
        minFlat: Math.min(...drawn.map((d) => d.flat)),
        headRange: [Math.min(...heads), Math.max(...heads)],
        offset: [Math.min(...offsets), Math.max(...offsets)].map((v) => Math.round(v * 10) / 10),
      }),
    );
    expect(drawn.length).toBeGreaterThan(fps * 4 * 0.6);
    // 머리가 실제로 크게 움직였다 (검사가 의미 있게)
    expect(Math.max(...heads) - Math.min(...heads)).toBeGreaterThan(300);
    expect(measured.length).toBeGreaterThan(drawn.length * 0.8);
    for (const d of drawn) {
      expect(d.regions, `frame ${d.id}`).toBe(1);
      expect(d.flat, `frame ${d.id}`).toBeGreaterThan(0.9);
    }
    // 모자이크 영역 중심 = 그 프레임의 얼굴 중심 (측정 −3…+5px). 한 프레임 어긋나면 머리가 15fps에서 최대 25px, 8fps에서 최대 47px 떨어진다.
    for (const d of measured) expect(Math.abs(d.regionCx - d.headCx!), `frame ${d.id}`).toBeLessThan(12);
    expect(errors).toEqual([]);
  });
}
