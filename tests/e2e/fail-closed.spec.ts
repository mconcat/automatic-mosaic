import { expect, test, type Page } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, startApp, useFakeCamera } from './helpers';
import { nextFrames, regionStats, toCanvasRect } from './pixels';

// P3 fail-closed: 검출기를 믿을 수 없으면(불러오는 중·오류·지연) 원본 프레임을 보여 주지 않는다.
// 비동기 표시는 화면 전체를 가리고, 동기 표시는 새 프레임을 그리지 않는다. 고장은 window.__am.fault로 흉내 낸다.
useFakeCamera('still-1face.y4m');

interface Sample {
  t: number;
  cover: boolean;
  failClosed: boolean;
  reason: string | null;
  frameCount: number;
  drawn: number | null;
  det: number | null;
  face: number; // 얼굴 영역의 평평함 (가려져 있으면 1에 가깝다)
  whole: number; // 프레임 전체의 평평함
  note: string | null;
}

// rAF마다 상태와 픽셀을 표본으로 모은다
function sample(page: Page, face: Rect, ms: number): Promise<Sample[]> {
  return page.evaluate(
    ({ face, ms }) =>
      new Promise<Sample[]>((resolve) => {
        const ctx = (document.getElementById('view') as HTMLCanvasElement).getContext('2d', { willReadFrequently: true })!;
        const flatness = (r: { x: number; y: number; width: number; height: number }, step: number): number => {
          const x = Math.ceil(r.x + 3);
          const y = Math.ceil(r.y + 3);
          const w = Math.floor(r.width - 6);
          const h = Math.floor(r.height - 6);
          if (w < 2 || h < 2) return 0;
          const d = ctx.getImageData(x, y, w, h).data;
          let flat = 0;
          let pairs = 0;
          for (let j = 0; j < h; j += step) {
            for (let i = 1; i < w; i++) {
              const k = (j * w + i) * 4;
              pairs++;
              if (Math.max(Math.abs(d[k]! - d[k - 4]!), Math.abs(d[k + 1]! - d[k - 3]!), Math.abs(d[k + 2]! - d[k - 2]!)) <= 4) flat++;
            }
          }
          return flat / pairs;
        };
        const note = document.getElementById('stage-note')!;
        const out: Sample[] = [];
        const t0 = performance.now();
        const tick = (): void => {
          const s = window.__am.snapshot();
          out.push({
            t: Math.round(performance.now() - t0),
            cover: s.fullCover,
            failClosed: s.failClosed,
            reason: s.failReason,
            frameCount: s.frameCount,
            drawn: s.drawnFrameId,
            det: s.detectionFrameId,
            face: flatness(face, 1),
            whole: flatness(s.viewRect, 4),
            note: note.hidden ? null : note.textContent,
          });
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve(out);
        };
        tick();
      }),
    { face, ms },
  );
}

const summary = (xs: Sample[]): Record<string, unknown> => ({
  n: xs.length,
  minFace: Math.min(...xs.map((x) => x.face)),
  minWhole: Math.min(...xs.map((x) => x.whole)),
  cover: xs.filter((x) => x.cover).length,
  reasons: [...new Set(xs.map((x) => x.reason))],
  notes: [...new Set(xs.map((x) => x.note))],
});

async function startAsync(page: Page): Promise<Rect> {
  await startApp(page);
  await page.evaluate(() => window.__am.set('displayMode', 'async'));
  // 바꾼 직후 화면에는 마지막 동기 프레임이 남아 있을 수 있다. 비동기로 그린 프레임이 나올 때까지 기다린다.
  await page.waitForFunction(() => {
    const r = window.__am.renders().at(-1);
    return r?.mode === 'async' && !r.fullCover && window.__am.snapshot().regions.length === 1;
  });
  return toCanvasRect(page, (await snapshot(page)).regions[0]!);
}

// 고장을 없애고, 회복한 뒤의 검출 결과로 그린 프레임이 나올 때까지 기다린다.
// (회복 직후에는 1초가 안 된 고장 전 박스를 쓰다가, 새 결과가 오기 전에 1초가 지나면 잠깐 다시 가릴 수 있다.)
async function recover(page: Page): Promise<void> {
  const mark = (await snapshot(page)).drawnFrameId ?? 0;
  await page.evaluate(() => window.__am.fault('none'));
  await page.waitForFunction(
    (m) => {
      const s = window.__am.snapshot();
      return s.detectorState === 'ready' && !s.failClosed && !s.fullCover && (s.detectionFrameId ?? 0) > m;
    },
    mark,
    { timeout: 10_000 },
  );
  await expect(page.locator('#stage-note')).toBeHidden(); // 안내는 250ms마다 갱신
}

