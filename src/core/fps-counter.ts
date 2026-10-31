// 최근 windowMs 동안의 프레임 간격으로 FPS를 잰다. 프레임이 끊기면 0으로 떨어진다.
export class FpsCounter {
  private readonly baseWindowMs: number;
  private windowMs: number;
  private times: number[] = [];

  constructor(windowMs = 1000) {
    this.baseWindowMs = windowMs;
    this.windowMs = windowMs;
  }

  /** 목표 FPS가 낮아도 창에 프레임이 둘 이상 들어오게 창을 늘린다 (1fps → 2.5초). */
  setTargetFps(fps: number): void {
    this.windowMs = Math.max(this.baseWindowMs, 2500 / fps);
  }

  tick(nowMs: number): void {
    this.times.push(nowMs);
    this.prune(nowMs);
  }

  value(nowMs: number): number {
    this.prune(nowMs);
    const n = this.times.length;
    if (n < 2) return 0;
    // 멈춘 뒤 프레임 두 개가 몰려 와도 튀지 않게, 간격은 창의 1/4보다 짧게 보지 않는다.
    const span = Math.max(this.times[n - 1]! - this.times[0]!, this.windowMs / 4);
    return ((n - 1) * 1000) / span;
  }

  reset(): void {
    this.times = [];
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    let i = 0;
    while (i < this.times.length && this.times[i]! < cutoff) i++;
    if (i > 0) this.times.splice(0, i);
  }
}
