import type { Size } from '../core/types';
import { pixelate } from './pixelate';

// fail-closed 덮개: 프레임 전체를 굵게 픽셀화한다. 고른 이펙트·강도와 상관없이 항상 완전히 가린다.
export const COVER_CELLS = 12; // 가로 칸 수 (640px 프레임 → 약 53px 블록)

export function coverFrame(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, size: Size): void {
  const rect = { x: 0, y: 0, width: size.width, height: size.height };
  pixelate.apply(ctx, frame, { kind: 'rect', rect }, { blockMode: 'relative', blockCells: COVER_CELLS, blockSize: 16, strength: 1 });
}
