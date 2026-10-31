import { downloads } from '../core/local-only';

// 모델을 받거나 초기화하는 동안 보이는 진행 표시줄 (고장으로 오해하지 않게).
// 다운로드 중이면 받은 양/전체와 퍼센트, 다 받은 뒤 검출기를 만드는 동안은 움직이는 막대를 보여 준다.

const MB = 1024 * 1024;

function css(el: HTMLElement, style: Partial<CSSStyleDeclaration>): void {
  Object.assign(el.style, style);
}

export class LoadingBar {
  private readonly root: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly isLoading: () => boolean;
  private timer: number | null = null;

  /** host 안 위쪽에 겹쳐 띄운다. isLoading: 검출기를 불러오는 중인지 */
  constructor(host: HTMLElement, isLoading: () => boolean) {
    this.isLoading = isLoading;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    this.root = document.createElement('div');
    this.root.setAttribute('role', 'progressbar');
    this.root.id = 'loading-bar';
    css(this.root, {
      position: 'absolute', left: '12px', right: '12px', top: '12px', zIndex: '5', display: 'none',
      padding: '10px 12px', borderRadius: '8px', background: 'rgba(17, 24, 39, 0.88)', color: '#fff',
      font: '13px/1.4 system-ui, sans-serif', pointerEvents: 'none',
    });
    this.label = document.createElement('div');
    const track = document.createElement('div');
    css(track, { marginTop: '6px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.2)', overflow: 'hidden' });
    this.fill = document.createElement('div');
    css(this.fill, { height: '100%', width: '0%', borderRadius: '3px', background: '#3b82f6', transition: 'width 0.2s' });
    track.append(this.fill);
    this.root.append(this.label, track);
    host.append(this.root);
    if (!document.getElementById('loading-bar-style')) {
      const style = document.createElement('style');
      style.id = 'loading-bar-style';
      style.textContent = '@keyframes loading-bar-slide{0%{margin-left:-35%}100%{margin-left:100%}}';
      document.head.append(style);
    }
  }

  start(): void {
    this.timer ??= window.setInterval(() => this.update(), 200);
    this.update();
  }

  private update(): void {
    const items = [...downloads.values()];
    const active = items.some((d) => !d.done);
    if (!active && !this.isLoading()) {
      downloads.clear(); // 한 묶음이 끝났다. 다음 다운로드부터 다시 센다.
      this.root.style.display = 'none';
      this.root.removeAttribute('aria-valuenow');
      return;
    }
    this.root.style.display = 'block';
    const loaded = items.reduce((n, d) => n + d.loaded, 0);
    const total = items.reduce((n, d) => n + Math.max(d.total, d.loaded), 0);
    const known = items.length > 0 && items.every((d) => d.total > 0 || d.done);
    if (active && known && total > 0) {
      const pct = Math.min(100, Math.floor((loaded / total) * 100));
      this.label.textContent = `Downloading model files… ${pct}% (${(loaded / MB).toFixed(1)} / ${(total / MB).toFixed(1)} MB)`;
      css(this.fill, { width: `${pct}%`, animation: 'none', marginLeft: '0' });
      this.root.setAttribute('aria-valuenow', String(pct));
    } else {
      this.label.textContent = active
        ? `Downloading model files… ${(loaded / MB).toFixed(1)} MB`
        : 'Loading model… (first run downloads the model; later runs use the browser cache)';
      css(this.fill, { width: '35%', animation: 'loading-bar-slide 1.2s ease-in-out infinite' });
      this.root.removeAttribute('aria-valuenow');
    }
  }
}
