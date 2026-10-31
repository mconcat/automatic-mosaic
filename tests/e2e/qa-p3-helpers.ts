// QA P3 계측 헬퍼. 앱 코드는 건드리지 않고 init script로 페이지에 계측(window.__qa3)을 심는다.
// - Worker 생성·종료: Worker 생성자와 terminate()를 감싸 앱의 workerStats와 따로 센다.
// - 프레임 신원: 카메라 비트맵에 id를 붙이고, 검출기로 보낸(transfer 또는 WebGL 업로드) 프레임과 #view에 그린 프레임을 비교한다.
// - 롱태스크: 앱과 별도로 PerformanceObserver('longtask')를 건다. rAF 간격도 잰다.
// - rAF 표본: 스냅숏 + 얼굴 영역·프레임 전체 평평함(가려졌는지) + 화면 안내 문구.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Worker as PwWorker } from '@playwright/test';
import type { Rect } from '../../src/core/types';

export const P3_DIR = fileURLToPath(new URL('../artifacts/P3/', import.meta.url));

// still-1face.y4m의 얼굴 (QA P2가 손으로 잡은 정답, 원본 640×480 좌표)
export const FACE: Rect = { x: 205, y: 85, width: 235, height: 250 };
export const P2_BOX: Rect = { x: 215, y: 119, width: 224, height: 224 }; // P2(메인 스레드)에서 잰 박스

export async function shot3(page: Page, name: string, opts: { canvasOnly?: boolean } = {}): Promise<string> {
  mkdirSync(P3_DIR, { recursive: true });
  const path = `${P3_DIR}${name}.png`;
  if (opts.canvasOnly) await page.locator('#view').screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
  return path;
}

export function save3(name: string, data: unknown): void {
  mkdirSync(P3_DIR, { recursive: true });
  writeFileSync(`${P3_DIR}${name}.json`, JSON.stringify(data, null, 2));
}

export function iou(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.width * a.height + b.width * b.height - w * h);
}

export function containsRect(outer: Rect, inner: Rect, slack = 0): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

export interface Sample3 {
  t: number;
  at: number; // performance.now()
  state: string;
  det: string; // detectorState
  loc: string | null;
  drawn: number | null;
  detFrame: number | null;
  frameCount: number;
  cover: boolean;
  reason: string | null;
  dets: number;
  regions: number;
  face: number; // FACE 영역 평평함 (가려졌으면 1에 가깝다)
  whole: number; // 프레임 전체 평평함
  note: string | null;
  status: string;
}

export interface Qa3State {
  workers: { constructed: number; terminated: number; errorEvents: number };
  frames: { tagged: number; analysed: number; drawn: number; drawnUnanalysed: number; unanalysedIds: number[] };
  longTasks: { startMs: number; durationMs: number }[];
  rafGaps: number[]; // 50ms 넘는 rAF 간격
  errors: string[];
}

declare global {
  interface Window {
    __qa3: Qa3State & {
      liveWorkers(): number;
      startSampler(face: Rect): void;
      stopSampler(): Sample3[];
      flatness(r: Rect): number;
      setBusy(ms: number): void; // 메인 스레드에서 프레임을 WebGL로 올릴 때마다 ms만큼 막는다
    };
  }
}

