import { describe, expect, it } from 'vitest';
import { mapToSource } from '../../src/core/detections';
import { defaultRules, matchRule } from '../../src/core/rules';
import type { Detection, Track } from '../../src/core/types';

const face = (x: number, y: number, w: number, h: number, extra: Partial<Detection> = {}): Detection => ({
  label: 'face',
  score: 0.9,
  box: { x, y, width: w, height: h },
  ...extra,
});

describe('mapToSource', () => {
  it('추론 입력 좌표를 원본 프레임 좌표로 되돌린다 (박스와 키포인트)', () => {
    const [d] = mapToSource([face(10, 20, 30, 40, { keypoints: [{ x: 16, y: 12 }] })], { width: 320, height: 240 }, { width: 1280, height: 960 });
    expect(d!.box).toEqual({ x: 40, y: 80, width: 120, height: 160 });
    expect(d!.keypoints).toEqual([{ x: 64, y: 48 }]);
    expect(d!.score).toBe(0.9);
  });

  it('같은 크기면 그대로', () => {
    const src = [face(1, 2, 3, 4)];
    expect(mapToSource(src, { width: 640, height: 480 }, { width: 640, height: 480 })).toEqual(src);
  });

  it('프레임 밖으로 나간 박스도 자르지 않는다 (패딩한 뒤 렌더 단계에서 자른다). 크기 0 박스만 버린다', () => {
    const out = mapToSource(
      [face(-10, -10, 50, 50), face(300, 200, 100, 100), face(0, 0, 0, 0), face(10, 10, 20, Number.NaN)],
      { width: 160, height: 120 },
      { width: 320, height: 240 },
    );
    expect(out.map((d) => d.box)).toEqual([
      { x: -20, y: -20, width: 100, height: 100 },
      { x: 600, y: 400, width: 200, height: 200 },
    ]);
  });

  it('입력을 바꾸지 않는다', () => {
    const src = [face(10, 10, 10, 10)];
    mapToSource(src, { width: 10, height: 10 }, { width: 20, height: 20 });
    expect(src[0]!.box).toEqual({ x: 10, y: 10, width: 10, height: 10 });
  });
});

describe('rules', () => {
  const track = (id: number, label: string): Track => ({ id, label, box: { x: 0, y: 0, width: 1, height: 1 }, lastSeenMs: 0, source: face(0, 0, 1, 1) });

  it('기본 규칙: 모든 라벨 → 고른 이펙트 (자연어 검출기의 대상 라벨 포함)', () => {
    const rules = defaultRules('solid', { solidColor: '#000000' });
    expect(matchRule(rules, track(1, 'face'))).toEqual({ match: {}, effectId: 'solid', params: { solidColor: '#000000' } });
    expect(matchRule(rules, track(1, '휴대폰'))?.effectId).toBe('solid');
  });

  it('첫 번째로 맞는 규칙, trackIds 조건, 빈 조건', () => {
    const rules = [
      { match: { label: 'face', trackIds: [2] }, effectId: 'solid', params: {} },
      { match: { label: 'face' }, effectId: 'pixelate', params: {} },
      { match: {}, effectId: 'any', params: {} },
    ];
    expect(matchRule(rules, track(2, 'face'))?.effectId).toBe('solid');
    expect(matchRule(rules, track(1, 'face'))?.effectId).toBe('pixelate');
    expect(matchRule(rules, track(1, 'plate'))?.effectId).toBe('any');
  });
});
