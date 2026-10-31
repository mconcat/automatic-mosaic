import { describe, expect, it } from 'vitest';
import { DEFAULT_ONE_EURO, OneEuroFilter, smoothingFactor } from '../../src/tracking/one-euro';

// 결정적인 의사 난수 (-1..1)
function noise(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

function std(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

describe('smoothingFactor', () => {
  it('차단 주파수(Hz)와 간격(초)으로 계수를 정한다', () => {
    // tau = 1/(2π·1) ≈ 0.159초, dt = 0.125초 → 1 / (1 + 0.159/0.125) ≈ 0.4399
    expect(smoothingFactor(1, 0.125)).toBeCloseTo(0.4399, 4);
    // 간격이 길거나 차단 주파수가 높을수록 새 값을 더 따른다
    expect(smoothingFactor(1, 1)).toBeGreaterThan(smoothingFactor(1, 0.125));
    expect(smoothingFactor(5, 0.125)).toBeGreaterThan(smoothingFactor(1, 0.125));
  });
});

describe('OneEuroFilter', () => {
  it('첫 값은 그대로 내보내고, 같은 값이 계속 오면 그대로다', () => {
    const f = new OneEuroFilter();
    expect(f.value).toBeNull();
    expect(f.filter(100, 0)).toBe(100);
    for (let i = 1; i < 20; i++) expect(f.filter(100, i / 8)).toBe(100);
  });

  it('시각은 초 단위다 (밀리초를 넣으면 간격이 1000배라 거의 거르지 않는다)', () => {
    const sec = new OneEuroFilter();
    const ms = new OneEuroFilter();
    sec.filter(0, 0);
    ms.filter(0, 0);
    expect(sec.filter(10, 0.125)).toBeCloseTo(10 * smoothingFactor(1 + 0.01 * 80 * smoothingFactor(1, 0.125), 0.125), 6);
    expect(ms.filter(10, 125)).toBeGreaterThan(9.9);
  });

  it('제자리에서 떨리는 값의 떨림을 줄인다 (8fps, 기본 파라미터)', () => {
    const rand = noise(7);
    const f = new OneEuroFilter(DEFAULT_ONE_EURO);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 80; i++) {
      const v = 300 + 2 * rand();
      const y = f.filter(v, i / 8);
      if (i >= 10) {
        raw.push(v);
        out.push(y);
      }
    }
    expect(std(out)).toBeLessThan(std(raw) * 0.6);
  });

  it('beta가 크면 빠른 움직임을 덜 늦게 따라간다', () => {
    const lagAfterStep = (beta: number): number => {
      const f = new OneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 });
      for (let i = 0; i < 8; i++) f.filter(0, i / 8);
      let y = 0;
      for (let i = 8; i < 11; i++) y = f.filter(200, i / 8);
      return 200 - y;
    };
    expect(lagAfterStep(0.1)).toBeLessThan(lagAfterStep(0) / 2);
  });

  it('같은 시각이나 거꾸로 온 값은 무시하고, reset 뒤 첫 값은 그대로 내보낸다', () => {
    const f = new OneEuroFilter();
    f.filter(10, 1);
    expect(f.filter(50, 1)).toBe(10);
    expect(f.filter(50, 0.5)).toBe(10);
    f.reset();
    expect(f.filter(50, 2)).toBe(50);
  });

  it('파라미터는 실행 중에 바꿀 수 있다 (다음 값부터)', () => {
    const f = new OneEuroFilter({ minCutoff: 0.05, beta: 0, dCutoff: 1 });
    f.filter(0, 0);
    const slow = f.filter(100, 0.125);
    f.params = { minCutoff: 50, beta: 0, dCutoff: 1 };
    const fast = f.filter(100, 0.25);
    expect(slow).toBeLessThan(10);
    expect(fast).toBeGreaterThan(95);
  });
});
