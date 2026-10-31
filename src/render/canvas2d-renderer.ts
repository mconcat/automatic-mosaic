import { fitContain } from '../core/geometry';
import type { DrawOptions, Rect, Renderer, Size } from '../core/types';

// 프레임을 캔버스 크기에 비율을 지켜 맞춰 그린다. 캔버스 버퍼는 기기 픽셀 단위.
// 미러링은 여기서만 한다 (검출 좌표는 항상 원본 기준).
export class Canvas2DRenderer implements Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private view: Rect = { x: 0, y: 0, width: 0, height: 0 };
  frameId: number | null = null;
  background = '#000';
  onResize: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Cannot create a Canvas 2D context.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) this.resize(entry);
    });
    try {
      this.observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      // Safari(아이패드 포함)는 device-pixel-content-box를 지원하지 않는다. resize()가 contentRect × DPR로 계산한다.
      this.observer.observe(canvas);
    }
  }

  /** 마지막으로 그린 프레임이 캔버스 버퍼 안에서 차지하는 영역 (기기 픽셀) */
  get viewRect(): Rect {
    return { ...this.view };
  }

  // paint는 프레임을 그린 직후, 프레임 좌표 → 캔버스 좌표 변환이 걸린 상태로 불린다 (이펙트, 오버레이).
  // paint가 던지면 가리지 않은 프레임이 남지 않게 캔버스를 비운다.
  draw(image: CanvasImageSource, size: Size, { mirror, frameId }: DrawOptions, paint?: (ctx: CanvasRenderingContext2D) => void): void {
    const { canvas, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.frameId = frameId;
    const fit = fitContain(size, canvas);
    this.view = fit;
    if (fit.width === 0) return;
    if (mirror) ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.transform(fit.width / size.width, 0, 0, fit.height / size.height, fit.x, fit.y);
    ctx.drawImage(image, 0, 0, size.width, size.height);
    if (paint) {
      ctx.save();
      try {
        paint(ctx);
      } catch (err) {
        ctx.restore();
        this.clear();
        throw err;
      }
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = this.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.view = { x: 0, y: 0, width: 0, height: 0 };
    this.frameId = null;
  }

  dispose(): void {
    this.observer.disconnect();
  }

  private resize(entry: ResizeObserverEntry): void {
    const box = entry.devicePixelContentBoxSize?.[0];
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box ? box.inlineSize : entry.contentRect.width * dpr));
    const height = Math.max(1, Math.round(box ? box.blockSize : entry.contentRect.height * dpr));
    if (this.canvas.width === width && this.canvas.height === height) return;
    // 크기를 바꾸면 내용이 지워진다. 배경으로 채운 뒤 호출부가 마지막 프레임을 다시 그리게 한다.
    this.canvas.width = width;
    this.canvas.height = height;
    this.clear();
    this.onResize?.();
  }
}
