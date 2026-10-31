import type { Region } from '../core/types';

// 영역 모양대로 그리기를 자른다 (이펙트가 ctx.save() 안에서 부른다). 사각형은 그리는 영역 자체라 자르지 않는다.
// 타원은 프레임으로 자르기 전 영역(unclipped)에 내접시킨다. 가장자리에 걸린 얼굴도 타원이 찌그러지지 않는다.
export function clipToShape(ctx: CanvasRenderingContext2D, region: Region): void {
  if (region.kind !== 'ellipse') return;
  const r = region.unclipped ?? region.rect;
  ctx.beginPath();
  ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
  ctx.clip();
}
