import type { Detection, Rect, Track } from '../core/types';

// 디버그 오버레이: 검출 박스(초록), 키포인트, 모자이크 영역(노랑 점선, 유지 중이면 주황), 트랙 id·점수.
// ctx에는 프레임 → 캔버스 변환(미러 포함)이 걸려 있다. 글자는 뒤집히지 않게 캔버스 좌표로 쓴다.

export interface OverlayMark {
  rect: Rect; // 모자이크 영역 (원본 px)
  track: Track;
  held: boolean; // 이 프레임에서는 검출되지 않고 유지 중
}

const DETECTION = '#22c55e';
const REGION = '#facc15';
const HELD = '#fb923c';

export function drawDebugOverlay(ctx: CanvasRenderingContext2D, detections: readonly Detection[], marks: readonly OverlayMark[]): void {
  const m = ctx.getTransform();
  const px = 1 / Math.hypot(m.a, m.b); // 캔버스 1px에 해당하는 프레임 길이
  ctx.save();
  ctx.lineWidth = 2 * px;

  ctx.setLineDash([6 * px, 4 * px]);
  for (const { rect: r, held } of marks) {
    ctx.strokeStyle = held ? HELD : REGION;
    ctx.strokeRect(r.x, r.y, r.width, r.height);
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = DETECTION;
  ctx.fillStyle = DETECTION;
  for (const d of detections) {
    ctx.strokeRect(d.box.x, d.box.y, d.box.width, d.box.height);
    for (const k of d.keypoints ?? []) {
      ctx.beginPath();
      ctx.arc(k.x, k.y, 3 * px, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 트랙 id와 점수: 모자이크 영역의 화면상 왼쪽 위에 쓴다.
  const dpr = Math.max(1, window.devicePixelRatio);
  const lineHeight = 18 * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${Math.round(14 * dpr)}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const { rect: r, track, held } of marks) {
    const a = m.transformPoint({ x: r.x, y: r.y });
    const b = m.transformPoint({ x: r.x + r.width, y: r.y });
    const text = held ? `#${track.id} held` : `#${track.id} ${track.label} ${track.source.score.toFixed(2)}`;
    const x = Math.min(a.x, b.x);
    const y = Math.max(a.y, lineHeight);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x, y - lineHeight, ctx.measureText(text).width + 8 * dpr, lineHeight);
    ctx.fillStyle = held ? HELD : DETECTION;
    ctx.fillText(text, x + 4 * dpr, y - 2 * dpr);
  }
  ctx.restore();
}
