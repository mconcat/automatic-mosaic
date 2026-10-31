// 메인 스레드 롱태스크(50ms 이상 막힌 작업) 수. PerformanceObserver 'longtask'로 센다.

export interface LongTask {
  startMs: number; // performance.now() 기준
  durationMs: number;
}

export class LongTaskMonitor {
  count = 0;
  maxMs = 0;
  readonly recent: LongTask[] = []; // 최근 것부터 keep개까지 (오래된 것이 앞)

  private readonly keep: number;

  constructor(keep = 50) {
    this.keep = keep;
  }

  /** 관찰을 시작한다. 지원하지 않으면 false (세지 않는다). */
  observe(): boolean {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.add(e.startTime, e.duration);
      }).observe({ type: 'longtask', buffered: true });
      return true;
    } catch {
      return false;
    }
  }

  add(startMs: number, durationMs: number): void {
    this.count++;
    this.maxMs = Math.max(this.maxMs, durationMs);
    this.recent.push({ startMs, durationMs });
    if (this.recent.length > this.keep) this.recent.shift();
  }
}
