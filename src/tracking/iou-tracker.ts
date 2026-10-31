import { iou, unionRect } from '../core/geometry';
import type { Detection, Point, Rect, Track } from '../core/types';
import { OneEuroFilter, type OneEuroParams } from './one-euro';

// IoU 트래커 (SORT를 단순화한 것). 분석한 프레임마다 검출 결과를 이전 트랙과 IoU 그리디 매칭해 같은 대상에 같은 id를 붙인다.
// - 새 검출은 바로 트랙이 된다 (여러 번 보여야 인정하는 지연 없음. 가리는 용도라 놓치는 쪽이 더 나쁘다).
// - 검출이 끊긴 트랙은 마지막 검출 뒤 holdMs 동안 마지막 박스로 남는다.
// - 트랙마다 박스 중심·크기(cx, cy, w, h)를 One Euro로 거른다. 거른 박스는 그 프레임의 검출 박스와 합쳐(union) 내보내므로
//   스무딩 때문에 가리는 범위가 검출보다 줄지 않는다.
// - 매칭할 때 트랙 위치는 마지막 검출 박스를 최근 속도만큼 옮겨 예측한다 (낮은 FPS에서 빠르게 움직여도 id가 이어지게).

export interface TrackerOptions {
  holdMs: number;
  iouThreshold: number;
  smoothing: boolean;
  minCutoff: number;
  beta: number;
  dCutoff?: number; // 기본 1Hz
}

const PREDICT_MAX_MS = 300; // 예측은 이 시간까지만 (오래 유지된 트랙이 멀리 날아가지 않게)

interface Entry {
  id: number;
  label: string;
  source: Detection; // 마지막으로 매칭된 검출
  box: Rect; // 마지막으로 내보낸 박스 (유지 중에는 그대로)
  lastSeenMs: number;
  velocity: Point; // 검출 박스 중심의 속도 (px/ms)
  filters: Record<'cx' | 'cy' | 'w' | 'h', OneEuroFilter>;
}

function centre(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function predict(e: Entry, nowMs: number): Rect {
  const dt = Math.min(Math.max(0, nowMs - e.lastSeenMs), PREDICT_MAX_MS);
  const b = e.source.box;
  return { ...b, x: b.x + e.velocity.x * dt, y: b.y + e.velocity.y * dt };
}

function toTrack(e: Entry): Track {
  return { id: e.id, label: e.label, box: { ...e.box }, lastSeenMs: e.lastSeenMs, source: e.source };
}

export class IouTracker {
  private entries: Entry[] = [];
  private nextId = 1;

  /** nowMs(프레임 시각) 프레임의 검출로 트랙을 갱신하고, 유지 중인 트랙까지 모두 돌려준다. 돌려준 객체는 나중에 바꾸지 않는다. */
  update(detections: readonly Detection[], nowMs: number, opts: TrackerOptions): Track[] {
    const pairs: { e: number; d: number; score: number }[] = [];
    this.entries.forEach((entry, e) => {
      const predicted = predict(entry, nowMs);
      detections.forEach((det, d) => {
        if (det.label !== entry.label) return;
        const score = iou(predicted, det.box);
        if (score > 0 && score >= opts.iouThreshold) pairs.push({ e, d, score });
      });
    });
    // 그리디: IoU가 큰 짝부터, 둘 다 아직 짝이 없을 때만
    pairs.sort((a, b) => b.score - a.score);
    const usedE = new Set<number>();
    const usedD = new Set<number>();
    for (const { e, d } of pairs) {
      if (usedE.has(e) || usedD.has(d)) continue;
      usedE.add(e);
      usedD.add(d);
      this.observe(this.entries[e]!, detections[d]!, nowMs, opts);
    }
    const kept = this.entries.filter((entry, e) => usedE.has(e) || nowMs - entry.lastSeenMs <= opts.holdMs);
    detections.forEach((det, d) => {
      if (!usedD.has(d)) kept.push(this.create(det, nowMs, opts));
    });
    this.entries = kept;
    return kept.map(toTrack);
  }

  reset(): void {
    this.entries = [];
    this.nextId = 1;
  }

  private create(det: Detection, nowMs: number, opts: TrackerOptions): Entry {
    const entry: Entry = {
      id: this.nextId++,
      label: det.label,
      source: det,
      box: { ...det.box },
      lastSeenMs: nowMs,
      velocity: { x: 0, y: 0 },
      filters: { cx: new OneEuroFilter(), cy: new OneEuroFilter(), w: new OneEuroFilter(), h: new OneEuroFilter() },
    };
    this.smooth(entry, det.box, nowMs, opts); // 필터의 첫 값 (출력 = 입력)
    return entry;
  }

  private observe(entry: Entry, det: Detection, nowMs: number, opts: TrackerOptions): void {
    const dt = nowMs - entry.lastSeenMs;
    if (dt > 0) {
      const a = centre(entry.source.box);
      const b = centre(det.box);
      entry.velocity = { x: (entry.velocity.x + (b.x - a.x) / dt) / 2, y: (entry.velocity.y + (b.y - a.y) / dt) / 2 };
    }
    entry.source = det;
    entry.lastSeenMs = nowMs;
    this.smooth(entry, det.box, nowMs, opts);
  }

  // 스무딩을 꺼도 필터는 계속 돌린다 (다시 켰을 때 이어지게). 내보내는 박스는 검출 박스를 항상 덮는다.
  private smooth(entry: Entry, raw: Rect, nowMs: number, opts: TrackerOptions): void {
    const t = nowMs / 1000;
    const c = centre(raw);
    const f = entry.filters;
    const params: OneEuroParams = { minCutoff: opts.minCutoff, beta: opts.beta, dCutoff: opts.dCutoff ?? 1 };
    f.cx.params = f.cy.params = f.w.params = f.h.params = params;
    const cx = f.cx.filter(c.x, t);
    const cy = f.cy.filter(c.y, t);
    const w = f.w.filter(raw.width, t);
    const h = f.h.filter(raw.height, t);
    const smoothed = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
    entry.box = opts.smoothing ? unionRect(raw, smoothed) : { ...raw };
  }
}
