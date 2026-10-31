import type { Rule, Track } from './types';

// 기본 규칙: 검출기가 낸 모든 라벨에 고른 이펙트를 쓴다 (얼굴 검출기는 'face'만, 자연어 검출기는 입력한 대상들).
export function defaultRules(effectId: string, params: Record<string, unknown> = {}): Rule[] {
  return [{ match: {}, effectId, params }];
}

// 트랙에 맞는 첫 규칙. 조건을 비워 두면 모두 맞는다.
export function matchRule(rules: readonly Rule[], track: Track): Rule | undefined {
  return rules.find(
    ({ match }) =>
      (match.label === undefined || match.label === track.label) &&
      (match.trackIds === undefined || match.trackIds.includes(track.id)),
  );
}
