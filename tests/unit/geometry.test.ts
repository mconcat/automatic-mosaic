import { describe, expect, it } from 'vitest';
import {
  area,
  clamp,
  clampRect,
  fitContain,
  fitLongSide,
  iou,
  mirrorPoint,
  mirrorRect,
  padRect,
  regionBounds,
  scaleRect,
  snapOut,
} from '../../src/core/geometry';

describe('clamp', () => {
  it('범위 안팎 값을 자른다', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('scaleRect', () => {
  it('균등 배율', () => {
    expect(scaleRect({ x: 10, y: 20, width: 30, height: 40 }, 2)).toEqual({ x: 20, y: 40, width: 60, height: 80 });
  });
  it('축별 배율 (추론 해상도 → 원본 좌표)', () => {
    expect(scaleRect({ x: 10, y: 10, width: 64, height: 48 }, 2, 1.5)).toEqual({ x: 20, y: 15, width: 128, height: 72 });
  });
});

describe('padRect', () => {
  it('중심을 유지하며 확장한다', () => {
    const r = padRect({ x: 100, y: 100, width: 100, height: 50 }, 1.3);
    expect(r.width).toBeCloseTo(130);
    expect(r.height).toBeCloseTo(65);
    expect(r.x + r.width / 2).toBeCloseTo(150);
    expect(r.y + r.height / 2).toBeCloseTo(125);
  });
  it('배율 1이면 그대로', () => {
    expect(padRect({ x: 1, y: 2, width: 3, height: 4 }, 1)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('clampRect', () => {
  const frame = { width: 640, height: 480 };
  it('프레임 밖으로 나간 부분을 자른다', () => {
    expect(clampRect({ x: -20, y: 400, width: 100, height: 200 }, frame)).toEqual({ x: 0, y: 400, width: 80, height: 80 });
  });
  it('완전히 밖이면 크기 0', () => {
    expect(area(clampRect({ x: 700, y: 10, width: 50, height: 50 }, frame))).toBe(0);
  });
  it('안에 있으면 그대로', () => {
    expect(clampRect({ x: 10, y: 10, width: 50, height: 50 }, frame)).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });
});

describe('iou', () => {
  it('같은 사각형은 1', () => {
    const r = { x: 0, y: 0, width: 10, height: 10 };
    expect(iou(r, r)).toBe(1);
  });
  it('겹치지 않으면 0 (모서리만 닿아도 0)', () => {
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(0);
  });
  it('절반 겹침', () => {
    // 교집합 50, 합집합 150
    expect(iou({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 })).toBeCloseTo(1 / 3);
  });
  it('크기 0 사각형은 0', () => {
    expect(iou({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 })).toBe(0);
  });
});

describe('mirror', () => {
  it('사각형을 좌우 반전한다', () => {
    expect(mirrorRect({ x: 10, y: 5, width: 100, height: 50 }, 640)).toEqual({ x: 530, y: 5, width: 100, height: 50 });
  });
  it('두 번 반전하면 원래대로', () => {
    const r = { x: 33, y: 7, width: 12, height: 9 };
    expect(mirrorRect(mirrorRect(r, 640), 640)).toEqual(r);
  });
  it('점을 좌우 반전한다', () => {
    expect(mirrorPoint({ x: 100, y: 20 }, 640)).toEqual({ x: 540, y: 20 });
  });
});

describe('fitContain', () => {
  it('가로가 남으면 좌우 레터박스', () => {
    expect(fitContain({ width: 640, height: 480 }, { width: 1000, height: 480 })).toEqual({ x: 180, y: 0, width: 640, height: 480 });
  });
  it('세로가 남으면 위아래 레터박스', () => {
    expect(fitContain({ width: 1280, height: 720 }, { width: 640, height: 640 })).toEqual({ x: 0, y: 140, width: 640, height: 360 });
  });
  it('크기가 0이면 빈 영역', () => {
    expect(fitContain({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('fitLongSide', () => {
  it('긴 변을 기준으로 비율을 지켜 줄인다', () => {
    expect(fitLongSide({ width: 1280, height: 720 }, 640)).toEqual({ width: 640, height: 360 });
    expect(fitLongSide({ width: 480, height: 640 }, 320)).toEqual({ width: 240, height: 320 });
    expect(fitLongSide({ width: 640, height: 480 }, 480)).toEqual({ width: 480, height: 360 });
  });
  it('이미 작거나 0(원본)이면 그대로', () => {
    expect(fitLongSide({ width: 640, height: 480 }, 640)).toEqual({ width: 640, height: 480 });
    expect(fitLongSide({ width: 320, height: 240 }, 640)).toEqual({ width: 320, height: 240 });
    expect(fitLongSide({ width: 1920, height: 1080 }, 0)).toEqual({ width: 1920, height: 1080 });
  });
  it('정수로 반올림하고 1px 아래로는 줄이지 않는다', () => {
    expect(fitLongSide({ width: 1000, height: 333 }, 320)).toEqual({ width: 320, height: 107 });
    expect(fitLongSide({ width: 10000, height: 1 }, 320)).toEqual({ width: 320, height: 1 });
  });
});

describe('snapOut', () => {
  it('바깥쪽 정수 픽셀로 넓힌다 (줄어들지 않는다)', () => {
    expect(snapOut({ x: 10.4, y: 20.6, width: 30.2, height: 9.1 })).toEqual({ x: 10, y: 20, width: 31, height: 10 });
    expect(snapOut({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('regionBounds', () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  it('사각형·타원·마스크는 rect 그대로', () => {
    expect(regionBounds({ kind: 'rect', rect })).toEqual(rect);
    expect(regionBounds({ kind: 'ellipse', rect })).toEqual(rect);
  });
  it('다각형은 점들을 감싸는 사각형', () => {
    const points = [
      { x: 5, y: 1 },
      { x: 2, y: 8 },
      { x: 9, y: 4 },
    ];
    expect(regionBounds({ kind: 'polygon', points })).toEqual({ x: 2, y: 1, width: 7, height: 7 });
    expect(regionBounds({ kind: 'polygon', points: [] })).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
