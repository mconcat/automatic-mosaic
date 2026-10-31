import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNetworkError, LoadRetry } from '../../src/core/load-retry';

describe('isNetworkError', () => {
  it('브라우저별 네트워크 실패 문구를 알아본다', () => {
    expect(isNetworkError('Failed to load detector: Load failed')).toBe(true); // Safari / iOS
    expect(isNetworkError('Failed to load detector: Failed to fetch')).toBe(true); // Chrome
    expect(isNetworkError('NetworkError when attempting to fetch resource.')).toBe(true); // Firefox
    expect(isNetworkError('WebGL2 is not available.')).toBe(false);
    expect(isNetworkError('Failed to load detector: Failed to fetch model: https://x/m.tflite (404)')).toBe(false); // HTTP 오류는 다시 받아도 같다
    expect(isNetworkError(null)).toBe(false);
  });
});

describe('LoadRetry', () => {
  let state = 'loading';
  let error: string | null = null;
  let visible = true;
  let retry: ReturnType<typeof vi.fn<() => void>>;
  let r: LoadRetry;

  beforeEach(() => {
    vi.useFakeTimers();
    state = 'loading';
    error = null;
    visible = true;
    retry = vi.fn<() => void>();
    r = new LoadRetry({ state: () => state, error: () => error, visible: () => visible, retry, delays: [100, 200] });
  });
  afterEach(() => vi.useRealTimers());

  const fail = (msg = 'Failed to load detector: Load failed'): void => {
    state = 'error';
    error = msg;
    r.onState();
  };

  it('보이는 동안 네트워크로 실패하면 정해진 간격으로 다시 시도하고, 횟수를 넘으면 멈춘다', () => {
    fail();
    vi.advanceTimersByTime(99);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    fail();
    vi.advanceTimersByTime(200);
    expect(retry).toHaveBeenCalledTimes(2);
    fail();
    vi.advanceTimersByTime(10_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('네트워크가 아닌 오류는 다시 시도하지 않는다', () => {
    fail('Failed to load detector: WebGL2 is not available.');
    vi.advanceTimersByTime(10_000);
    r.onVisible();
    expect(retry).not.toHaveBeenCalled();
  });

  it('백그라운드에서 끊기면 기다렸다가 탭이 보일 때 바로 다시 시도한다', () => {
    visible = false;
    fail();
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
    visible = true;
    r.onVisible();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('준비되면 횟수를 되돌린다', () => {
    fail();
    vi.advanceTimersByTime(100);
    state = 'ready';
    error = null;
    r.onState();
    fail();
    vi.advanceTimersByTime(100);
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
