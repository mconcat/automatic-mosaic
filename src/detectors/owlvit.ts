import { withReloadHint } from '../core/chunk-error';
import { noteProgress } from '../core/local-only';
import type { Delegate, Detection, Detector, DetectorOptions, ParamSpec } from '../core/types';

// 텍스트로 가릴 대상을 정하는 검출기: OWL-ViT (Transformers.js, 오픈 어휘 객체 검출).
// 입력한 영어 대상 이름들(쉼표로 구분)로 매 프레임 박스를 찾는다. 라벨은 그 대상 이름이다.
// 모델은 Hugging Face 공식 저장소, ONNX Runtime WASM은 Transformers.js 기본값(jsDelivr)에서 실행 중에 받고 브라우저 캐시에 둔다.
// 메인 스레드 전용, WebGPU 필요.

const MODEL = 'Xenova/owlvit-base-patch32';

export const OWL_PARAMS: ParamSpec[] = [
  { key: 'prompt', label: 'Hide (targets)', type: 'text', default: 'human face, cell phone' },
  { key: 'owlThreshold', label: 'Text threshold', type: 'number', min: 0.02, max: 0.5, step: 0.01, default: 0.1 },
];

/** OWL-ViT의 입력 형식: 쉼표로 구분한 영어 대상 이름 */
export function owlTargets(prompt: string): string[] {
  return [...new Set(prompt.split(',').map((x) => x.trim()).filter(Boolean))];
}

type Transformers = typeof import('@huggingface/transformers');
interface Box { xmin: number; ymin: number; xmax: number; ymax: number }
type ZeroShot = ((image: unknown, labels: string[], opts: { threshold: number }) => Promise<{ label: string; score: number; box: Box }[]>) & {
  dispose?: () => Promise<void>;
};

// Transformers.js 4.x(onnxruntime-web 1.31 dev)는 OWL-ViT 세션을 만들지 못해 3.8.1(onnxruntime-web 1.22)을 쓴다.
let lib: Promise<Transformers> | null = null;
function loadLib(): Promise<Transformers> {
  lib ??= import('@huggingface/transformers')
    .then((t) => {
      t.env.allowRemoteModels = true;
      t.env.allowLocalModels = false;
      return t;
    })
    .catch((err: unknown) => {
      lib = null;
      throw withReloadHint(err);
    });
  return lib;
}

interface ProgressInfo {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

function onProgress(p: ProgressInfo): void {
  if (!p.file || (p.status !== 'progress' && p.status !== 'done')) return;
  const url = `${MODEL}/${p.file}`;
  const total = p.total ?? 0;
  noteProgress({ url, loaded: p.status === 'done' ? total : (p.loaded ?? 0), total, done: p.status === 'done' });
}

function option<T>(o: DetectorOptions, key: string, fallback: T): T {
  const v = o.extra?.[key];
  return typeof v === typeof fallback ? (v as T) : fallback;
}

export class OwlVitDetector implements Detector {
  readonly id: string;
  labels: string[] = [];
  activeDelegate: Delegate | null = null;
  fallbackReason: string | null = null;
  onError: ((err: Error) => void) | null = null;
  private opts: DetectorOptions = { delegate: 'GPU', minConfidence: 0.5, nmsThreshold: 0.3 };
  private pipe: ZeroShot | null = null;
  private t: Transformers | null = null;
  private disposed = false;
  private canvas: OffscreenCanvas | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async init(opts: DetectorOptions): Promise<void> {
    this.setOptions(opts);
    if (!('gpu' in navigator)) throw new Error('Text targets (OWL-ViT) need WebGPU, which this browser does not provide.');
    const t = await loadLib();
    // 진행률은 Transformers.js 콜백으로 받는다 (300MB 모델 응답을 복제하면 iOS에서 메모리가 넘쳐 탭이 죽는다).
    // q4f16(127MB)은 onnxruntime-web 1.22 WebGPU에서 세션 생성에 실패해 fp16을 쓴다.
    const pipe = (await t.pipeline('zero-shot-object-detection', MODEL, {
      device: 'webgpu',
      dtype: 'fp16',
      progress_callback: onProgress,
    })) as unknown as ZeroShot;
    if (this.disposed) {
      void pipe.dispose?.();
      throw new Error('Detector was closed.');
    }
    this.pipe = pipe;
    this.t = t;
    this.activeDelegate = 'GPU';
  }

  async updateOptions(opts: Partial<DetectorOptions>): Promise<void> {
    this.setOptions({ ...this.opts, ...opts, extra: { ...this.opts.extra, ...opts.extra } });
  }

  async detect(frame: ImageBitmap, _timestampMs: number): Promise<Detection[]> {
    const { width, height } = frame;
    try {
      if (!this.pipe || !this.t) throw new Error('Detector is not ready.');
      const targets = this.labels;
      if (targets.length === 0) return [];
      this.canvas ??= new OffscreenCanvas(width, height);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not create an OffscreenCanvas 2D context.');
      ctx.drawImage(frame, 0, 0);
      const image = new this.t.RawImage(ctx.getImageData(0, 0, width, height).data, width, height, 4);
      const results = await this.pipe(image, targets, { threshold: option(this.opts, 'owlThreshold', 0.1) });
      return results.map((r) => ({
        label: r.label,
        score: r.score,
        box: { x: r.box.xmin, y: r.box.ymin, width: r.box.xmax - r.box.xmin, height: r.box.ymax - r.box.ymin },
      }));
    } finally {
      frame.close();
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.pipe?.dispose?.();
    this.pipe = null;
  }

  private setOptions(opts: DetectorOptions): void {
    this.opts = opts;
    this.labels = owlTargets(option(opts, 'prompt', ''));
  }
}
