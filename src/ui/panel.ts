import type { BindingApi } from '@tweakpane/core';
import { Pane, type BladeApi, type FolderApi, type ListInputBindingApi } from 'tweakpane';
import type { ParamStore, ParamValues } from '../core/params';
import type { ParamSpec } from '../core/types';
import type { CameraDevice } from '../sources/camera';

// Tweakpane 파라미터 패널. 값의 기준은 ParamStore이고, 패널은 사본(state)을 Tweakpane에 묶어 양쪽을 맞춘다.
// 모니터 값(monitors)은 호출부가 주기적으로 채우고 Tweakpane이 읽어 그래프로 그린다.

export interface Monitors {
  inferenceFps: number;
  renderFps: number;
  inferenceMs: number;
  detections: number;
  location: string;
  delegate: string;
  dropped: number;
  longTasks: number;
  workers: number;
}

/** 선택 파라미터(key)가 고른 항목만 쓰는 파라미터를 들고 오는 등록부 (모델 → 검출기 params, 이펙트 → 이펙트 params) */
export interface ParamOwner {
  key: string;
  items: readonly { id: string; params?: readonly ParamSpec[] }[];
}

// owner: 그 선택 파라미터의 항목들이 들고 온 파라미터를 폴더 끝에 붙인다 (고른 항목의 것만 보인다)
const LAYOUT: { title: string; keys: string[]; owner?: string }[] = [
  { title: 'Input', keys: ['deviceId', 'mirror'] },
  { title: 'Detection', keys: ['model', 'location', 'delegate', 'minConfidence', 'nmsThreshold', 'inferenceSize', 'targetFps'], owner: 'model' },
  { title: 'Tracking', keys: ['holdMs', 'smoothing', 'minCutoff', 'beta', 'iouThreshold'] },
  { title: 'Mosaic', keys: ['effect', 'shape', 'padding'], owner: 'effect' },
  { title: 'Display', keys: ['displayMode', 'debug'] },
];

const DEFAULT_CAMERA = [{ text: 'Default camera', value: '' }];

// Tweakpane 라벨은 <label>이 아니라서 입력 요소에 접근 가능한 이름을 붙인다.
function nameControl(api: BladeApi, label: string, id?: string): void {
  const control = api.element.querySelector<HTMLElement>('select, input');
  if (!control) return;
  control.setAttribute('aria-label', label);
  if (id) control.id = id;
}

export class ParamPanel {
  readonly monitors: Monitors = { inferenceFps: 0, renderFps: 0, inferenceMs: 0, detections: 0, location: '—', delegate: '—', dropped: 0, longTasks: 0, workers: 0 };

  private readonly pane: Pane;
  private readonly store: ParamStore;
  private readonly state: ParamValues;
  private readonly bindings = new Map<string, { api: BindingApi; spec: ParamSpec }>();
  private readonly owners: readonly ParamOwner[];
  private readonly camera: ListInputBindingApi<string>;

  constructor(container: HTMLElement, store: ParamStore, specs: readonly ParamSpec[], owners: readonly ParamOwner[]) {
    this.store = store;
    this.owners = owners;
    this.state = store.snapshot();
    this.pane = new Pane({ container, title: 'Advanced settings' });
    // 자주 쓰는 것은 간단 조작줄에 있으니 폴더는 접어 둔다. 자동화 브라우저(E2E)는 라벨로 조작하므로 펼친다.
    const expanded = navigator.webdriver === true;

    const byKey = new Map(specs.map((s) => [s.key, s]));
    const ownedKeys = (key?: string): string[] => [...new Set(owners.find((o) => o.key === key)?.items.flatMap((i) => (i.params ?? []).map((p) => p.key)) ?? [])];
    let camera: ListInputBindingApi<string> | null = null;
    for (const group of LAYOUT) {
      const folder = this.pane.addFolder({ title: group.title, expanded });
      const keys = [...group.keys, ...ownedKeys(group.owner)];
      for (const key of keys) {
        if (key === 'deviceId') {
          camera = folder.addBinding(this.state, 'deviceId', { label: 'Camera', options: DEFAULT_CAMERA }) as unknown as ListInputBindingApi<string>;
          camera.on('change', (ev) => this.commit('deviceId', ev.value));
          nameControl(camera, 'Camera', 'camera');
          continue;
        }
        const spec = byKey.get(key);
        if (spec) this.add(folder, spec);
      }
    }
    this.camera = camera!;
    this.addMonitors();
    this.updateVisibility();

    store.subscribe((key) => {
      Object.assign(this.state, { [key]: store.get(key) });
      if (key === 'deviceId') this.camera.refresh();
      else this.bindings.get(key)?.api.refresh();
      this.updateVisibility();
    });
  }

