import { scaleRect } from './geometry';
import type { Detection, Size } from './types';

// 축소한 추론 입력(from) 좌표의 검출 결과를 원본 프레임(to) 픽셀 좌표로 되돌린다.
// 프레임 밖으로 나간 부분도 자르지 않는다. 패딩을 실제 얼굴 크기로 하고 그 뒤에 자르게 렌더 단계에서 자른다.
export function mapToSource(detections: readonly Detection[], from: Size, to: Size): Detection[] {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const out: Detection[] = [];
  for (const d of detections) {
    const box = scaleRect(d.box, sx, sy);
    if (!(box.width > 0 && box.height > 0)) continue;
    const mapped: Detection = { ...d, box };
    if (d.keypoints) mapped.keypoints = d.keypoints.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    out.push(mapped);
  }
  return out;
}
