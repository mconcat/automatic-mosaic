import { describe, expect, it } from 'vitest';
import type { Detection, Rect, Track } from '../../src/core/types';
import { IouTracker, type TrackerOptions } from '../../src/tracking/iou-tracker';

const OPTS: TrackerOptions = { holdMs: 400, iouThreshold: 0.3, smoothing: true, minCutoff: 1, beta: 0.01 };
const DT = 125; // 8fps

const face = (x: number, y: number, w = 100, h = w, label = 'face'): Detection => ({ label, score: 0.9, box: { x, y, width: w, height: h } });

function noise(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

function contains(outer: Rect, inner: Rect, eps = 1e-9): boolean {
  return (
    outer.x <= inner.x + eps &&
    outer.y <= inner.y + eps &&
    outer.x + outer.width >= inner.x + inner.width - eps &&
    outer.y + outer.height >= inner.y + inner.height - eps
  );
}

const cx = (t: Track): number => t.box.x + t.box.width / 2;

function std(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

describe('IouTracker', () => {
  it('새 검출은 첫 프레임부터 바로 트랙이 된다 (id는 1부터)', () => {
    const t = new IouTracker();
    const tracks = t.update([face(100, 100)], 0, OPTS);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: 1, label: 'face', lastSeenMs: 0, box: { x: 100, y: 100, width: 100, height: 100 } });
  });

  it('움직이는 얼굴은 같은 id를 유지한다', () => {
    const t = new IouTracker();
    for (let i = 0; i < 40; i++) {
      const tracks = t.update([face(50 + 10 * i, 100)], i * DT, OPTS);
      expect(tracks.map((x) => x.id)).toEqual([1]);
    }
  });

  it('두 얼굴은 서로 다른 id이고, 검출 순서가 바뀌어도 각자 id를 유지한다', () => {
    const t = new IouTracker();
    const ids: Record<string, Set<number>> = { left: new Set(), right: new Set() };
    for (let i = 0; i < 20; i++) {
      const left = face(50 + i, 100);
      const right = face(400 - i, 120);
      const tracks = t.update(i % 2 ? [right, left] : [left, right], i * DT, OPTS);
      expect(tracks).toHaveLength(2);
      for (const tr of tracks) ids[tr.source === left ? 'left' : 'right']!.add(tr.id);
    }
    expect([...ids.left!]).toEqual([1]);
    expect([...ids.right!]).toEqual([2]);
  });

  it('IoU가 임계보다 작으면 다른 대상으로 보고 새 id를 준다 (이전 트랙은 유지 시간 동안 남는다)', () => {
    const t = new IouTracker();
    t.update([face(0, 0)], 0, OPTS);
    const tracks = t.update([face(300, 300)], DT, OPTS);
    expect(tracks.map((x) => [x.id, x.lastSeenMs])).toEqual([
      [1, 0],
      [2, DT],
    ]);
  });

  it('라벨이 다르면 매칭하지 않는다', () => {
    const t = new IouTracker();
    t.update([face(0, 0)], 0, OPTS);
    const tracks = t.update([face(0, 0, 100, 100, 'hand')], DT, { ...OPTS, holdMs: 0 });
    expect(tracks.map((x) => [x.id, x.label])).toEqual([[2, 'hand']]);
  });

  it('빠르게 움직여 겹침이 작아도 최근 속도로 예측한 위치와 매칭한다 (한 프레임 빠져도 이어진다)', () => {
    const t = new IouTracker();
    // 점점 빨라져 프레임당 60px (폭 100): 그대로 비교하면 IoU 0.25 < 0.3
    const speeds = [10, 20, 30, 40, 50, 60, 60, 60, 60];
    const ids = new Set<number>();
    let x = 0;
    let i = 0;
    for (const v of speeds) {
      x += v;
      for (const tr of t.update([face(x, 100)], ++i * DT, OPTS)) ids.add(tr.id);
    }
    expect(t.update([], ++i * DT, OPTS).map((tr) => tr.id)).toEqual([1]); // 검출이 한 프레임 빠짐 (유지)
    const after = t.update([face(x + 120, 100)], ++i * DT, OPTS);
    expect([...ids]).toEqual([1]);
    expect(after.map((tr) => tr.id)).toEqual([1]);
  });

  it('예측 없이 겹침만 보면 이어지지 않을 거리다 (위 테스트가 예측을 확인하는지)', () => {
    const t = new IouTracker();
    t.update([face(0, 100)], 0, OPTS);
    expect(t.update([face(60, 100)], DT, { ...OPTS, holdMs: 0 }).map((tr) => tr.id)).toEqual([2]);
  });

  it('검출이 끊기면 마지막 박스를 유지 시간 동안 그대로 두고, 지나면 없앤다', () => {
    const t = new IouTracker();
    t.update([face(100, 100)], 0, OPTS);
    const last = t.update([face(102, 100)], 1000, OPTS)[0]!;
    for (const ms of [1125, 1250, 1375, 1400]) {
      const tracks = t.update([], ms, OPTS);
      expect(tracks.map((x) => x.id), `${ms}ms`).toEqual([1]);
      expect(tracks[0]!.box).toEqual(last.box);
      expect(tracks[0]!.lastSeenMs).toBe(1000);
    }
    expect(t.update([], 1401, OPTS)).toEqual([]);
  });

  it('유지 시간 0이면 검출이 끊긴 프레임에 바로 없앤다', () => {
    const t = new IouTracker();
    t.update([face(100, 100)], 0, { ...OPTS, holdMs: 0 });
    expect(t.update([], DT, { ...OPTS, holdMs: 0 })).toEqual([]);
  });

  it('스무딩한 박스는 그 프레임의 검출 박스를 항상 덮는다 (떨림·움직임·크기 변화)', () => {
    const rand = noise(3);
    const t = new IouTracker();
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const phase = (2 * Math.PI * i) / 32;
      const det = face(200 + 150 * Math.sin(phase) + 3 * rand(), 120 + 3 * rand(), 110 + 20 * Math.sin(phase / 2) + 2 * rand());
      const tracks = t.update([det], i * DT, OPTS);
      expect(tracks).toHaveLength(1);
      expect(contains(tracks[0]!.box, det.box), `frame ${i}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(200);
  });

  it('제자리에서 떨리는 검출: 스무딩을 켜면 박스 중심의 프레임 간 변화가 줄고, 끄면 검출 박스 그대로다', () => {
    const jitter = (smoothing: boolean): { std: number; same: boolean } => {
      const rand = noise(11);
      const t = new IouTracker();
      const deltas: number[] = [];
      let prev: number | null = null;
      let same = true;
      for (let i = 0; i < 120; i++) {
        const det = face(200 + 2 * rand(), 120 + 2 * rand(), 110 + 2 * rand());
        const tr = t.update([det], i * DT, { ...OPTS, smoothing })[0]!;
        same &&= JSON.stringify(tr.box) === JSON.stringify(det.box);
        if (prev !== null && i > 10) deltas.push(cx(tr) - prev);
        prev = cx(tr);
      }
      return { std: std(deltas), same };
    };
    const on = jitter(true);
    const off = jitter(false);
    expect(off.same).toBe(true);
    expect(on.same).toBe(false);
    expect(on.std).toBeLessThan(off.std * 0.8);
  });

  it('돌려준 트랙은 나중 갱신에 바뀌지 않는다 (지난 프레임을 다시 그릴 때 그대로)', () => {
    const t = new IouTracker();
    const first = t.update([face(100, 100)], 0, OPTS);
    const snapshot = JSON.stringify(first);
    t.update([face(140, 100)], DT, OPTS);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it('reset 뒤에는 트랙이 없고 id가 1부터 다시 시작한다', () => {
    const t = new IouTracker();
    t.update([face(0, 0), face(300, 0)], 0, OPTS);
    t.reset();
    expect(t.update([], DT, OPTS)).toEqual([]);
    expect(t.update([face(500, 300)], 2 * DT, OPTS).map((x) => x.id)).toEqual([1]);
  });
});
