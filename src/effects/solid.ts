import { regionBounds, snapOut } from '../core/geometry';
import type { Effect, Region } from '../core/types';
import { clipToShape } from './clip';

export type SolidParams = {
  solidColor: string;
};

// 단색 채움. 이펙트를 바꿔 끼울 수 있음을 보이는 두 번째 구현이다. 타원이면 그 모양으로 잘라 채운다.
export const solid: Effect<SolidParams> = {
  id: 'solid',
  label: 'Solid fill',
  params: [{ key: 'solidColor', label: 'Color', type: 'color', default: '#000000' }],
  apply(ctx: CanvasRenderingContext2D, _frame: CanvasImageSource, region: Region, p: SolidParams): void {
    const r = snapOut(regionBounds(region));
    ctx.save();
    clipToShape(ctx, region);
    ctx.fillStyle = p.solidColor;
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();
  },
};
