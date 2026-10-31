import type { DetectorState } from './pipeline';

// fail-closed 판정: 지금 검출 결과를 믿고 얼굴 영역만 가려도 되는지.
// 믿을 수 없으면 비동기 표시는 화면 전체를 가리고, 동기 표시는 새 프레임을 그리지 않는다 (원본 프레임을 내보내지 않는다).

export type FailReason =
  | 'loading' // 검출기를 불러오는 중
  | 'error' // 검출기 오류
  | 'waiting' // 시작(또는 검출기 준비) 뒤 첫 결과를 기다리는 중
  | 'stalled'; // 결과가 제한 시간보다 오래됨 (검출 지연·멈춤)

/** 검출 결과를 믿는 최대 나이 (ms) */
export const STALE_MS = 1000;

/** 목표 FPS가 낮으면 정상이어도 결과 간격이 길어서, 간격 2개보다는 짧게 잡지 않는다 (1fps → 2초). */
export function staleLimitMs(targetFps: number): number {
  return Math.max(STALE_MS, 2000 / targetFps);
}

export interface FailInput {
  detectorState: DetectorState;
  nowMs: number;
  /** 마지막으로 검출이 끝난 프레임의 시각 */
  lastOkMs: number | null;
  /** 결과를 기다리기 시작한 시각 (시작 뒤 첫 프레임, 검출기 준비 중 늦은 쪽) */
  sinceMs: number | null;
  limitMs: number;
}

/** 믿을 수 없는 이유. null이면 결과가 충분히 새롭다. 시각은 모두 performance.now() 기준. */
export function failReason({ detectorState, nowMs, lastOkMs, sinceMs, limitMs }: FailInput): FailReason | null {
  if (detectorState === 'error') return 'error';
  if (detectorState !== 'ready') return 'loading';
  if (lastOkMs !== null && nowMs - lastOkMs <= limitMs) return null;
  if (sinceMs === null || nowMs - sinceMs <= limitMs) return 'waiting';
  return 'stalled';
}
