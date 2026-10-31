// QA P2 계측 헬퍼. 앱 코드는 건드리지 않고 init script로 페이지에 계측 함수(window.__qa2)를 심는다.
// - 프레임 신원 추적: createImageBitmap 결과에 id를 붙이고, MediaPipe가 WebGL로 올린(=분석한) 비트맵과
//   #view 캔버스에 그린 비트맵을 비교한다. 분석하지 않은 카메라 프레임이 화면에 그려지면 잡힌다.
// - 캔버스 픽셀 분석: 블록 균일성, 블록 간격, 디테일, 같은 프레임 두 번 그리기 비교, 단색 검사.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { isMediaPipeLog } from './helpers';

export const P2_DIR = fileURLToPath(new URL('../artifacts/P2/', import.meta.url));

export async function shot2(page: Page, name: string, opts: { canvasOnly?: boolean } = {}): Promise<string> {
  mkdirSync(P2_DIR, { recursive: true });
  const path = `${P2_DIR}${name}.png`;
  if (opts.canvasOnly) await page.locator('#view').screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
  return path;
}

export function save2(name: string, data: unknown): void {
  mkdirSync(P2_DIR, { recursive: true });
  writeFileSync(`${P2_DIR}${name}.json`, JSON.stringify(data, null, 2));
}

export interface BlockCheck {
  blocks: number;
  uniformFrac: number; // 블록 안쪽 픽셀 범위(max-min, 채널 최대)가 tol 이하인 블록 비율
  maxRange: number;
  p95Range: number;
  distinct: number; // 블록 대표색 종류 수
  meanAdjDiff: number; // 이웃 블록 대표색 차이 평균 (얼굴 내용이 있으면 0보다 크다)
}

export interface Detail {
  flat: number; // 가로 이웃 픽셀이 (채널 차 ≤ 2로) 같은 비율
  meanGrad: number; // 가로 이웃 픽셀 채널 최대 차의 평균
  distinct: number; // 5비트로 양자화한 색 종류 수
}

export interface SameFrameDiff {
  frameA: number | null;
  frameB: number | null;
  inside: { mean: number; max: number; n: number };
  outside: { mean: number; max: number; over2: number; n: number };
}

export interface FrameProbe {
  uploads: number; // MediaPipe가 WebGL로 올린 태그 비트맵 수
  analysed: number; // 분석된 카메라 프레임 id 수
  drawn: number; // #view에 그린 ImageBitmap 수
  drawnUnanalysed: number; // 그 중 분석되지 않은 프레임
  unanalysedIds: (number | null)[];
  drawnIds: number[];
  firstDrawAt: number | null; // performance.now()
  firstUploadAt: number | null;
  gum: number; // getUserMedia 호출 수
}

export interface RafSample {
  t: number;
  drawn: number | null;
  det: number | null;
  state: string;
  frameCount: number;
  dets: number;
  regions: number;
}

declare global {
  interface Window {
    __qa2: {
      probe: FrameProbe;
      streams: MediaStream[];
      errors: string[];
      toCanvas(r: Rect): Rect;
      blockCheck(r: Rect, cols: number, rows: number, inset?: number, tol?: number): BlockCheck;
      spacing(c: Rect, axis: 'x' | 'y'): { median: number; n: number };
      detail(c: Rect): Detail;
      sameFrame(key: string, value: unknown, regions: Rect[], margin?: number): SameFrameDiff;
      solid(c: Rect, rgb: [number, number, number], tol?: number): { match: number; n: number };
      countColor(rgb: [number, number, number], tol?: number): number;
      lit(): number;
      hash(): number;
      startSampler(): void;
      stopSampler(): RafSample[];
    };
  }
}

