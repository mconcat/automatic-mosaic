// One Euro Filter (Casiez et al. 2012): 느리게 움직일 때는 떨림을 강하게 줄이고, 빠를수록 차단 주파수를 올려 지연을 줄인다.
// 시각은 초 단위. minCutoff(Hz): 정지 상태의 차단 주파수, beta: 속도(단위/초)에 따라 차단 주파수를 올리는 정도,
// dCutoff(Hz): 속도 추정에 쓰는 저역 통과 필터의 차단 주파수.

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: Readonly<OneEuroParams> = { minCutoff: 1, beta: 0.01, dCutoff: 1 };

// 간격 dt(초)에서 차단 주파수 cutoff(Hz)인 1차 저역 통과 필터의 계수
export function smoothingFactor(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  params: OneEuroParams; // 실행 중에 바꿔도 된다 (다음 값부터 적용)
  private x: number | null = null; // 마지막 출력
  private dx = 0; // 걸러 낸 속도 (단위/초)
  private t = 0;

  constructor(params: OneEuroParams = DEFAULT_ONE_EURO) {
    this.params = { ...params };
  }

  /** 마지막 출력. 아직 값을 받지 않았으면 null */
  get value(): number | null {
    return this.x;
  }

  filter(value: number, tSec: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tSec;
      return value;
    }
    const dt = tSec - this.t;
    if (!(dt > 0)) return this.x; // 같은 시각이거나 거꾸로 온 값은 무시한다
    this.t = tSec;
    const { minCutoff, beta, dCutoff } = this.params;
    this.dx += smoothingFactor(dCutoff, dt) * ((value - this.x) / dt - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}
