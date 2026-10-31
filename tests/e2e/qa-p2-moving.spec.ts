// QA P2-6 (움직이는 1인 픽스처): 그려진 프레임마다 모자이크가 "그 프레임"의 얼굴을 덮는지 픽셀로 확인한다.
// 머리 사진(240×240)의 가장자리를 회색(0x70) 배경과 다른 열로 찾고(프레임 y=124, 얼굴 위쪽 줄),
// 얼굴 가로 범위(머리 사진 x0 + 70…176)가 그 프레임에 그려진 모자이크 영역 안에 있는지 본다.
// 한 분석 프레임 늦은 박스를 쓰면 왕복 가운데에서 8fps ≈ 47px, 15fps ≈ 25px 어긋나 걸린다.
import { expect, test } from '@playwright/test';
import { collectPageErrors, useFakeCamera } from './helpers';
import { collectConsole } from './qa-helpers';
import { appConsoleProblems, installQa2, probe2, save2, shot2 } from './qa-p2-helpers';

useFakeCamera('moving-1face.y4m');

interface Row {
  frameId: number | null;
  x0: number | null; // 머리 사진 왼쪽 가장자리 (원본 px)
  edge: string;
  region: { x: number; width: number } | null;
  boxCx: number | null;
  dets: number;
}

for (const fps of [8, 15]) {
  test(`P2-6 움직이는 얼굴, 목표 ${fps}fps: 그려진 프레임마다 그 프레임의 얼굴이 모자이크 안에 있다`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors = collectPageErrors(page);
    const cons = collectConsole(page);
    await installQa2(page);
    await page.goto('/');
    await page.evaluate((f) => window.__am.set('targetFps', f), fps);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForFunction(() => window.__am.snapshot().frameCount >= 3);

    const rows = await page.evaluate(
      (n) =>
        new Promise<Row[]>((resolve) => {
          const c = document.getElementById('view') as HTMLCanvasElement;
          const ctx = c.getContext('2d')!;
          const out: Row[] = [];
          let last: number | null = null;
          const tick = (): void => {
            const s = window.__am.snapshot();
            if (s.drawnFrameId !== null && s.drawnFrameId !== last) {
              last = s.drawnFrameId;
              const v = s.viewRect;
              const sx = v.width / s.videoWidth;
              const cy = Math.floor(v.y + 124.5 * (v.height / s.videoHeight));
              const line = ctx.getImageData(0, cy, c.width, 1).data;
              const fg: number[] = [];
              for (let x = 0; x < s.videoWidth; x++) {
                const cx = Math.floor(s.mirror ? v.x + v.width - (x + 0.5) * sx : v.x + (x + 0.5) * sx);
                const k = cx * 4;
                const bg = Math.abs(line[k]! - 112) < 14 && Math.abs(line[k + 1]! - 112) < 14 && Math.abs(line[k + 2]! - 112) < 14;
                if (!bg) fg.push(x);
              }
              let x0: number | null = null;
              let edge = 'none';
              if (fg.length > 20) {
                const left = fg[0]!;
                const right = fg[fg.length - 1]!;
                if (left > 1) {
                  x0 = left;
                  edge = 'left';
                } else if (right < s.videoWidth - 2) {
                  x0 = right - 239;
                  edge = 'right';
                }
              }
              const r = s.regions[0];
              const b = s.detections[0]?.box;
              out.push({ frameId: s.drawnFrameId, x0, edge, region: r ? { x: r.x, width: r.width } : null, boxCx: b ? b.x + b.width / 2 : null, dets: s.detections.length });
            }
            if (out.length >= n) resolve(out);
            else requestAnimationFrame(tick);
          };
          tick();
        }),
      Math.round(fps * 4.5), // 왕복 한 주기(4초) 이상
    );
    const shots = [await shot2(page, `p2-14-moving-${fps}fps`)];
    const p = await probe2(page);

    const measured = rows.filter((r) => r.x0 !== null && r.region);
    const faceSpan = (x0: number): [number, number] => [x0 + 70, x0 + 176];
    const uncovered = measured.filter((r) => {
      const [a, b] = faceSpan(r.x0!);
      return r.region!.x > a || r.region!.x + r.region!.width < b;
    });
    const offsets = measured.filter((r) => r.boxCx !== null).map((r) => Math.round(r.boxCx! - r.x0!));
    // 같은 계산을 "한 프레임 늦은 박스"로 했다면 덮지 못했을 프레임 수 (이 검사가 지연을 잡을 수 있는지)
    let laggedWouldFail = 0;
    for (let i = 1; i < measured.length; i++) {
      const [a, b] = faceSpan(measured[i]!.x0!);
      const prev = measured[i - 1]!.region!;
      if (prev.x > a || prev.x + prev.width < b) laggedWouldFail++;
    }

    // 계측이 원본 프레임 그리기를 잡는지 스스로 확인: 테스트가 직접 분석하지 않은 카메라 프레임을 #view에 그려 본다
    const selfCheck = await page.evaluate(async () => {
      const before = window.__qa2.probe.drawnUnanalysed;
      const bm = await createImageBitmap(document.getElementById('source') as HTMLVideoElement);
      (document.getElementById('view') as HTMLCanvasElement).getContext('2d')!.drawImage(bm, 0, 0);
      bm.close();
      return window.__qa2.probe.drawnUnanalysed - before;
    });

    const ev = {
      fps,
      drawnFrames: rows.length,
      measured: measured.length,
      noDetection: rows.filter((r) => r.dets !== 1).length,
      headX0Range: [Math.min(...measured.map((r) => r.x0!)), Math.max(...measured.map((r) => r.x0!))],
      offsetRange: [Math.min(...offsets), Math.max(...offsets)],
      uncovered: uncovered.slice(0, 10),
      uncoveredCount: uncovered.length,
      laggedWouldFail,
      frameProbe: { uploads: p.uploads, analysed: p.analysed, drawn: p.drawn, drawnUnanalysed: p.drawnUnanalysed },
      probeSelfCheck: selfCheck,
      shots,
    };
    save2(`qa-p2-6-moving-${fps}fps`, { ...ev, rows });
    console.log(`[P2-6 moving ${fps}]`, JSON.stringify(ev));

    expect(rows.length).toBe(Math.round(fps * 4.5));
    expect(measured.length).toBeGreaterThan(rows.length * 0.8);
    expect(ev.headX0Range[1]! - ev.headX0Range[0]!).toBeGreaterThan(300); // 왕복 범위를 다 봤다
    expect(ev.noDetection).toBe(0);
    expect(uncovered).toEqual([]);
    expect(ev.offsetRange[1]! - ev.offsetRange[0]!).toBeLessThan(16);
    expect(laggedWouldFail).toBeGreaterThan(3);
    expect(p.drawnUnanalysed).toBe(0);
    expect(selfCheck).toBe(1);
    expect(errors).toEqual([]);
    expect(appConsoleProblems(cons)).toEqual([]);
  });
}