// 페이지에 심을 계측 (직렬화되어 브라우저에서 실행된다)
function qaInit(): void {
  const tags = new WeakMap<ImageBitmap, { id: number; derived: boolean }>();
  let nextId = 1;
  const analysedIds = new Set<number>();
  const probe: FrameProbe = { uploads: 0, analysed: 0, drawn: 0, drawnUnanalysed: 0, unanalysedIds: [], drawnIds: [], firstDrawAt: null, firstUploadAt: null, gum: 0 };
  const errors: string[] = [];
  const streams: MediaStream[] = [];
  const md = navigator.mediaDevices as MediaDevices | undefined;
  if (md?.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      probe.gum++;
      const st = await gum(c);
      streams.push(st);
      return st;
    };
  }
  window.addEventListener('error', (e) => errors.push(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => errors.push(`unhandledrejection: ${String(e.reason)}`));

  const cib = window.createImageBitmap.bind(window) as (...a: unknown[]) => Promise<ImageBitmap>;
  window.createImageBitmap = function (...a: unknown[]): Promise<ImageBitmap> {
    const src = a[0];
    const parent = src instanceof ImageBitmap ? tags.get(src) : undefined;
    return cib(...a).then((bm) => {
      if (parent) tags.set(bm, { id: parent.id, derived: true });
      else if (src instanceof HTMLVideoElement) tags.set(bm, { id: nextId++, derived: false });
      return bm;
    });
  } as typeof window.createImageBitmap;

  const markUpload = (src: unknown): void => {
    if (!(src instanceof ImageBitmap)) return;
    const t = tags.get(src);
    if (!t) return;
    probe.uploads++;
    probe.firstUploadAt ??= performance.now();
    if (!analysedIds.has(t.id)) {
      analysedIds.add(t.id);
      probe.analysed = analysedIds.size;
    }
  };
  // P3: 검출이 Worker에서 돌면 업로드는 Worker 안에서 일어난다. 메인에서는 검출기로 transfer 한 비트맵을 분석한 것으로 본다.
  const post = Worker.prototype.postMessage as (this: Worker, msg: unknown, transfer?: unknown) => void;
  Worker.prototype.postMessage = function (this: Worker, msg: unknown, transfer?: unknown): void {
    const list = Array.isArray(transfer) ? transfer : ((transfer as { transfer?: unknown[] } | undefined)?.transfer ?? []);
    for (const t of list) markUpload(t);
    post.call(this, msg, transfer);
  } as typeof Worker.prototype.postMessage;
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const proto = C.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) {
      const orig = proto[name];
      if (!orig) continue;
      proto[name] = function (this: unknown, ...a: unknown[]): unknown {
        markUpload(a[a.length - 1]);
        return orig.apply(this, a);
      };
    }
  }

  const drawImage = CanvasRenderingContext2D.prototype.drawImage as (...a: unknown[]) => void;
  CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]): void {
    const img = a[0];
    if (this.canvas.id === 'view' && img instanceof ImageBitmap) {
      const t = tags.get(img);
      probe.drawn++;
      probe.firstDrawAt ??= performance.now();
      if (!t || !analysedIds.has(t.id)) {
        probe.drawnUnanalysed++;
        if (probe.unanalysedIds.length < 50) probe.unanalysedIds.push(t?.id ?? null);
      } else if (probe.drawnIds.length < 2000) probe.drawnIds.push(t.id);
    }
    drawImage.apply(this, a);
  } as typeof CanvasRenderingContext2D.prototype.drawImage;

  const view = (): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
    const c = document.getElementById('view') as HTMLCanvasElement;
    return { c, ctx: c.getContext('2d')! };
  };
  const toCanvas = (r: Rect): Rect => {
    const s = window.__am.snapshot();
    const v = s.viewRect;
    const sx = v.width / s.videoWidth;
    const sy = v.height / s.videoHeight;
    const x = s.mirror ? v.x + v.width - (r.x + r.width) * sx : v.x + r.x * sx;
    return { x, y: v.y + r.y * sy, width: r.width * sx, height: r.height * sy };
  };
  const grab = (r: Rect, inset: number): { d: Uint8ClampedArray; w: number; h: number } | null => {
    const x = Math.ceil(r.x + inset);
    const y = Math.ceil(r.y + inset);
    const w = Math.floor(r.x + r.width - inset) - x;
    const h = Math.floor(r.y + r.height - inset) - y;
    if (w < 1 || h < 1) return null;
    return { d: view().ctx.getImageData(x, y, w, h).data, w, h };
  };

  let samples: RafSample[] = [];
  let sampling = false;

  window.__qa2 = {
    probe,
    streams,
    errors,
    toCanvas,
    // r: 원본 프레임 좌표 모자이크 영역. cols×rows 블록 각각의 안쪽 픽셀이 같은지 본다.
    blockCheck(r, cols, rows, inset = 1.5, tol = 2) {
      const bw = r.width / cols;
      const bh = r.height / rows;
      const ranges: number[] = [];
      const reps: ([number, number, number] | null)[] = [];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const g = grab(toCanvas({ x: r.x + i * bw, y: r.y + j * bh, width: bw, height: bh }), inset);
          if (!g) {
            reps.push(null);
            continue;
          }
          const mn = [255, 255, 255];
          const mx = [0, 0, 0];
          for (let k = 0; k < g.d.length; k += 4) {
            for (let ch = 0; ch < 3; ch++) {
              const v = g.d[k + ch]!;
              if (v < mn[ch]!) mn[ch] = v;
              if (v > mx[ch]!) mx[ch] = v;
            }
          }
          ranges.push(Math.max(mx[0]! - mn[0]!, mx[1]! - mn[1]!, mx[2]! - mn[2]!));
          const mid = Math.floor(g.h / 2) * g.w * 4 + Math.floor(g.w / 2) * 4;
          reps.push([g.d[mid]!, g.d[mid + 1]!, g.d[mid + 2]!]);
        }
      }
      const sorted = [...ranges].sort((a, b) => a - b);
      const distinct = new Set(reps.filter((x) => x).map((x) => x!.join(','))).size;
      let adj = 0;
      let adjN = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 1; i < cols; i++) {
          const a = reps[j * cols + i - 1];
          const b = reps[j * cols + i];
          if (!a || !b) continue;
          adj += Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
          adjN++;
        }
      }
      return {
        blocks: ranges.length,
        uniformFrac: ranges.filter((x) => x <= tol).length / ranges.length,
        maxRange: sorted[sorted.length - 1] ?? NaN,
        p95Range: sorted[Math.floor(sorted.length * 0.95)] ?? NaN,
        distinct,
        meanAdjDiff: adjN ? adj / adjN : 0,
      };
    },
    // 캔버스 사각형 안에서 색이 바뀌는 지점 사이 간격의 중앙값 (블록 크기를 픽셀로 잰다)
    spacing(c, axis) {
      const g = grab(c, 2);
      if (!g) return { median: NaN, n: 0 };
      const gaps: number[] = [];
      const lines = 9;
      const outer = axis === 'x' ? g.h : g.w;
      const inner = axis === 'x' ? g.w : g.h;
      for (let l = 1; l <= lines; l++) {
        const o = Math.floor((outer * l) / (lines + 1));
        let lastChange = -1;
        for (let p = 1; p < inner; p++) {
          const k = axis === 'x' ? (o * g.w + p) * 4 : (p * g.w + o) * 4;
          const q = axis === 'x' ? k - 4 : k - g.w * 4;
          const diff = Math.max(Math.abs(g.d[k]! - g.d[q]!), Math.abs(g.d[k + 1]! - g.d[q + 1]!), Math.abs(g.d[k + 2]! - g.d[q + 2]!));
          if (diff > 6) {
            if (lastChange >= 0 && p - lastChange > 1) gaps.push(p - lastChange);
            lastChange = p;
          }
        }
      }
      gaps.sort((a, b) => a - b);
      return { median: gaps[Math.floor(gaps.length / 2)] ?? NaN, n: gaps.length };
    },
    detail(c) {
      const g = grab(c, 3)!;
      let flat = 0;
      let pairs = 0;
      let grad = 0;
      const colors = new Set<number>();
      for (let j = 0; j < g.h; j++) {
        for (let i = 0; i < g.w; i++) {
          const k = (j * g.w + i) * 4;
          colors.add(((g.d[k]! >> 3) << 10) | ((g.d[k + 1]! >> 3) << 5) | (g.d[k + 2]! >> 3));
          if (i === 0) continue;
          const diff = Math.max(Math.abs(g.d[k]! - g.d[k - 4]!), Math.abs(g.d[k + 1]! - g.d[k - 3]!), Math.abs(g.d[k + 2]! - g.d[k - 2]!));
          pairs++;
          grad += diff;
          if (diff <= 2) flat++;
        }
      }
      return { flat: flat / pairs, meanGrad: grad / pairs, distinct: colors.size };
    },
    // 같은 분석 프레임을 지금 파라미터로 한 번, key=value로 한 번 그려 비교한다 (값은 되돌린다).
    // 표시 파라미터를 바꾸면 앱이 마지막 분석 프레임을 동기적으로 다시 그린다.
    sameFrame(key, value, regions, margin = 3) {
      const { c, ctx } = view();
      const before = window.__am.get(key);
      const fa = window.__am.snapshot().drawnFrameId;
      const A = ctx.getImageData(0, 0, c.width, c.height).data;
      window.__am.set(key, value as never);
      const fb = window.__am.snapshot().drawnFrameId;
      const B = ctx.getImageData(0, 0, c.width, c.height).data;
      window.__am.set(key, before as never);
      const rects = regions.map(toCanvas);
      const inside = (x: number, y: number, m: number): boolean =>
        rects.some((r) => x >= r.x - m && x <= r.x + r.width + m && y >= r.y - m && y <= r.y + r.height + m);
      const ins = { sum: 0, max: 0, n: 0 };
      const out = { sum: 0, max: 0, over2: 0, n: 0 };
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const k = (y * c.width + x) * 4;
          const diff = Math.max(Math.abs(A[k]! - B[k]!), Math.abs(A[k + 1]! - B[k + 1]!), Math.abs(A[k + 2]! - B[k + 2]!));
          if (inside(x, y, -margin)) {
            ins.sum += diff;
            ins.max = Math.max(ins.max, diff);
            ins.n++;
          } else if (!inside(x, y, margin)) {
            out.sum += diff;
            out.max = Math.max(out.max, diff);
            if (diff > 2) out.over2++;
            out.n++;
          }
        }
      }
      return {
        frameA: fa,
        frameB: fb,
        inside: { mean: ins.sum / ins.n, max: ins.max, n: ins.n },
        outside: { mean: out.sum / out.n, max: out.max, over2: out.over2 / out.n, n: out.n },
      };
    },
    solid(c, rgb, tol = 1) {
      const g = grab(c, 2)!;
      let match = 0;
      for (let k = 0; k < g.d.length; k += 4) {
        if (Math.abs(g.d[k]! - rgb[0]) <= tol && Math.abs(g.d[k + 1]! - rgb[1]) <= tol && Math.abs(g.d[k + 2]! - rgb[2]) <= tol) match++;
      }
      return { match: match / (g.w * g.h), n: g.w * g.h };
    },
    countColor(rgb, tol = 1) {
      const { c, ctx } = view();
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) {
        if (Math.abs(d[k]! - rgb[0]) <= tol && Math.abs(d[k + 1]! - rgb[1]) <= tol && Math.abs(d[k + 2]! - rgb[2]) <= tol) n++;
      }
      return n;
    },
    // 밝기 30 넘는 픽셀 비율 (빈 화면이면 0)
    lit() {
      const { c, ctx } = view();
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let k = 0; k < d.length; k += 16) if (0.299 * d[k]! + 0.587 * d[k + 1]! + 0.114 * d[k + 2]! > 30) lit++;
      return lit / (d.length / 16);
    },
    hash() {
      const { c, ctx } = view();
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let k = 0; k < d.length; k += 7) h = Math.imul(h ^ d[k]!, 16777619);
      return h >>> 0;
    },
    startSampler() {
      samples = [];
      sampling = true;
      const tick = (): void => {
        if (!sampling) return;
        const s = window.__am.snapshot();
        samples.push({ t: performance.now(), drawn: s.drawnFrameId, det: s.detectionFrameId, state: s.detectorState, frameCount: s.frameCount, dets: s.detections.length, regions: s.regions.length });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stopSampler() {
      sampling = false;
      return samples;
    },
  };
}

