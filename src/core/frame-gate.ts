// 목표 FPS 상한. 프레임 타임스탬프로 "다음 차례" 시각을 누적해, 카메라가 목표보다 빠르면 평균이 목표 FPS에 맞게 고른다.
// due()로 차례인지 보고, 실제로 처리를 시작할 때만 take()로 차례를 쓴다 (바빠서 버린 프레임은 차례를 쓰지 않는다).
export class FrameGate {
  private next = -Infinity;
  private fps: number;

  constructor(fps: number) {
    this.fps = fps;
  }

  private get interval(): number {
    return 1000 / this.fps;
  }

  setFps(fps: number): void {
    if (fps === this.fps) return;
    this.fps = fps;
    this.next = -Infinity; // 새 간격으로 바로 시작
  }

  // 카메라 타임스탬프 흔들림 때문에 차례보다 조금(간격의 1/4) 일찍 온 프레임도 받는다.
  due(timestampMs: number): boolean {
    return timestampMs >= this.next - this.interval / 4;
  }

  take(timestampMs: number): void {
    // 이전 차례에 간격을 더해 평균을 맞춘다. 많이 밀렸으면 지금부터 다시 센다.
    const next = this.next + this.interval;
    this.next = next > timestampMs ? next : timestampMs + this.interval;
  }

  reset(): void {
    this.next = -Infinity;
  }
}
