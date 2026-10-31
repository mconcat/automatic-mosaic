// 캔버스 픽셀 분석 헬퍼 (P2 모자이크 검증). 큰 이미지를 넘기지 않게 계산은 페이지 안에서 한다.
import type { Page } from '@playwright/test';
import type { Rect } from '../../src/core/types';
import { snapshot } from './helpers';

declare global {
  interface Window {
    __caps?: Record<string, ImageData>;
  }
}

export interface RegionStats {
  w: number;
  h: number;
  flat: number; // 가로로 이웃한 픽셀 쌍 중 거의 같은(채널 차 ≤ tol) 비율. 블록이면 1에 가깝다
  run: number; // 가로 방향 같은 색 구간의 평균 길이 (캔버스 px). 블록이 클수록 길다
  lumaStd: number;
  mean: [number, number, number];
}

// 원본 프레임 좌표 사각형 → 캔버스 버퍼 좌표 (미러 반영)
export async function toCanvasRect(page: Page, r: Rect): Promise<Rect> {
  const s = await snapshot(page);
  const v = s.viewRect;
  const sx = v.width / s.videoWidth;
  const sy = v.height / s.videoHeight;
  const x = s.mirror ? v.x + v.width - (r.x + r.width) * sx : v.x + r.x * sx;
  return { x, y: v.y + r.y * sy, width: r.width * sx, height: r.height * sy };
}

// 캔버스 사각형(가장자리 inset px 제외)의 통계
export function regionStats(page: Page, r: Rect, inset = 3, tol = 4): Promise<RegionStats> {
  return page.evaluate(
    ({ r, inset, tol }) => {
      const c = document.getElementById('view') as HTMLCanvasElement;
      const x = Math.ceil(r.x + inset);
      const y = Math.ceil(r.y + inset);
      const w = Math.max(1, Math.floor(r.x + r.width - inset) - x);
      const h = Math.max(1, Math.floor(r.y + r.height - inset) - y);
      const d = c.getContext('2d')!.getImageData(x, y, w, h).data;
      let flat = 0;
      let pairs = 0;
      let runs = 0;
      const lum: number[] = [];
      const sum = [0, 0, 0];
      for (let j = 0; j < h; j++) {
        runs++;
        for (let i = 0; i < w; i++) {
          const k = (j * w + i) * 4;
          lum.push(0.299 * d[k]! + 0.587 * d[k + 1]! + 0.114 * d[k + 2]!);
          for (let ch = 0; ch < 3; ch++) sum[ch]! += d[k + ch]!;
          if (i === 0) continue;
          const diff = Math.max(Math.abs(d[k]! - d[k - 4]!), Math.abs(d[k + 1]! - d[k - 3]!), Math.abs(d[k + 2]! - d[k - 2]!));
          pairs++;
          if (diff <= tol) flat++;
          else runs++;
        }
      }
      const n = w * h;
      const mean = lum.reduce((a, b) => a + b, 0) / n;
      const lumaStd = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      return { w, h, flat: flat / pairs, run: n / runs, lumaStd, mean: sum.map((v) => v / n) as [number, number, number] };
    },
    { r, inset, tol },
  );
}

// 캔버스 전체를 이름 붙여 저장한다 (페이지 안에)
export function capture(page: Page, name: string): Promise<void> {
  return page.evaluate((name) => {
    const c = document.getElementById('view') as HTMLCanvasElement;
    window.__caps ??= {};
    window.__caps[name] = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  }, name);
}

// 저장한 두 캔버스를 exclude 사각형(+margin) 밖에서 비교한다.
export function diffOutside(page: Page, a: string, b: string, exclude: Rect[], margin = 4): Promise<{ mean: number; over8: number; pixels: number }> {
  return page.evaluate(
    ({ a, b, exclude, margin }) => {
      const A = window.__caps![a]!;
      const B = window.__caps![b]!;
      if (A.width !== B.width || A.height !== B.height) throw new Error('캔버스 크기가 다릅니다');
      const inside = (x: number, y: number): boolean =>
        exclude.some((r) => x >= r.x - margin && x <= r.x + r.width + margin && y >= r.y - margin && y <= r.y + r.height + margin);
      let sum = 0;
      let over = 0;
      let n = 0;
      for (let y = 0; y < A.height; y += 2) {
        for (let x = 0; x < A.width; x += 2) {
          if (inside(x, y)) continue;
          const k = (y * A.width + x) * 4;
          const diff = Math.max(Math.abs(A.data[k]! - B.data[k]!), Math.abs(A.data[k + 1]! - B.data[k + 1]!), Math.abs(A.data[k + 2]! - B.data[k + 2]!));
          sum += diff;
          if (diff > 8) over++;
          n++;
        }
      }
      return { mean: sum / n, over8: over / n, pixels: n };
    },
    { a, b, exclude, margin },
  );
}

// 새 프레임이 그려질 때까지 기다린다 (파라미터 변경이 다음 분석 프레임에 반영되게)
export async function nextFrames(page: Page, count = 2): Promise<void> {
  const start = (await snapshot(page)).frameCount;
  await page.waitForFunction((n) => window.__am.snapshot().frameCount >= n, start + count);
}
