// 모델 다운로드가 네트워크 문제로 끊겼을 때 검출기를 다시 불러온다.
// iOS(iPad·iPhone)는 탭이 백그라운드로 가면 진행 중인 요청을 끊는다 ("Load failed").
// - 탭이 다시 보이면 바로 다시 시도한다.
// - 보이는 동안 끊긴 것이면 delays 간격으로 몇 번 다시 시도한다. 준비되면 횟수를 되돌린다.

// 브라우저의 fetch 네트워크 실패 문구로 끝날 때만 (Safari "Load failed", Chrome "Failed to fetch", Firefox "NetworkError…").
// "Failed to fetch model: … (404)" 같은 HTTP 오류는 다시 받아도 같으므로 넣지 않는다.
const NETWORK_ERROR = /(load failed|failed to fetch|networkerror when attempting to fetch resource|the network connection was lost|network error)\.?$/i;

export function isNetworkError(message: string | null): boolean {
  return message !== null && NETWORK_ERROR.test(message);
}

export interface LoadRetryOptions {
  state: () => string; // 'idle' | 'loading' | 'ready' | 'error'
  error: () => string | null;
  visible: () => boolean;
  retry: () => void;
  delays?: number[]; // ms
}

export class LoadRetry {
  private readonly opts: Required<LoadRetryOptions>;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LoadRetryOptions) {
    this.opts = { delays: [2000, 5000, 10000], ...opts };
  }

  /** 검출기 상태가 바뀔 때마다 부른다. */
  onState(): void {
    const state = this.opts.state();
    if (state === 'ready') {
      this.attempts = 0;
      this.cancel();
      return;
    }
    if (state !== 'error' || !isNetworkError(this.opts.error())) return;
    if (!this.opts.visible()) return; // 돌아왔을 때 onVisible이 다시 시도한다
    if (this.timer !== null || this.attempts >= this.opts.delays.length) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.attempts++;
      this.opts.retry();
    }, this.opts.delays[this.attempts]);
  }

  /** 탭이 다시 보일 때 부른다. */
  onVisible(): void {
    if (this.opts.state() !== 'error' || !isNetworkError(this.opts.error())) return;
    this.cancel();
    this.attempts = 0; // 백그라운드에서 끊긴 것은 사용자 잘못이 아니다. 다시 처음부터 센다
    this.opts.retry();
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