function qa3Init(): void {
  const st: Qa3State = {
    workers: { constructed: 0, terminated: 0, errorEvents: 0 },
    frames: { tagged: 0, analysed: 0, drawn: 0, drawnUnanalysed: 0, unanalysedIds: [] },
    longTasks: [],
    rafGaps: [],
    errors: [],
  };
  window.addEventListener('error', (e) => st.errors.push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => st.errors.push(`unhandledrejection: ${String(e.reason)}`));

  // Worker 생성·종료
  const live = new Set<Worker>();
  const NativeWorker = window.Worker;
  class CountingWorker extends NativeWorker {
    constructor(url: string | URL, opts?: WorkerOptions) {
      super(url, opts);
      st.workers.constructed++;
      live.add(this);
      this.addEventListener('error', () => st.workers.errorEvents++);
    }
    override terminate(): void {
      if (live.delete(this)) st.workers.terminated++;
      super.terminate();
    }
  }
  window.Worker = CountingWorker as typeof Worker;

  // 프레임 신원
  const tags = new WeakMap<ImageBitmap, number>();
  const analysed = new Set<number>();
  let nextId = 1;
  const cib = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>;
  window.createImageBitmap = function (...a: unknown[]): Promise<ImageBitmap> {
    const src = a[0];
    const parent = src instanceof ImageBitmap ? tags.get(src) : undefined;
    return cib(...a).then((bm) => {
      if (parent !== undefined) tags.set(bm, parent);
      else if (src instanceof HTMLVideoElement) {
        tags.set(bm, nextId++);
        st.frames.tagged++;
      }
      return bm;
    });
  } as typeof window.createImageBitmap;
  const mark = (x: unknown): void => {
    if (!(x instanceof ImageBitmap)) return;
    const id = tags.get(x);
    if (id === undefined || analysed.has(id)) return;
    analysed.add(id);
    st.frames.analysed = analysed.size;
  };
  const post = NativeWorker.prototype.postMessage as (this: Worker, msg: unknown, transfer?: unknown) => void;
  NativeWorker.prototype.postMessage = function (this: Worker, msg: unknown, transfer?: unknown): void {
    const list = Array.isArray(transfer) ? transfer : ((transfer as { transfer?: unknown[] } | undefined)?.transfer ?? []);
    for (const t of list) mark(t);
    post.call(this, msg, transfer);
  } as typeof Worker.prototype.postMessage;
  // 메인 스레드 실행: MediaPipe가 WebGL로 올린 비트맵 = 분석한 프레임. busyMs면 그만큼 메인 스레드를 막는다 (무거운 추론 흉내).
  const busy = { ms: 0 };
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const proto = C.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['texImage2D', 'texSubImage2D']) {
      const orig = proto[name]!;
      proto[name] = function (this: unknown, ...a: unknown[]): unknown {
        const last = a[a.length - 1];
        if (last instanceof ImageBitmap) {
          mark(last);
          if (busy.ms > 0) {
            const t = performance.now();
            while (performance.now() - t < busy.ms) {
              /* 바쁜 대기 */
            }
          }
        }
        return orig.apply(this, a);
      };
    }
  }
  const drawImage = CanvasRenderingContext2D.prototype.drawImage as (...a: unknown[]) => void;
  CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]): void {
    const img = a[0];
    if (this.canvas.id === 'view' && img instanceof ImageBitmap) {
      const id = tags.get(img);
      st.frames.drawn++;
      if (id === undefined || !analysed.has(id)) {
        st.frames.drawnUnanalysed++;
        if (st.frames.unanalysedIds.length < 100) st.frames.unanalysedIds.push(id ?? -1);
      }
    }
    drawImage.apply(this, a);
  } as typeof CanvasRenderingContext2D.prototype.drawImage;

  // 롱태스크, rAF 간격
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) st.longTasks.push({ startMs: e.startTime, durationMs: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* 지원 안 함 */
  }
  let lastRaf = 0;
  const raf = (t: number): void => {
    if (lastRaf && t - lastRaf > 50) st.rafGaps.push(Math.round(t - lastRaf));
    lastRaf = t;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  // 원본 좌표 사각형의 평평함 (가로 이웃 픽셀 채널 차 ≤ 4 비율, 가장자리 3px 제외)
  const flatness = (r: Rect, step = 1): number => {
    const c = document.getElementById('view') as HTMLCanvasElement | null;
    if (!c || !c.width) return 0;
    const ctx = c.getContext('2d')!;
    const s = window.__am.snapshot();
    const v = s.viewRect;
    if (!s.videoWidth || !v.width) return 0;
    const sx = v.width / s.videoWidth;
    const sy = v.height / s.videoHeight;
    const cx = s.mirror ? v.x + v.width - (r.x + r.width) * sx : v.x + r.x * sx;
    const x = Math.ceil(cx + 3);
    const y = Math.ceil(v.y + r.y * sy + 3);
    const w = Math.floor(r.width * sx - 6);
    const h = Math.floor(r.height * sy - 6);
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

  let samples: Sample3[] = [];
  let sampling = false;
  window.__qa3 = Object.assign(st, {
    liveWorkers: () => live.size,
    flatness: (r: Rect) => flatness(r),
    setBusy: (ms: number) => {
      busy.ms = ms;
    },
    startSampler(face: Rect) {
      samples = [];
      sampling = true;
      const t0 = performance.now();
      const note = document.getElementById('stage-note')!;
      const status = document.getElementById('detector')!;
      const tick = (): void => {
        if (!sampling) return;
        const s = window.__am.snapshot();
        const has = s.state === 'running' && s.drawnFrameId !== null;
        const at = performance.now();
        samples.push({
          t: Math.round(at - t0),
          at,
          state: s.state,
          det: s.detectorState,
          loc: s.location,
          drawn: s.drawnFrameId,
          detFrame: s.detectionFrameId,
          frameCount: s.frameCount,
          cover: s.fullCover,
          reason: s.failReason,
          dets: s.detections.length,
          regions: s.regions.length,
          face: has ? flatness(face) : -1,
          whole: has ? flatness({ x: 0, y: 0, width: s.videoWidth, height: s.videoHeight }, 4) : -1,
          note: note.hidden ? null : note.textContent,
          status: status.textContent ?? '',
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stopSampler() {
      sampling = false;
      return samples;
    },
  });
}

export async function installQa3(page: Page): Promise<void> {
  await page.addInitScript(qa3Init);
}

export function qa3(page: Page): Promise<Qa3State & { live: number }> {
  return page.evaluate(() => {
    const q = window.__qa3;
    return JSON.parse(JSON.stringify({ workers: q.workers, frames: q.frames, longTasks: q.longTasks, rafGaps: q.rafGaps, errors: q.errors, live: q.liveWorkers() })) as Qa3State & { live: number };
  });
}

export async function startSampler(page: Page, face: Rect = FACE): Promise<void> {
  await page.evaluate((f) => window.__qa3.startSampler(f), face);
}

export function stopSampler(page: Page): Promise<Sample3[]> {
  return page.evaluate(() => window.__qa3.stopSampler());
}

export function summarize(xs: Sample3[]): Record<string, unknown> {
  const drawn = xs.filter((x) => x.face >= 0);
  return {
    n: xs.length,
    drawnSamples: drawn.length,
    minFace: drawn.length ? Math.round(Math.min(...drawn.map((x) => x.face)) * 1000) / 1000 : null,
    minWhole: drawn.length ? Math.round(Math.min(...drawn.map((x) => x.whole)) * 1000) / 1000 : null,
    maxWhole: drawn.length ? Math.round(Math.max(...drawn.map((x) => x.whole)) * 1000) / 1000 : null,
    cover: xs.filter((x) => x.cover).length,
    syncMismatch: xs.filter((x) => x.drawn !== null && !x.cover && x.detFrame !== null && x.drawn !== x.detFrame).length,
    frameCount: [xs[0]?.frameCount, xs.at(-1)?.frameCount],
    reasons: [...new Set(xs.map((x) => x.reason))],
    detStates: [...new Set(xs.map((x) => x.det))],
    notes: [...new Set(xs.map((x) => x.note))],
    statuses: [...new Set(xs.map((x) => x.status))],
  };
}

// 앱 코드 밖에서 Worker 안을 바꾼다: 검출 Worker가 생길 때마다 fn을 그 안에서 실행한다.
export function onEachWorker(page: Page, fn: () => void): { applied: () => Promise<void>; workers: PwWorker[] } {
  const workers: PwWorker[] = [];
  const pending: Promise<unknown>[] = [];
  page.on('worker', (w) => {
    workers.push(w);
    pending.push(w.evaluate(fn).catch(() => {}));
  });
  return {
    workers,
    applied: async () => {
      await Promise.all(pending);
    },
  };
}

// Worker 안에서: WebGL로 ImageBitmap을 올릴 때(= 프레임을 추론할 때) 바쁜 대기 / 던지기 / 응답 버리기를 켤 수 있게 한다.
export function workerPatch(): void {
  const g = self as unknown as { __qaBusyMs: number; __qaThrow: boolean; __qaUploads: number; __qaDrop: boolean; postMessage: (m: unknown, t?: unknown) => void };
  if ((g as unknown as { __qaPatched?: boolean }).__qaPatched) return;
  (g as unknown as { __qaPatched?: boolean }).__qaPatched = true;
  g.__qaBusyMs = 0;
  g.__qaThrow = false;
  g.__qaUploads = 0;
  g.__qaDrop = false;
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const proto = C.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['texImage2D', 'texSubImage2D']) {
      const orig = proto[name]!;
      proto[name] = function (this: unknown, ...a: unknown[]): unknown {
        if (a[a.length - 1] instanceof ImageBitmap) {
          g.__qaUploads++;
          if (g.__qaThrow) throw new Error('QA: Worker 안 WebGL 업로드 실패');
          if (g.__qaBusyMs > 0) {
            const t = performance.now();
            while (performance.now() - t < g.__qaBusyMs) {
              /* 바쁜 대기 */
            }
          }
        }
        return orig.apply(this, a);
      };
    }
  }
  const post = g.postMessage.bind(g);
  g.postMessage = (m: unknown, t?: unknown) => {
    if (g.__qaDrop && (m as { type?: string } | null)?.type === 'result') return;
    post(m, t);
  };
}

export async function setInWorkers(page: Page, values: Record<string, unknown>): Promise<number> {
  let n = 0;
  for (const w of page.workers()) {
    await w.evaluate((v) => Object.assign(self, v), values).then(
      () => n++,
      () => {},
    );
  }
  return n;
}

export async function waitReady(page: Page, location?: 'worker' | 'main', timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (loc) => {
      const s = window.__am.snapshot();
      return s.detectorState === 'ready' && (loc === null || s.location === loc);
    },
    location ?? null,
    { timeout },
  );
}

export async function startRunning(page: Page, minFrames = 3): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForFunction((n) => {
    const s = window.__am.snapshot();
    return s.state === 'running' && s.frameCount >= n && s.detectorState === 'ready';
  }, minFrames);
}

export async function hookSet(page: Page, key: string, value: unknown): Promise<boolean> {
  return page.evaluate(([k, v]) => window.__am.set(k as string, v as never), [key, value] as const);
}

export const READABLE_TEXT = /[A-Za-z]{3,}/; // 사람이 읽을 안내 문구 (UI 언어: 영어)
