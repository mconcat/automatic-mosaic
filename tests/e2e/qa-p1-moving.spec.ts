// QA P1: 움직이는 얼굴 픽스처. 화면이 시간에 따라 바뀌는지 머리 위치(무게중심)로 확인한다.
// P2 적응: 모자이크 강도 0(unmasked)으로 원본 비디오와 비교하고, 동기 표시 지연을 줄이려고 목표 FPS를 15로 둔다.
import { expect, test, type Page } from '@playwright/test';
import { collectPageErrors, flipThumb, litRatio, meanAbsDiff, snapshot, unmasked, useFakeCamera } from './helpers';
import { collectConsole, headCentroidX, installProbes, lumaStd, probe, saveEvidence, shot, viewAndRaw } from './qa-helpers';

useFakeCamera('moving-1face.y4m');

const W = 160;
const H = 120;

async function p1Render(page: Page): Promise<void> {
  await unmasked(page);
  await page.evaluate(() => window.__am.set('targetFps', 15));
}

test('QA-3 moving: 비어 있지 않은 프레임, 시간에 따라 바뀜, 렌더 FPS > 5', async ({ page }) => {
  const errors = collectPageErrors(page);
  const consoleLog = collectConsole(page);
  await installProbes(page);
  await page.goto('/');
  await p1Render(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running' && window.__am.snapshot().frameCount >= 5);

  const samples: { t: number; frameCount: number; renderFps: number; lit: number; std: number; cx: number; rawCx: number }[] = [];
  const thumbs: number[][] = [];
  let movedShot = false;
  const t0 = Date.now();
  for (let i = 0; i < 17; i++) {
    const { view, raw } = await viewAndRaw(page, W, H);
    const s = await snapshot(page);
    samples.push({
      t: Date.now() - t0,
      frameCount: s.frameCount,
      renderFps: s.renderFps,
      lit: litRatio(view),
      std: lumaStd(view),
      cx: headCentroidX(view, W),
      rawCx: headCentroidX(raw, W),
    });
    thumbs.push(view);
    if (i === 0) await shot(page, 'p1-06-moving-t0');
    // 머리가 처음 자리에서 화면 폭의 40% 넘게 옮겨 간 첫 순간을 찍는다.
    const last = samples[samples.length - 1]!;
    if (!movedShot && Math.abs(last.cx - samples[0]!.cx) > 0.4) {
      movedShot = true;
      await shot(page, 'p1-07-moving-later');
    }
    await page.waitForTimeout(250);
  }
  const p = await probe(page);
  const consecutiveDiffs = thumbs.slice(1).map((t, i) => meanAbsDiff(thumbs[i]!, t));
  const cxs = samples.map((s) => s.cx);
  const cxRange = Math.max(...cxs) - Math.min(...cxs);
  // 미러 켬: 화면 무게중심 ≈ 1 - 원본 무게중심 (1프레임 시차가 있어 느슨하게 본다)
  const mirrorErr = samples.map((s) => Math.abs(s.cx - (1 - s.rawCx))).sort((a, b) => a - b);
  const medianMirrorErr = mirrorErr[Math.floor(mirrorErr.length / 2)]!;
  const elapsed = (samples[samples.length - 1]!.t - samples[0]!.t) / 1000;
  const measuredFps = (samples[samples.length - 1]!.frameCount - samples[0]!.frameCount) / elapsed;

  const evidence = { samples, consecutiveDiffs, cxRange, medianMirrorErr, measuredFps, probe: p, console: consoleLog };
  saveEvidence('qa3-moving', evidence);
  console.log('[QA-3 moving]', JSON.stringify({ cxs, cxRange, consecutiveDiffs, medianMirrorErr, measuredFps, fps: samples.map((s) => s.renderFps) }));

  for (const s of samples) {
    expect(s.lit).toBeGreaterThan(0.5);
    expect(s.std).toBeGreaterThan(10);
    expect(s.renderFps).toBeGreaterThan(5);
  }
  expect(measuredFps).toBeGreaterThan(5);
  expect(consecutiveDiffs.filter((d) => d > 2).length).toBeGreaterThan(consecutiveDiffs.length * 0.7);
  expect(cxRange).toBeGreaterThan(0.4); // 머리가 화면 폭의 40% 넘게 움직인다
  expect(medianMirrorErr).toBeLessThan(0.1);
  expect(errors).toEqual([]);
  expect(p.errors).toEqual([]);
});

test('QA-4 moving: 미러를 끄면 화면 = 원본 비디오, 켜면 좌우 반전 (무게중심)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await p1Render(page);
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => window.__am.snapshot().state === 'running' && window.__am.snapshot().frameCount >= 5);
  const rows: { mirror: boolean; cx: number; rawCx: number; diffVsRaw: number; diffVsFlippedRaw: number }[] = [];
  for (const m of [true, false, true, false]) {
    await page.evaluate((v) => window.__am.set('mirror', v), m);
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(150);
      const { view, raw } = await viewAndRaw(page, W, H);
      rows.push({
        mirror: (await snapshot(page)).mirror,
        cx: headCentroidX(view, W),
        rawCx: headCentroidX(raw, W),
        diffVsRaw: meanAbsDiff(view, raw),
        diffVsFlippedRaw: meanAbsDiff(view, flipThumb(raw, W, H)),
      });
    }
  }
  saveEvidence('qa4-moving-mirror', rows);
  console.log('[QA-4 moving mirror]', JSON.stringify(rows));
  const err = (r: (typeof rows)[number]): number => Math.abs(r.cx - (r.mirror ? 1 - r.rawCx : r.rawCx));
  const errs = rows.map(err).sort((a, b) => a - b);
  expect(errs[Math.floor(errs.length / 2)]!).toBeLessThan(0.1);
  expect(errors).toEqual([]);
});
