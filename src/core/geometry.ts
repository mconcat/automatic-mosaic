import type { Point, Rect, Region, Size } from './types';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function scaleRect(r: Rect, sx: number, sy: number = sx): Rect {
  return { x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy };
}

// 중심을 유지한 채 가로·세로를 factor배로 늘린다 (1.3 → 30% 확장).
export function padRect(r: Rect, factor: number): Rect {
  const width = r.width * factor;
  const height = r.height * factor;
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

// 프레임 안으로 잘라낸다. 완전히 밖이면 크기 0.
export function clampRect(r: Rect, bounds: Size): Rect {
  const x1 = clamp(r.x, 0, bounds.width);
  const y1 = clamp(r.y, 0, bounds.height);
  const x2 = clamp(r.x + r.width, 0, bounds.width);
  const y2 = clamp(r.y + r.height, 0, bounds.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

// 두 사각형을 모두 감싸는 가장 작은 사각형
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function area(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function iou(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

// 좌우 반전 (렌더 단계 전용)
export function mirrorRect(r: Rect, frameWidth: number): Rect {
  return { ...r, x: frameWidth - r.x - r.width };
}

export function mirrorPoint(p: Point, frameWidth: number): Point {
  return { ...p, x: frameWidth - p.x };
}

// content를 비율을 지키며 container 안에 가운데 맞춤으로 넣을 영역 (레터박스)
export function fitContain(content: Size, container: Size): Rect {
  if (content.width <= 0 || content.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const s = Math.min(container.width / content.width, container.height / content.height);
  const width = content.width * s;
  const height = content.height * s;
  return { x: (container.width - width) / 2, y: (container.height - height) / 2, width, height };
}

// 긴 변이 longSide를 넘지 않게 비율을 지켜 줄인 크기 (정수). longSide가 0이거나 이미 작으면 그대로.
export function fitLongSide(size: Size, longSide: number): Size {
  const long = Math.max(size.width, size.height);
  if (longSide <= 0 || long <= longSide) return { width: size.width, height: size.height };
  const s = longSide / long;
  return { width: Math.max(1, Math.round(size.width * s)), height: Math.max(1, Math.round(size.height * s)) };
}

// 바깥쪽으로 정수 픽셀에 맞춘다 (가리는 영역은 줄어들지 않게).
export function snapOut(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}

// 영역을 감싸는 사각형
export function regionBounds(region: Region): Rect {
  if (region.kind !== 'polygon') return region.rect;
  const xs = region.points.map((p) => p.x);
  const ys = region.points.map((p) => p.y);
  if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
