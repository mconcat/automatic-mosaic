import { regionBounds, snapOut } from '../core/geometry';
import type { Effect, Rect, Region } from '../core/types';
import { clipToShape } from './clip';

export type PixelateParams = {
  blockMode: 'relative' | 'absolute';
  blockSize: number; // 절대: 블록 한 변 (원본 px)
  blockCells: number; // 상대: 영역 폭을 나눌 칸 수
  strength: number; // 원본과 혼합 (0–1)
};

// 영역 r을 몇 칸으로 나눌지. 블록은 정사각형에 가깝게 맞춘다.
// 상대 블록 크기는 refWidth(프레임으로 자르기 전 영역 폭) 기준이라, 얼굴이 가장자리에 걸려도 블록이 작아지지 않는다.
export function pixelGrid(r: Rect, p: PixelateParams, refWidth = r.width): { cols: number; rows: number } {
  const block = p.blockMode === 'absolute' ? p.blockSize : refWidth / p.blockCells;
  return { cols: Math.max(1, Math.round(r.width / block)), rows: Math.max(1, Math.round(r.height / block)) };
}

let scratch: OffscreenCanvasRenderingContext2D | null = null;

function scratchContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  scratch ??= new OffscreenCanvas(1, 1).getContext('2d');
  if (!scratch) throw new Error('Cannot create an OffscreenCanvas 2D context.');
  if (scratch.canvas.width < width) scratch.canvas.width = width;
  if (scratch.canvas.height < height) scratch.canvas.height = height;
  return scratch;
}

// 축소 → 확대 픽셀화 (PLAN §1.3). 영역을 감싸는 사각형을 픽셀화하고, 타원이면 그 모양으로 잘라 그린다.
export const pixelate: Effect<PixelateParams> = {
  id: 'pixelate',
  label: 'Pixelate',
  params: [
    {
      key: 'blockMode',
      label: 'Block size mode',
      type: 'select',
      options: [
        { label: 'Relative (cells across region)', value: 'relative' },
        { label: 'Absolute (px)', value: 'absolute' },
      ],
      default: 'relative',
    },
    { key: 'blockCells', label: 'Block count (cells)', type: 'number', min: 4, max: 32, step: 1, default: 10, visibleIf: { key: 'blockMode', equals: 'relative' } },
    { key: 'blockSize', label: 'Block size (px)', type: 'number', min: 4, max: 64, step: 1, default: 16, visibleIf: { key: 'blockMode', equals: 'absolute' } },
    { key: 'strength', label: 'Strength', type: 'number', min: 0, max: 1, step: 0.05, default: 1 },
  ],
  apply(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, region: Region, p: PixelateParams): void {
    if (p.strength <= 0) return;
    const r = snapOut(regionBounds(region));
    if (r.width < 1 || r.height < 1) return;
    const { cols, rows } = pixelGrid(r, p, (region.unclipped ?? r).width);
    const small = scratchContext(cols, rows);
    small.imageSmoothingEnabled = true;
    small.imageSmoothingQuality = 'high'; // 축소할 때 평균에 가깝게
    small.drawImage(frame, r.x, r.y, r.width, r.height, 0, 0, cols, rows);
    ctx.save();
    clipToShape(ctx, region);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = p.strength;
    ctx.drawImage(small.canvas, 0, 0, cols, rows, r.x, r.y, r.width, r.height);
    ctx.restore();
  },
};
