export interface StatsData {
  renderFps: number;
  videoWidth: number;
  videoHeight: number;
}

export function formatStats({ renderFps, videoWidth, videoHeight }: StatsData): string {
  const size = videoWidth > 0 ? `${videoWidth}×${videoHeight}` : '—';
  return `Render ${renderFps.toFixed(1)} FPS · Video ${size}`;
}

export class StatsView {
  private readonly el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  update(data: StatsData): void {
    const text = formatStats(data);
    if (this.el.textContent !== text) this.el.textContent = text;
  }
}
