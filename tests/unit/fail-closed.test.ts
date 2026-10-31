import { describe, expect, it } from 'vitest';
import { failReason, STALE_MS, staleLimitMs } from '../../src/core/fail-closed';
import { stageNoteText } from '../../src/ui/status-text';

const base = { detectorState: 'ready' as const, nowMs: 5000, lastOkMs: 4900, sinceMs: 0, limitMs: STALE_MS };

describe('failReason', () => {
  it('검출기가 준비되지 않았거나 오류면 믿지 않는다', () => {
    expect(failReason({ ...base, detectorState: 'loading' })).toBe('loading');
    expect(failReason({ ...base, detectorState: 'idle' })).toBe('loading');
    expect(failReason({ ...base, detectorState: 'error' })).toBe('error');
  });

  it('마지막 결과가 제한 시간 안이면 믿는다 (경계 포함)', () => {
    expect(failReason(base)).toBeNull();
    expect(failReason({ ...base, lastOkMs: 4000 })).toBeNull();
    expect(failReason({ ...base, lastOkMs: 3999 })).toBe('stalled');
  });

  it('결과가 아직 없으면 기다린 시간에 따라 waiting → stalled', () => {
    expect(failReason({ ...base, lastOkMs: null, sinceMs: 4500 })).toBe('waiting');
    expect(failReason({ ...base, lastOkMs: null, sinceMs: 3000 })).toBe('stalled');
    expect(failReason({ ...base, lastOkMs: null, sinceMs: null })).toBe('waiting');
  });

  it('오래된 결과라도 방금 준비된 검출기면 제한 시간만큼 첫 결과를 기다린다', () => {
    expect(failReason({ ...base, lastOkMs: 1000, sinceMs: 4800 })).toBe('waiting');
  });
});

describe('staleLimitMs', () => {
  it('기본 1초, 목표 FPS가 낮으면 프레임 간격 2개', () => {
    expect(staleLimitMs(8)).toBe(1000);
    expect(staleLimitMs(15)).toBe(1000);
    expect(staleLimitMs(2)).toBe(1000);
    expect(staleLimitMs(1)).toBe(2000);
  });
});

describe('stageNoteText', () => {
  const run = { running: true, displayMode: 'async' as const, hasFrame: true };

  it('실행 중이 아니거나 결과를 믿을 수 있으면 안내가 없다', () => {
    expect(stageNoteText({ ...run, running: false, failReason: 'error' })).toBeNull();
    expect(stageNoteText({ ...run, failReason: null })).toBeNull();
  });

  it('비동기: 이유마다 화면 전체를 가린다고 알린다', () => {
    for (const reason of ['loading', 'error', 'waiting', 'stalled'] as const) {
      expect(stageNoteText({ ...run, failReason: reason })).toMatch(/covering the whole frame\.$/);
    }
    expect(stageNoteText({ ...run, failReason: 'stalled' })).toBe('Detection is late — covering the whole frame.');
  });

  it('동기: 마지막 분석 프레임(없으면 빈 화면)을 보여 준다고 알린다', () => {
    const sync = { ...run, displayMode: 'sync' as const };
    expect(stageNoteText({ ...sync, failReason: 'error' })).toBe('Detector error — the view is not updated.');
    expect(stageNoteText({ ...sync, failReason: 'loading', hasFrame: false })).toBe('Loading detector…');
    expect(stageNoteText({ ...sync, failReason: 'loading' })).toContain('last analysed frame');
    expect(stageNoteText({ ...sync, failReason: 'waiting', hasFrame: false })).toBe('Analysing the first frame…');
    expect(stageNoteText({ ...sync, failReason: 'waiting' })).toBeNull();
    expect(stageNoteText({ ...sync, failReason: 'stalled' })).toContain('Detection is late — the view is not updated');
  });
});
