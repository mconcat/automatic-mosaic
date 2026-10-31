import type { ParamStore } from '../core/params';

// 자주 쓰는 조작만 모은 간단 조작줄. 나머지는 패널(Advanced settings)에 그대로 있다.
// - 모드 토글: Face mosaic(얼굴 검출기) ↔ Text targets(OWL-ViT, Hide 입력으로 대상 지정)
// - 모자이크 굵기, 이펙트, 모양, 박스 표시
// 모든 값은 ParamStore로 패널과 서로 맞춰진다.

interface Options {
  textModel: string; // 텍스트 대상 검출기 id
  defaultFaceModel: string;
  hideForm: HTMLFormElement; // 텍스트 모드에서만 보인다
  hideInput: HTMLInputElement;
}

type Choice = { label: string; value: string };

export class QuickControls {
  private readonly store: ParamStore;
  private readonly opts: Options;
  private lastFaceModel: string;
  private readonly sync: (() => void)[] = [];

  constructor(root: HTMLElement, store: ParamStore, opts: Options) {
    this.store = store;
    this.opts = opts;
    const model = String(store.get('model'));
    this.lastFaceModel = model === opts.textModel ? opts.defaultFaceModel : model;

    const mode = this.segmented('Mode', [
      { label: 'Face mosaic', value: 'face' },
      { label: 'Text targets', value: 'text' },
    ], () => (this.isText() ? 'text' : 'face'), (v) => this.setMode(v === 'text'));
    mode.classList.add('quick-mode');
    const top = document.createElement('div');
    top.className = 'quick-row';
    top.append(mode, opts.hideForm);
    root.append(top);

    const row = document.createElement('div');
    row.className = 'quick-row';
    row.append(
      this.slider('Mosaic blocks', 'blockCells', 4, 32),
      this.segmented('Effect', [
        { label: 'Pixelate', value: 'pixelate' },
        { label: 'Solid', value: 'solid' },
      ], () => String(store.get('effect')), (v) => store.set('effect', v)),
      this.segmented('Shape', [
        { label: 'Rectangle', value: 'rect' },
        { label: 'Ellipse', value: 'ellipse' },
      ], () => String(store.get('shape')), (v) => store.set('shape', v)),
      this.checkbox('Show boxes', 'debug'),
    );
    root.append(row);

    opts.hideInput.value = String(store.get('prompt') ?? '');
    opts.hideForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      store.set('prompt', opts.hideInput.value.trim());
      this.setMode(true);
    });

    store.subscribe((key) => {
      if (key === 'model' && !this.isText()) this.lastFaceModel = String(store.get('model'));
      if (key === 'prompt' && document.activeElement !== opts.hideInput) opts.hideInput.value = String(store.get('prompt') ?? '');
      this.refresh();
    });
    this.refresh();
  }

  private isText(): boolean {
    return this.store.get('model') === this.opts.textModel;
  }

  private setMode(text: boolean): void {
    this.store.set('model', text ? this.opts.textModel : this.lastFaceModel);
  }

  private refresh(): void {
    for (const fn of this.sync) fn();
    this.opts.hideForm.hidden = !this.isText();
  }

  private group(label: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'quick-group';
    const name = document.createElement('span');
    name.className = 'quick-label';
    name.textContent = label;
    el.append(name);
    return el;
  }

  private segmented(label: string, choices: Choice[], get: () => string, set: (v: string) => void): HTMLDivElement {
    const el = this.group(label);
    const seg = document.createElement('div');
    seg.className = 'segmented';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const buttons = choices.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.addEventListener('click', () => set(c.value));
      seg.append(b);
      return { b, value: c.value };
    });
    this.sync.push(() => {
      const current = get();
      for (const { b, value } of buttons) b.setAttribute('aria-pressed', String(value === current));
    });
    el.append(seg);
    return el;
  }

  private slider(label: string, key: string, min: number, max: number): HTMLLabelElement {
    const el = document.createElement('label');
    el.className = 'quick-group';
    const name = document.createElement('span');
    name.className = 'quick-label';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    const value = document.createElement('output');
    value.className = 'quick-value';
    input.addEventListener('input', () => {
      this.store.set('blockMode', 'relative'); // 칸 수 슬라이더는 상대 모드에서만 효과가 있다
      this.store.set(key, Number(input.value));
    });
    this.sync.push(() => {
      const v = String(this.store.get(key));
      if (document.activeElement !== input) input.value = v;
      value.textContent = v;
    });
    el.append(name, input, value);
    return el;
  }

  private checkbox(label: string, key: string): HTMLLabelElement {
    const el = document.createElement('label');
    el.className = 'quick-group quick-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => this.store.set(key, input.checked));
    this.sync.push(() => (input.checked = this.store.get(key) === true));
    const name = document.createElement('span');
    name.textContent = label;
    el.append(input, name);
    return el;
  }
}
