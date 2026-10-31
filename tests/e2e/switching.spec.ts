import { expect, test, type Page } from '@playwright/test';
import { canvasThumb, collectPageErrors, litRatio, patchWorkers, snapshot, startApp, useFakeCamera } from './helpers';
import { nextFrames, regionStats, toCanvasRect } from './pixels';

// 모델·실행 장치를 실행 중에 바꾸고, 그동안 화면에 원본 프레임이 나오지 않는지 본다.
useFakeCamera('still-1face.y4m');

interface Sample {
  state: string;
  drawn: number | null;
  detected: number | null;
  count: number;
  flat: number; // 처음 얼굴 영역의 평평함 (모자이크면 1에 가깝다)
}

// 페이지 안에서 rAF마다 상태와 얼굴 영역 픽셀을 표본으로 모은다 (until()이 참이 되고 300ms 더).
function sampleUntilReady(page: Page, rect: { x: number; y: number; width: number; height: number }): Promise<Sample[]> {
  return page.evaluate(
    (r) =>
      new Promise<Sample[]>((resolve) => {
        const c = document.getElementById('view') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        const out: Sample[] = [];
        let readyAt = 0;
        const x = Math.ceil(r.x + 3);
        const y = Math.ceil(r.y + 3);
        const w = Math.floor(r.width - 6);
        const h = Math.floor(r.height - 6);
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
          out.push({ state: s.detectorState, drawn: s.drawnFrameId, detected: s.detectionFrameId, count: s.frameCount, flat: flat / pairs });
          if (s.detectorState === 'ready' && out.some((o) => o.state === 'loading') && !readyAt) readyAt = performance.now();
          if (readyAt && performance.now() - readyAt > 300) resolve(out);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    rect,
  );
}

function check(samples: Sample[], label: string): void {
  const loading = samples.filter((x) => x.state === 'loading');
  console.log(`[${label}]`, JSON.stringify({ samples: samples.length, loading: loading.length, minFlat: Math.min(...samples.map((x) => x.flat)), counts: [...new Set(loading.map((x) => x.count))] }));
  expect(loading.length, label).toBeGreaterThan(3);
  // 모든 표본에서: 그려진 프레임 = 검출이 끝난 프레임, 얼굴 영역은 모자이크
  for (const x of samples) {
    expect(x.drawn, label).toBe(x.detected);
    expect(x.flat, label).toBeGreaterThan(0.9);
  }
  // 불러오는 동안 새 프레임을 그리지 않는다 (진행 중이던 한 프레임은 끝날 수 있다)
  const counts = loading.map((x) => x.count);
  expect(Math.max(...counts) - Math.min(...counts), label).toBeLessThanOrEqual(1);
}

test('모델 short ↔ full을 실행 중에 바꾸고, 불러오는 동안 마지막 분석 프레임(모자이크)만 보인다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);
  // 불러오는 구간이 잘 보이도록 full-range 모델 응답을 늦춘다
  await page.route('**/blaze_face_full_range.tflite', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  const rect = await toCanvasRect(page, (await snapshot(page)).regions[0]!);

  const sampling = sampleUntilReady(page, rect);
  await page.getByLabel('Model').selectOption({ label: 'BlazeFace full-range' });
  check(await sampling, 'short→full');
  await nextFrames(page, 2);
  let s = await snapshot(page);
  expect(s.detectorId).toBe('mediapipe-face-full');
  expect(s.detections).toHaveLength(1);
  expect(s.detections[0]!.score).toBeGreaterThanOrEqual(0.5);
  await expect(page.locator('#detector')).toContainText('full-range');

  await page.evaluate(() => window.__am.set('model', 'mediapipe-face-short'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready' && window.__am.snapshot().detectorId === 'mediapipe-face-short');
  await nextFrames(page, 2);
  s = await snapshot(page);
  expect(s.detections).toHaveLength(1);
  expect(s.state).toBe('running');
  expect(errors).toEqual([]);
});

test('실행 장치 GPU ↔ CPU를 실행 중에 바꾸고 실제 실행 장치를 보고한다', async ({ page }) => {
  const errors = collectPageErrors(page);
  await startApp(page);
  await nextFrames(page, 2);
  const first = await snapshot(page);
  console.log('[delegate] 기본', first.activeDelegate, first.delegateFallback);
  expect(['GPU', 'CPU']).toContain(first.activeDelegate);

  await page.route('**/blaze_face_short_range.tflite', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  const rect = await toCanvasRect(page, first.regions[0]!);
  const sampling = sampleUntilReady(page, rect);
  await page.getByLabel('Delegate', { exact: true }).selectOption({ label: 'CPU' });
  check(await sampling, 'GPU→CPU');
  await nextFrames(page, 2);
  let s = await snapshot(page);
  expect(s.activeDelegate).toBe('CPU');
  expect(s.delegateFallback).toBeNull();
  expect(s.detections).toHaveLength(1);
  await expect(page.locator('#detector')).toContainText('CPU');

  await page.evaluate(() => window.__am.set('delegate', 'GPU'));
  await page.waitForFunction(() => window.__am.snapshot().detectorState === 'ready' && window.__am.snapshot().activeDelegate !== 'CPU' || window.__am.snapshot().delegateFallback !== null);
  await nextFrames(page, 2);
  s = await snapshot(page);
  // 헤드리스에서 GPU를 못 쓰면 CPU 대체가 보고되어야 한다
  if (s.activeDelegate === 'CPU') expect(s.delegateFallback).not.toBeNull();
  else expect(s.activeDelegate).toBe('GPU');
  expect(s.detections).toHaveLength(1);
  expect(errors).toEqual([]);
});

// 부동소수 텍스처 확장을 숨기면 MediaPipe GPU 추론이 "No full support of FP16" 으로 실패한다 (WebGL 자체는 동작).
function hideFloatTextures(): void {
  const proto = WebGL2RenderingContext.prototype as unknown as {
    getExtension: (name: string) => unknown;
    getSupportedExtensions: () => string[] | null;
  };
  const getExtension = proto.getExtension;
  const supported = proto.getSupportedExtensions;
  proto.getExtension = function (this: unknown, name: string) {
    return /float/i.test(name) ? null : getExtension.call(this, name);
  };
  proto.getSupportedExtensions = function (this: unknown) {
    return (supported.call(this) ?? []).filter((n) => !/float/i.test(n));
  };
}

// MediaPipe는 CPU delegate여도 입력 이미지를 WebGL 텍스처로 올린다. WebGL이 없으면 검출 자체를 할 수 없다.
function disableWebGL(): void {
  type WithContext = { getContext: (...a: unknown[]) => unknown };
  const protos = [OffscreenCanvas.prototype as unknown as WithContext];
  if (typeof HTMLCanvasElement !== 'undefined') protos.push(HTMLCanvasElement.prototype as unknown as WithContext);
  for (const proto of protos) {
    const orig = proto.getContext;
    proto.getContext = function (this: unknown, type: unknown, ...rest: unknown[]) {
      if (typeof type === 'string' && type.startsWith('webgl')) return null;
      return orig.call(this, type, ...rest);
    };
  }
}

// 실행 위치마다 같은 고장을 심는다. main: init script + 실행 위치를 메인으로. worker: 검출 Worker 안에 심는다.
async function openWithPatch(page: Page, location: 'worker' | 'main', patch: () => void): Promise<void> {
  if (location === 'main') {
    await page.addInitScript(patch);
    await page.goto('/');
    await page.evaluate(() => window.__am.set('location', 'main'));
  } else {
    const applied = patchWorkers(page, patch);
    // Worker가 MediaPipe를 다 불러오기 전에 심어지도록 WASM 로더를 조금 늦춘다
    await page.route('**/wasm/vision_wasm_module_internal.js', async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue();
    });
    await page.goto('/');
    await applied();
  }
}

for (const location of ['worker', 'main'] as const) {
  test(`GPU delegate를 쓸 수 없으면 CPU로 자동 대체하고 그 사실을 보고한다 (${location})`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWithPatch(page, location, hideFloatTextures);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForFunction(() => window.__am.snapshot().frameCount >= 3);
    const s = await snapshot(page);
    console.log(`[fallback ${location}]`, s.activeDelegate, s.delegateFallback?.split('\n').slice(0, 3).join(' '));
    expect(await page.evaluate(() => window.__am.get('delegate'))).toBe('GPU');
    expect(s.location).toBe(location);
    expect(s.activeDelegate).toBe('CPU');
    expect(s.delegateFallback).toBeTruthy();
    expect(s.detectorState).toBe('ready');
    expect(s.detections).toHaveLength(1);
    await expect(page.locator('#detector')).toContainText('GPU unavailable, running on CPU');
    // 패널 모니터(읽기 전용 입력)에도 보인다
    await expect
      .poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement>('.panel input')].map((i) => i.value)))
      .toContain('CPU (GPU fallback)');
    // 첫 프레임부터 모자이크
    const now = await snapshot(page); // 두 값은 한 스냅숏에서 읽는다 (사이에 새 프레임이 그려질 수 있다)
    expect(now.drawnFrameId).toBe(now.detectionFrameId);
    const stats = await regionStats(page, await toCanvasRect(page, s.regions[0]!));
    expect(stats.flat).toBeGreaterThan(0.9);
    expect(errors).toEqual([]);
  });

  test(`WebGL을 전혀 쓸 수 없으면 검출 오류를 보여 주고 원본 프레임은 그리지 않는다 (fail-closed, ${location})`, async ({ page }) => {
    const errors = collectPageErrors(page);
    await openWithPatch(page, location, disableWebGL);
    await page.getByRole('button', { name: 'Start' }).click();
    await page.waitForFunction(() => window.__am.snapshot().detectorState === 'error');
    await page.waitForTimeout(500);
    const s = await snapshot(page);
    console.log(`[no webgl ${location}]`, s.detectorError);
    expect(s.state).toBe('running');
    expect(s.frameCount).toBe(0);
    expect(s.drawnFrameId).toBeNull();
    expect(litRatio(await canvasThumb(page))).toBe(0);
    expect(s.detectorError).toContain('WebGL2');
    expect(s.workers.live).toBe(0); // 실패한 Worker는 남지 않는다
    await expect(page.locator('#detector')).toContainText('WebGL2');
    await expect(page.locator('#stage-note')).toContainText('Detector error');
    expect(errors).toEqual([]);
  });
}
