import { describe, expect, it } from 'vitest';
import { pixelGrid, pixelate, type PixelateParams } from '../../src/effects/pixelate';
import { solid } from '../../src/effects/solid';

const params = (p: Partial<PixelateParams>): PixelateParams => ({ blockMode: 'relative', blockSize: 16, blockCells: 10, strength: 1, ...p });

describe('pixelGrid', () => {
  it('상대: 영역 폭을 칸 수로 나누고, 세로는 정사각형 블록에 맞춘다', () => {
    expect(pixelGrid({ x: 0, y: 0, width: 300, height: 300 }, params({ blockCells: 10 }))).toEqual({ cols: 10, rows: 10 });
    expect(pixelGrid({ x: 0, y: 0, width: 300, height: 150 }, params({ blockCells: 10 }))).toEqual({ cols: 10, rows: 5 });
    // 얼굴 크기와 무관하게 같은 칸 수
    expect(pixelGrid({ x: 0, y: 0, width: 60, height: 60 }, params({ blockCells: 10 }))).toEqual({ cols: 10, rows: 10 });
  });

  it('절대: 블록 한 변이 blockSize px에 가깝다', () => {
    expect(pixelGrid({ x: 0, y: 0, width: 320, height: 160 }, params({ blockMode: 'absolute', blockSize: 16 }))).toEqual({ cols: 20, rows: 10 });
    expect(pixelGrid({ x: 0, y: 0, width: 300, height: 300 }, params({ blockMode: 'absolute', blockSize: 32 }))).toEqual({ cols: 9, rows: 9 });
  });

  it('상대: 프레임 가장자리에서 잘린 영역도 자르기 전 폭(refWidth) 기준 블록 크기를 쓴다', () => {
    // 얼굴 영역 260×260 중 절반이 프레임 밖 → 그릴 영역은 130×260. 블록은 그대로 26px.
    const inside = pixelGrid({ x: 300, y: 100, width: 260, height: 260 }, params({ blockCells: 10 }));
    const clipped = pixelGrid({ x: 0, y: 100, width: 130, height: 260 }, params({ blockCells: 10 }), 260);
    expect(inside).toEqual({ cols: 10, rows: 10 });
    expect(clipped).toEqual({ cols: 5, rows: 10 });
    expect(130 / clipped.cols).toBe(260 / inside.cols);
    // refWidth 없이 잘린 폭으로 나누면 블록이 절반으로 작아진다 (예전 동작)
    expect(pixelGrid({ x: 0, y: 100, width: 130, height: 260 }, params({ blockCells: 10 }))).toEqual({ cols: 10, rows: 20 });
  });

  it('블록이 영역보다 커도 최소 1칸', () => {
    expect(pixelGrid({ x: 0, y: 0, width: 10, height: 5 }, params({ blockMode: 'absolute', blockSize: 64 }))).toEqual({ cols: 1, rows: 1 });
  });

  it('블록이 클수록 칸 수가 줄어든다', () => {
    const r = { x: 0, y: 0, width: 292, height: 292 };
    const small = pixelGrid(r, params({ blockMode: 'absolute', blockSize: 8 }));
    const large = pixelGrid(r, params({ blockMode: 'absolute', blockSize: 32 }));
    expect(large.cols).toBeLessThan(small.cols);
  });
});

describe('이펙트 스키마', () => {
  it('pixelate: 블록 방식에 따라 하나의 블록 크기 슬라이더만 보인다', () => {
    const keys = pixelate.params.map((p) => p.key);
    expect(keys).toEqual(['blockMode', 'blockCells', 'blockSize', 'strength']);
    expect(pixelate.params.find((p) => p.key === 'blockCells')?.visibleIf).toEqual({ key: 'blockMode', equals: 'relative' });
    expect(pixelate.params.find((p) => p.key === 'blockSize')?.visibleIf).toEqual({ key: 'blockMode', equals: 'absolute' });
  });

  it('기본값은 PLAN §4 값', () => {
    expect(Object.fromEntries(pixelate.params.map((p) => [p.key, p.default]))).toEqual({ blockMode: 'relative', blockCells: 10, blockSize: 16, strength: 1 });
  });

  it('PLAN §4 범위', () => {
    const range = (key: string) => {
      const s = pixelate.params.find((p) => p.key === key);
      return s?.type === 'number' ? [s.min, s.max] : null;
    };
    expect(range('blockSize')).toEqual([4, 64]);
    expect(range('blockCells')).toEqual([4, 32]);
    expect(range('strength')).toEqual([0, 1]);
  });

  it('solid: 색 하나', () => {
    expect(solid.params).toEqual([{ key: 'solidColor', label: 'Color', type: 'color', default: '#000000' }]);
  });
});