export async function installQa2(page: Page): Promise<void> {
  await page.addInitScript(qaInit);
}

export function probe2(page: Page): Promise<FrameProbe> {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__qa2.probe)) as FrameProbe);
}

// pixelate의 블록 격자 (README: 상대 = 영역 폭 / 칸 수, 절대 = px. 블록은 정사각형에 가깝게 반올림)
export function grid(region: Rect, mode: string, blockSize: number, blockCells: number, refWidth = region.width): { cols: number; rows: number } {
  const block = mode === 'absolute' ? blockSize : refWidth / blockCells;
  return { cols: Math.max(1, Math.round(region.width / block)), rows: Math.max(1, Math.round(region.height / block)) };
}

// 분석된 프레임이 n개 더 그려질 때까지
export async function waitFrames(page: Page, n = 2, timeout = 10_000): Promise<void> {
  const start = await page.evaluate(() => window.__am.snapshot().frameCount);
  await page.waitForFunction((target) => window.__am.snapshot().frameCount >= target, start + n, { timeout });
}

// 새로 그려지는 분석 프레임마다 검출 수를 n개 모은다
export function collectDetections(page: Page, n: number, timeout = 15_000): Promise<{ frameId: number | null; count: number; scores: number[] }[]> {
  return page.evaluate(
    ([n, timeout]) =>
      new Promise((resolve, reject) => {
        const out: { frameId: number | null; count: number; scores: number[] }[] = [];
        let last = window.__am.snapshot().drawnFrameId;
        const t0 = performance.now();
        const tick = (): void => {
          const s = window.__am.snapshot();
          if (s.drawnFrameId !== null && s.drawnFrameId !== last) {
            last = s.drawnFrameId;
            out.push({ frameId: s.drawnFrameId, count: s.detections.length, scores: s.detections.map((d) => d.score) });
          }
          if (out.length >= n) resolve(out);
          else if (performance.now() - t0 > timeout) reject(new Error(`프레임 ${out.length}/${n}개만 모였습니다`));
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    [n, timeout] as const,
  );
}

// 앱이 남긴 콘솔 오류·경고. MediaPipe WASM 자체 로그와, 테스트가 getImageData로 캔버스를 자주 읽어서
// Chrome이 남기는 willReadFrequently 경고(앱 문제가 아님)는 뺀다.
export function appConsoleProblems(entries: { type: string; text: string }[]): { type: string; text: string }[] {
  return entries.filter((e) => (e.type === 'error' || e.type === 'warning') && !isMediaPipeLog(e.text) && !e.text.includes('willReadFrequently'));
}