test('비동기 + 검출 지연: 1초 넘게 결과가 없으면 화면 전체를 가리고 한국어 안내를 띄우며, 지연이 풀리면 돌아온다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const face = await startAsync(page);
  const normal = await sample(page, face, 800);
  const seq = (await page.evaluate(() => window.__am.renders().at(-1)!.seq))!;

  await page.evaluate(() => window.__am.fault('delay', 4000));
  const delayed = await sample(page, face, 2500);
  const renders = await page.evaluate((s) => window.__am.renders(s), seq);
  const onset = renders.findIndex((r) => r.fullCover);
  const s = await snapshot(page);
  console.log('[async delay]', JSON.stringify({ normal: summary(normal), delayed: summary(delayed), renders: renders.length, onset, firstCoverAt: delayed.find((x) => x.cover)?.t }));

  // 지연 전: 얼굴만 가리고 배경은 원래 디테일
  expect(normal.every((x) => !x.cover && x.face > 0.9)).toBe(true);
  // 지연 중: 얼굴은 내내 가려져 있고, 1초 남짓 뒤부터는 화면 전체를 가린다
  expect(delayed.every((x) => x.face > 0.9)).toBe(true);
  const late = delayed.filter((x) => x.t > 1400);
  expect(late.length).toBeGreaterThan(10);
  for (const x of late) {
    expect(x.cover).toBe(true);
    expect(x.reason).toBe('stalled');
    expect(x.whole).toBeGreaterThan(0.95);
    expect(x.note).toBe('Detection is late — covering the whole frame.');
  }
  expect(Math.max(...normal.map((x) => x.whole))).toBeLessThan(Math.min(...late.map((x) => x.whole)));
  expect(onset).toBeGreaterThan(0);
  for (const r of renders.slice(onset)) expect([r.fullCover, r.detectionFrameId]).toEqual([true, null]); // 한번 가리면 계속
  expect(s.failClosed).toBe(true);
  expect(s.regions).toEqual([{ x: 0, y: 0, width: 640, height: 480 }]);
  await expect(page.locator('#stage-note')).toBeVisible();

  // 회복
  await recover(page);
  const after = await sample(page, face, 800);
  expect(after.every((x) => !x.cover && x.face > 0.9 && x.note === null)).toBe(true);
  expect((await snapshot(page)).detections).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('비동기 + 검출 실패·Worker 오류: 화면 전체를 가리고 오류를 보여 주며, 다시 불러오면 돌아온다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const face = await startAsync(page);

  for (const kind of ['error', 'crash'] as const) {
    expect(await page.evaluate((k) => window.__am.fault(k), kind)).toBe(true);
    await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
    const xs = await sample(page, face, 700);
    const s = await snapshot(page);
    console.log(`[async ${kind}]`, JSON.stringify({ ...summary(xs), error: s.detectorError }));
    for (const x of xs) {
      expect(x.cover).toBe(true);
      expect(x.reason).toBe('error');
      expect(x.face).toBeGreaterThan(0.9);
      expect(x.whole).toBeGreaterThan(0.95);
      expect(x.note).toBe('Detector error — covering the whole frame.');
    }
    expect(xs.at(-1)!.frameCount).toBeGreaterThan(xs[0]!.frameCount); // 카메라 프레임은 계속 (가린 채로) 그린다
    await expect(page.locator('#detector')).toContainText(kind === 'error' ? 'Simulated detection failure' : 'Detection worker error');
    expect(s.workers.live).toBe(0);

    await recover(page);
    const back = await sample(page, face, 500);
    expect(back.every((x) => !x.cover && x.face > 0.9)).toBe(true);
    expect((await snapshot(page)).workers.live).toBe(1);
  }
  expect(errors).toEqual([]);
});

test('비동기 + 검출기를 다시 불러오는 동안(실행 위치 전환)에도 화면 전체를 가린다', async ({ page }) => {
  const errors = collectPageErrors(page);
  const face = await startAsync(page);
  await page.route('**/blaze_face_short_range.tflite', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.evaluate(() => window.__am.set('location', 'main'));
  const xs = await sample(page, face, 1000);
  console.log('[async loading]', JSON.stringify(summary(xs)));
  for (const x of xs) {
    expect(x.cover).toBe(true);
    expect(x.reason).toBe('loading');
    expect(x.face).toBeGreaterThan(0.9);
    expect(x.note).toBe('Loading detector — covering the whole frame.');
  }
  await page.waitForFunction(() => window.__am.snapshot().location === 'main' && !window.__am.snapshot().fullCover, undefined, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('동기 + 검출 지연·Worker 오류: 새 프레임을 그리지 않고 마지막 분석 프레임(모자이크)만 남기며 안내를 띄운다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  const face = await toCanvasRect(page, (await snapshot(page)).regions[0]!);

  await page.evaluate(() => window.__am.fault('delay', 3000));
  const delayed = await sample(page, face, 2000);
  console.log('[sync delay]', JSON.stringify(summary(delayed)));
  const counts = delayed.map((x) => x.frameCount);
  expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1); // 진행 중이던 한 프레임만
  for (const x of delayed) {
    expect(x.cover).toBe(false);
    expect(x.drawn).toBe(x.det);
    expect(x.face).toBeGreaterThan(0.9);
  }
  const late = delayed.filter((x) => x.t > 1300);
  expect(late.every((x) => x.reason === 'stalled' && x.note === 'Detection is late — the view is not updated; showing the last analysed frame.')).toBe(true);
  await page.evaluate(() => window.__am.fault('none'));
  await page.waitForFunction(() => !window.__am.snapshot().failClosed, undefined, { timeout: 8000 });
  await nextFrames(page, 3);

  await page.evaluate(() => window.__am.fault('crash'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
  const crashed = await sample(page, face, 600);
  console.log('[sync crash]', JSON.stringify(summary(crashed)));
  for (const x of crashed) {
    expect(x.drawn).toBe(x.det);
    expect(x.face).toBeGreaterThan(0.9);
    expect(x.note).toBe('Detector error — the view is not updated.');
  }
  expect(new Set(crashed.map((x) => x.frameCount)).size).toBe(1);
  await page.evaluate(() => window.__am.fault('none'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready');
  await nextFrames(page, 2);
  expect((await regionStats(page, face)).flat).toBeGreaterThan(0.9);
  expect(errors).toEqual([]);
});