  /** 권한을 얻은 뒤 장치 목록으로 카메라 선택지를 바꾼다. 값은 호출부가 store로 맞춘다. */
  setDevices(devices: readonly CameraDevice[]): void {
    this.camera.options = devices.length ? devices.map((d) => ({ text: d.label, value: d.deviceId })) : DEFAULT_CAMERA;
  }

  setCameraDisabled(disabled: boolean): void {
    this.camera.disabled = disabled;
  }

  private add(folder: FolderApi, spec: ParamSpec): void {
    const key = spec.key;
    const params =
      spec.type === 'number'
        ? { label: spec.label, min: spec.min, max: spec.max, step: spec.step }
        : spec.type === 'select'
          ? { label: spec.label, options: spec.options.map((o) => ({ text: o.label, value: o.value })) }
          : { label: spec.label };
    const api = folder.addBinding(this.state, key, params);
    api.on('change', (ev) => {
      if (spec.applyOnRelease && !ev.last) return; // 드래그 중에는 반영하지 않는다
      this.commit(key, ev.value);
    });
    nameControl(api, spec.label, key === 'mirror' ? 'mirror' : undefined);
    this.bindings.set(key, { api, spec });
  }

  // 패널에서 바꾼 값을 store에 넣는다. 받아들이지 않으면 패널을 store 값으로 되돌린다.
  private commit(key: string, value: unknown): void {
    if (this.store.set(key, value) && this.store.get(key) === value) return;
    Object.assign(this.state, { [key]: this.store.get(key) });
    if (key === 'deviceId') this.camera.refresh();
    else this.bindings.get(key)?.api.refresh();
  }

  // 항목이 들고 온 파라미터는 그 항목을 골랐을 때만, visibleIf가 있으면 조건이 맞을 때만 보인다.
  private updateVisibility(): void {
    for (const [key, { api, spec }] of this.bindings) {
      let visible = true;
      for (const owner of this.owners) {
        const owns = (i: ParamOwner['items'][number]): boolean => (i.params ?? []).some((p) => p.key === key);
        if (!owner.items.some(owns)) continue;
        const selected = owner.items.find((i) => i.id === this.state[owner.key]);
        visible &&= selected !== undefined && owns(selected);
      }
      if (visible && spec.visibleIf) visible = this.state[spec.visibleIf.key] === spec.visibleIf.equals;
      api.hidden = !visible;
    }
  }

  private addMonitors(): void {
    const folder = this.pane.addFolder({ title: 'Monitor', expanded: navigator.webdriver === true });
    const m = this.monitors;
    const number = (key: 'inferenceFps' | 'renderFps' | 'inferenceMs' | 'detections', label: string, max: number, digits: number): void => {
      folder.addBinding(m, key, { readonly: true, label, format: (v: number) => v.toFixed(digits), interval: 250 });
      folder.addBinding(m, key, { readonly: true, label: '', view: 'graph', min: 0, max, interval: 250 });
    };
    const count = (key: 'dropped' | 'longTasks' | 'workers', label: string): void => {
      folder.addBinding(m, key, { readonly: true, label, format: (v: number) => v.toFixed(0), interval: 250 });
    };
    number('inferenceFps', 'Inference FPS', 20, 1);
    number('renderFps', 'Render FPS', 40, 1);
    number('inferenceMs', 'Inference time (ms)', 50, 1);
    number('detections', 'Detections', 5, 0);
    folder.addBinding(m, 'location', { readonly: true, label: 'Run on', interval: 250 });
    folder.addBinding(m, 'delegate', { readonly: true, label: 'Delegate', interval: 250 });
    count('dropped', 'Dropped frames');
    count('longTasks', 'Long tasks (>50ms)');
    count('workers', 'Workers');
  }
}
