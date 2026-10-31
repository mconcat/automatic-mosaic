import type { FailReason } from '../core/fail-closed';
import type { DisplayMode } from '../core/types';

// 화면 위 안내 (#stage-note): 검출 결과를 믿을 수 없을 때 원본 프레임 대신 무엇을 보여 주는지 알린다.

export interface StageNoteInput {
  running: boolean;
  displayMode: DisplayMode;
  failReason: FailReason | null;
  hasFrame: boolean; // 화면에 그려진 프레임이 있다 (snapshot().drawnFrameId !== null)
}

const ASYNC_TEXT: Record<FailReason, string> = {
  loading: 'Loading detector — covering the whole frame.',
  error: 'Detector error — covering the whole frame.',
  waiting: 'Waiting for the first detection — covering the whole frame.',
  stalled: 'Detection is late — covering the whole frame.',
};

export function stageNoteText({ running, displayMode, failReason, hasFrame }: StageNoteInput): string | null {
  if (!running || failReason === null) return null;
  if (displayMode === 'async') return ASYNC_TEXT[failReason];
  // 동기: 새 프레임을 그리지 않으므로 마지막 분석 프레임(없으면 빈 화면)이 남는다.
  const shown = hasFrame;
  switch (failReason) {
    case 'error':
      return 'Detector error — the view is not updated.';
    case 'loading':
      return shown ? 'Reloading detector — showing the last analysed frame.' : 'Loading detector…';
    case 'waiting':
      return shown ? null : 'Analysing the first frame…';
    case 'stalled':
      return shown ? 'Detection is late — the view is not updated; showing the last analysed frame.' : 'Detection is late…';
  }
}
