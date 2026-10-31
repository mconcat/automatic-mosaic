import { expect, test, type Page } from '@playwright/test';
import type { ParamValue, Rect } from '../../src/core/types';
import { collectPageErrors, snapshot, startApp, useFakeCamera } from './helpers';
import { capture, diffOutside, nextFrames, regionStats, toCanvasRect } from './pixels';

// P2 모자이크와 실시간 파라미터. 정지 1인 픽스처라 프레임마다 같은 그림이다.
useFakeCamera('still-1face.y4m');

async function set(page: Page, key: string, value: ParamValue): Promise<void> {
  expect(await page.evaluate(([k, v]) => window.__am.set(k, v), [key, value] as const)).toBe(true);
}

// 현재 화면의 모자이크 영역 (원본 px, 캔버스 px)
async function faceRegion(page: Page): Promise<{ frame: Rect; canvas: Rect }> {
  const s = await snapshot(page);
  expect(s.regions).toHaveLength(1);
  return { frame: s.regions[0]!, canvas: await toCanvasRect(page, s.regions[0]!) };
}

test('패딩 박스 안은 블록이고, 밖은 모자이크 없는 화면과 같다. 강도 0이면 얼굴 디테일이 보인다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);

  await set(page, 'strength', 0);
  const plain = await faceRegion(page);
  const detail = await regionStats(page, plain.canvas);
  await capture(page, 'plain');

  await set(page, 'strength', 1);
  const masked = await faceRegion(page);
  const blocky = await regionStats(page, masked.canvas);
  await capture(page, 'masked');
  const outside = await diffOutside(page, 'plain', 'masked', [plain.canvas, masked.canvas]);

  console.log('[mosaic]', JSON.stringify({ region: masked.frame, detail, blocky, outside }));
  // 안: 이웃 픽셀이 거의 다 같다 (블록 경계만 다르다). 강도 0일 때는 디테일 때문에 훨씬 덜 평평하다.
  expect(blocky.flat).toBeGreaterThan(0.93);
  expect(detail.flat).toBeLessThan(0.75);
  expect(blocky.run).toBeGreaterThan(detail.run * 4);
  // 기본 상대 10칸: 블록 폭 ≈ 영역 폭 / 10
  expect(blocky.run).toBeGreaterThan(masked.canvas.width / 10 / 2);
  // 밖: 모자이크 없는 화면과 같다
  expect(outside.mean).toBeLessThan(1);
  expect(outside.over8).toBeLessThan(0.002);
  expect(errors).toEqual([]);
});

test('블록 크기를 키우면 블록이 커진다 (절대·상대 모두, UI로도)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);

  await set(page, 'blockMode', 'absolute');
  const runs: Record<string, number> = {};
  for (const size of [8, 32]) {
    await set(page, 'blockSize', size);
    runs[`abs${size}`] = (await regionStats(page, (await faceRegion(page)).canvas)).run;
  }
  await set(page, 'blockMode', 'relative');
  for (const cells of [24, 6]) {
    await set(page, 'blockCells', cells);
    runs[`rel${cells}`] = (await regionStats(page, (await faceRegion(page)).canvas)).run;
  }
  // UI 슬라이더 옆 숫자 입력으로도 바꿀 수 있다
  const cellsInput = page.getByLabel('Block count (cells)');
  await cellsInput.fill('4');
  await cellsInput.press('Enter');
  expect(await page.evaluate(() => window.__am.get('blockCells'))).toBe(4);
  runs.rel4 = (await regionStats(page, (await faceRegion(page)).canvas)).run;

  console.log('[block size]', JSON.stringify(runs));
  expect(runs.abs32!).toBeGreaterThan(runs.abs8! * 2.5);
  expect(runs.rel6!).toBeGreaterThan(runs.rel24! * 2.5);
  expect(runs.rel4!).toBeGreaterThan(runs.rel6!);
  expect(errors).toEqual([]);
});

test('이펙트를 단색으로 바꾸면 얼굴 영역이 한 색으로 채워진다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);
  await set(page, 'solidColor', '#ff00ff');
  await page.getByRole('complementary', { name: 'Advanced settings' }).getByLabel('Effect').selectOption({ label: 'Solid fill' });
  expect(await page.evaluate(() => window.__am.get('effect'))).toBe('solid');
  // 픽셀화 파라미터는 숨고 색 파라미터가 보인다
  await expect(page.getByLabel('Block count (cells)')).toBeHidden();
  await expect(page.getByLabel('Strength')).toBeHidden();
  const region = await faceRegion(page);
  const stats = await regionStats(page, region.canvas, 2);
  console.log('[solid]', JSON.stringify(stats));
  expect(stats.lumaStd).toBeLessThan(1);
  expect(stats.mean[0]).toBeGreaterThan(250);
  expect(stats.mean[1]).toBeLessThan(5);
  expect(stats.mean[2]).toBeGreaterThan(250);

  // 다시 픽셀화
  await set(page, 'effect', 'pixelate');
  const back = await regionStats(page, (await faceRegion(page)).canvas);
  expect(back.lumaStd).toBeGreaterThan(10);
  expect(back.flat).toBeGreaterThan(0.93);
  expect(errors).toEqual([]);
});

