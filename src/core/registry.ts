import type { Detector, Effect, ExecutionLocation, ParamSpec } from './types';

// id로 찾는 등록부. UI 선택지는 list() 순서 그대로 나온다.
export class Registry<T extends { readonly id: string; readonly label: string }> {
  private readonly items = new Map<string, T>();

  register(item: T): this {
    if (this.items.has(item.id)) throw new Error(`Duplicate id: ${item.id}`);
    this.items.set(item.id, item);
    return this;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  list(): T[] {
    return [...this.items.values()];
  }
}

// Detector는 상태(모델, WASM 인스턴스)를 가지므로 팩토리로 등록하고, 고를 때마다 새로 만든다.
// 실행 위치(worker/main)에 맞는 구현(DetectorProxy 또는 직접)을 고르는 것도 팩토리 몫이다.
export interface DetectorEntry {
  readonly id: string;
  readonly label: string;
  /** 이 검출기만 쓰는 파라미터 (이펙트의 params처럼 스토어·패널에 들어가고, 값은 DetectorOptions.extra로 넘어간다) */
  readonly params?: ParamSpec[];
  /** Worker에서 돌릴 수 없는 검출기 (실행 위치와 상관없이 메인 스레드) */
  readonly mainOnly?: boolean;
  create(location: ExecutionLocation): Detector;
}

export type DetectorRegistry = Registry<DetectorEntry>;
export type EffectRegistry = Registry<Effect>;
