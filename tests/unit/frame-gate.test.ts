import { describe, expect, it } from 'vitest';
import { FrameGate } from '../../src/core/frame-gate';

// 카메라 fps로 들어오는 프레임 중 몇 개를 받는지 센다 (바쁜 경우 없음).
function accepted(gate: FrameGate, cameraFps: number, seconds: number, jitterMs = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < cameraFps * seconds; i++) {
    const t = (i * 1000) / cameraFps + (i % 2 ? jitterMs : -jitterMs);
    if (gate.due(t)) {
      gate.take(t);
      out.push(t);
    }
  }
  return out;
}

describe('FrameGate', () => {
  it('카메라 15fps, 목표 8fps → 평균 약 8fps', () => {
    const n = accepted(new FrameGate(8), 15, 10).length;
    expect(n / 10).toBeGreaterThan(7.4);
    expect(n / 10).toBeLessThanOrEqual(8.1);
  });

  it('목표 10fps → 약 10fps (프레임 3개 중 2개)', () => {
    const n = accepted(new FrameGate(10), 15, 10).length;
    expect(n / 10).toBeCloseTo(10, 0);
  });

  it('목표가 카메라와 같거나 크면 흔들림이 있어도 모든 프레임을 받는다', () => {
    expect(accepted(new FrameGate(15), 15, 4, 3).length).toBe(60);
    expect(accepted(new FrameGate(15), 15, 4).length).toBe(60);
    expect(accepted(new FrameGate(30), 15, 4).length).toBe(60);
  });

  it('목표 1fps → 약 1초 간격', () => {
    const times = accepted(new FrameGate(1), 15, 10);
    expect(times.length).toBeGreaterThanOrEqual(10);
    expect(times.length).toBeLessThanOrEqual(11);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(750);
    expect((times.at(-1)! - times[1]!) / (times.length - 2)).toBeCloseTo(1000, -1);
  });

  it('take()를 부르지 않으면 차례를 쓰지 않는다 (바빠서 버린 프레임)', () => {
    const gate = new FrameGate(8);
    gate.take(0);
    expect(gate.due(140)).toBe(true);
    expect(gate.due(150)).toBe(true); // 버렸으니 다음 프레임도 여전히 차례
    gate.take(150);
    expect(gate.due(200)).toBe(false);
  });

  it('많이 밀렸으면 지금부터 다시 센다 (몰아서 받지 않는다)', () => {
    const gate = new FrameGate(10);
    gate.take(0);
    gate.take(1000); // 1초 동안 바빴다
    expect(gate.due(1010)).toBe(false);
    expect(gate.due(1080)).toBe(true);
  });

  it('setFps·reset은 바로 새로 시작한다', () => {
    const gate = new FrameGate(1);
    gate.take(0);
    expect(gate.due(100)).toBe(false);
    gate.setFps(15);
    expect(gate.due(100)).toBe(true);
    gate.take(100);
    gate.reset();
    expect(gate.due(101)).toBe(true);
  });
});
