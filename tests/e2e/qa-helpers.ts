// QA용 계측 헬퍼. 앱 코드는 건드리지 않고 페이지에 init script로 계측을 심는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, ConsoleMessage, Page } from '@playwright/test';

export const ARTIFACTS_DIR = fileURLToPath(new URL('../artifacts/P1/', import.meta.url));

export interface QaProbe {
  streams: MediaStream[]; // getUserMedia가 돌려준 모든 스트림
  rvfc: number; // requestVideoFrameCallback 콜백 실행 수
  draws: number; // #view 캔버스 drawImage 호출 수
  bitmaps: number; // createImageBitmap 호출 수
  errors: string[]; // window error / unhandledrejection
}

declare global {
  interface Window {
    __qa?: QaProbe;
  }
}

export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const qa: QaProbe = { streams: [], rvfc: 0, draws: 0, bitmaps: 0, errors: [] };
    window.__qa = qa;
    window.addEventListener('error', (e) => qa.errors.push(`error: ${e.message}`));
    window.addEventListener('unhandledrejection', (e) => qa.errors.push(`unhandledrejection: ${String(e.reason)}`));

    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (md?.getUserMedia) {
      const gum = md.getUserMedia.bind(md);
      md.getUserMedia = async (c?: MediaStreamConstraints) => {
        const s = await gum(c);
        qa.streams.push(s);
        return s;
      };
    }

    const rvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb: VideoFrameRequestCallback): number {
      return rvfc.call(this, (now, meta) => {
        qa.rvfc++;
        cb(now, meta);
      });
    };

    const drawImage = CanvasRenderingContext2D.prototype.drawImage as (...args: unknown[]) => void;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]): void {
      if (this.canvas.id === 'view') qa.draws++;
      drawImage.apply(this, args);
    } as typeof CanvasRenderingContext2D.prototype.drawImage;

    const cib = window.createImageBitmap as (...args: unknown[]) => Promise<ImageBitmap>;
    window.createImageBitmap = function (...args: unknown[]): Promise<ImageBitmap> {
      qa.bitmaps++;
      return cib.apply(window, args);
    } as typeof window.createImageBitmap;
  });
}

export function probe(page: Page): Promise<{ rvfc: number; draws: number; bitmaps: number; errors: string[]; streamCount: number; trackStates: string[] }> {
  return page.evaluate(() => {
    const qa = window.__qa!;
    return {
      rvfc: qa.rvfc,
      draws: qa.draws,
      bitmaps: qa.bitmaps,
      errors: [...qa.errors],
      streamCount: qa.streams.length,
      trackStates: qa.streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
    };
  });
}

export interface ConsoleEntry {
  type: string;
  text: string;
}

export function collectConsole(page: Page): ConsoleEntry[] {
  const out: ConsoleEntry[] = [];
  page.on('console', (m: ConsoleMessage) => out.push({ type: m.type(), text: m.text() }));
  return out;
}

// 앱이 요청해도 되는 곳: 앱 자신(localhost)과 모델·WASM 공식 저장소.
const OFFICIAL_HOSTS = ['storage.googleapis.com', 'cdn.jsdelivr.net', 'huggingface.co'];

export function isExpectedUrl(u: string): boolean {
  if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:')) return true;
  const host = new URL(u).hostname;
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) || OFFICIAL_HOSTS.includes(host) || host.endsWith('.hf.co');
}

// 컨텍스트 전체(모든 페이지·워커)의 요청을 기록하고, 앱 자신·공식 저장소 밖 요청은 기록한 뒤 막는다.
export async function recordRequests(context: BrowserContext): Promise<{ all: string[]; external: string[] }> {
  const log = { all: [] as string[], external: [] as string[] };
  context.on('request', (r) => {
    log.all.push(`${r.method()} ${r.url()}`);
    if (!isExpectedUrl(r.url())) log.external.push(r.url());
  });
  await context.route(
    (url) => !isExpectedUrl(url.toString()),
    (route) => {
      log.external.push(`(routed) ${route.request().url()}`);
      return route.abort();
    },
  );
  return log;
}

export async function shot(page: Page, name: string, opts: { canvasOnly?: boolean } = {}): Promise<string> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const path = `${ARTIFACTS_DIR}${name}.png`;
  if (opts.canvasOnly) await page.locator('#view').screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
  return path;
}

export function saveEvidence(name: string, data: unknown): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(`${ARTIFACTS_DIR}${name}.json`, JSON.stringify(data, null, 2));
}

// 캔버스에서 영상이 그려진 영역(레터박스 제외)과 원본 <video> 프레임을 같은 크기로 줄여 함께 찍는다.
export function viewAndRaw(page: Page, w = 160, h = 120): Promise<{ view: number[]; raw: number[]; fit: number[] }> {
  return page.evaluate(
    ([w, h]) => {
      const view = document.getElementById('view') as HTMLCanvasElement;
      const video = document.getElementById('source') as HTMLVideoElement;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const s = Math.min(view.width / vw, view.height / vh);
      const fw = vw * s;
      const fh = vh * s;
      const fx = (view.width - fw) / 2;
      const fy = (view.height - fh) / 2;
      const grab = (src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): number[] => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
        return Array.from(ctx.getImageData(0, 0, w, h).data);
      };
      // 가장자리 1px 보간 오차를 피하려고 2px 안쪽을 쓴다.
      return {
        view: grab(view, fx + 2, fy + 2, fw - 4, fh - 4),
        raw: grab(video, (2 * vw) / fw, (2 * vh) / fh, vw - (4 * vw) / fw, vh - (4 * vh) / fh),
        fit: [fx, fy, fw, fh, view.width, view.height],
      };
    },
    [w, h] as const,
  );
}

// 밝기 표준편차 (단색 화면이면 0에 가깝다)
export function lumaStd(px: number[]): number {
  const ys: number[] = [];
  for (let i = 0; i < px.length; i += 4) ys.push(0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  return Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
}

// 배경 회색(0x70)과 다른 픽셀들의 x 무게중심 (0–1). 움직이는 픽스처에서 머리 위치를 잰다.
export function headCentroidX(px: number[], width: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    if (Math.abs(y - 112) > 25) {
      sum += (i / 4) % width;
      n++;
    }
  }
  return n ? sum / n / (width - 1) : NaN;
}
