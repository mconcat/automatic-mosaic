import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { AmSnapshot } from '../../src/test-hook';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

// 이 파일의 테스트는 지정한 y4m을 카메라로 쓴다. deny면 카메라 권한을 거부한다. args는 Chrome 플래그 추가.
export function useFakeCamera(fixture: string, { deny = false, args = [] }: { deny?: boolean; args?: string[] } = {}): void {
  test.use({
    permissions: deny ? [] : ['camera'],
    launchOptions: {
      args: [
        deny ? '--use-fake-ui-for-media-stream=deny' : '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${FIXTURES_DIR}${fixture}`,
        ...args,
      ],
    },
  });
}

// MediaPipe WASM이 콘솔에 남기는 자체 로그 (glog 형식 I/W/E…, TFLite INFO, 그래프 시작·종료). 앱 오류가 아니다.
export function isMediaPipeLog(text: string): boolean {
  return /^[IWEF]\d{4} \d\d:\d\d:\d\d/.test(text) || text.startsWith('INFO: ') || /^Graph (successfully started running|finished closing successfully)\.$/.test(text);
}

// P1처럼 원본 그대로 그리는 경로를 비교할 때: 모자이크 강도 0 (강도 0이면 이펙트를 그리지 않는다)
export async function unmasked(page: Page): Promise<void> {
  await page.evaluate(() => window.__am.set('strength', 0));
}

// 검출 Worker가 생길 때마다 fn을 그 안에서 실행한다 (addInitScript는 Worker에 걸리지 않는다).
// 돌려준 함수를 기다리면 지금까지 생긴 Worker에 모두 적용된 뒤다.
export function patchWorkers(page: Page, fn: () => void): () => Promise<void> {
  const applied: Promise<unknown>[] = [];
  page.on('worker', (w) => applied.push(w.evaluate(fn).catch(() => {})));
  return async () => {
    await expect.poll(() => applied.length).toBeGreaterThan(0);
    await Promise.all(applied);
  };
}

export function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (err) => errors.push(err));
  return errors;
}

export function snapshot(page: Page): Promise<AmSnapshot> {
  return page.evaluate(() => window.__am.snapshot());
}

export async function startApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction(() => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.frameCount >= 5;
  });
}

// 캔버스를 작게 줄인 RGBA 픽셀 (비교용)
export async function canvasThumb(page: Page, width = 64, height = 48): Promise<number[]> {
  return page.evaluate(
    ([w, h]) => {
      const src = document.getElementById('view') as HTMLCanvasElement;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0, w, h);
      return Array.from(ctx.getImageData(0, 0, w, h).data);
    },
    [width, height] as const,
  );
}

export function flipThumb(px: number[], width = 64, height = 48): number[] {
  const out = new Array<number>(px.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = (y * width + (width - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out[to + c] = px[from + c]!;
    }
  }
  return out;
}

// RGB 채널 평균 절대 차이 (0–255)
export function meanAbsDiff(a: number[], b: number[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c]! - b[i + c]!);
    n += 3;
  }
  return sum / n;
}

// 밝기 30 이상인 픽셀 비율 (검은 화면이면 0)
export function litRatio(px: number[]): number {
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]! > 30) lit++;
  }
  return lit / (px.length / 4);
}

export async function expectFpsAbove(page: Page, min: number): Promise<void> {
  await expect.poll(async () => (await snapshot(page)).renderFps, { timeout: 5000 }).toBeGreaterThan(min);
}