test('패딩을 키우면 모자이크 박스가 커진다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);
  await set(page, 'effect', 'solid');
  await set(page, 'solidColor', '#00ff00');
  const greenArea = (): Promise<number> =>
    page.evaluate(() => {
      const c = document.getElementById('view') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 10 && d[i + 1]! > 245 && d[i + 2]! < 10) n++;
      return n;
    });
  const rows: { padding: number; region: Rect; area: number }[] = [];
  for (const padding of [1, 1.5, 2]) {
    await set(page, 'padding', padding);
    rows.push({ padding, region: (await faceRegion(page)).frame, area: await greenArea() });
  }
  console.log('[padding]', JSON.stringify(rows));
  const box = (await snapshot(page)).detections[0]!.box;
  expect(rows[0]!.region.width).toBeLessThanOrEqual(box.width + 1);
  expect(rows[1]!.region.width).toBeGreaterThan(rows[0]!.region.width * 1.4);
  expect(rows[2]!.region.width).toBeGreaterThan(rows[1]!.region.width);
  expect(rows[1]!.area).toBeGreaterThan(rows[0]!.area * 1.8);
  expect(rows[2]!.area).toBeGreaterThan(rows[1]!.area);
  expect(errors).toEqual([]);
});

test('최소 신뢰도 0.99면 검출이 사라지고 0.5로 되돌리면 다시 나온다 (재시작 없이)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42)); // 새로고침되지 않았는지 확인용
  await nextFrames(page, 2);
  expect((await snapshot(page)).detections).toHaveLength(1);
  await set(page, 'holdMs', 0); // 트랙 유지(P4)가 검출이 끊긴 뒤에도 영역을 남기므로 이 검사에서는 끈다

  // UI 숫자 입력으로 0.99
  const input = page.getByLabel('Min confidence');
  await input.fill('0.99');
  await input.press('Enter');
  expect(await page.evaluate(() => window.__am.get('minConfidence'))).toBe(0.99);
  await nextFrames(page, 3);
  const off = await snapshot(page);
  expect(off.detections).toEqual([]);
  expect(off.regions).toEqual([]);

  await set(page, 'minConfidence', 0.5);
  await nextFrames(page, 3);
  const on = await snapshot(page);
  expect(on.detections).toHaveLength(1);
  expect(on.state).toBe('running');
  expect(on.detectorState).toBe('ready');
  expect(await page.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(42);
  expect(errors).toEqual([]);
});

test('맞지 않는 값은 거부하고, 숫자는 범위로 자른다', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(() => {
    const am = window.__am;
    return {
      badModel: am.set('model', 'nope'),
      badEffect: am.set('effect', 'blur'),
      fps: [am.set('targetFps', 100), am.get('targetFps')],
      padding: [am.set('padding', 0.5), am.get('padding')],
      model: am.get('model'),
    };
  });
  expect(r).toEqual({ badModel: false, badEffect: false, fps: [true, 15], padding: [true, 1], model: 'mediapipe-face-short' });
});

test('신뢰도 슬라이더는 놓을 때만 반영하고 (검출기 그래프를 다시 만드는 값), 패딩 슬라이더는 드래그 중에도 바로 반영한다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready');
  // 슬라이더를 50% → 90%로 드래그하고, 놓기 전에 during()을 부른다
  const drag = async (label: string, during: () => Promise<void>): Promise<void> => {
    const track = page.locator('.tp-lblv', { has: page.locator('.tp-lblv_l', { hasText: label }) }).locator('.tp-sldv_t');
    await track.scrollIntoViewIfNeeded();
    const box = (await track.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.5, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 8 });
    await during();
    await page.mouse.up();
  };
  const get = (key: string): Promise<ParamValue | undefined> => page.evaluate((k) => window.__am.get(k), key);

  await drag('Min confidence', async () => expect(await get('minConfidence')).toBe(0.5));
  expect(await get('minConfidence')).toBeGreaterThan(0.8);
  await drag('Padding', async () => expect(await get('padding')).toBeGreaterThan(1.7));
  expect(errors).toEqual([]);
});
