import { describe, expect, it } from 'vitest';
import { FpsCounter } from '../../src/core/fps-counter';
import { formatStats } from '../../src/ui/stats';
import { LongTaskMonitor } from '../../src/ui/long-tasks';

describe('FpsCounter', () => {
  it('일정 간격 프레임에서 FPS를 계산한다', () => {
    const fps = new FpsCounter(1000);
    for (let t = 0; t <= 1000; t += 100) fps.tick(t);
    expect(fps.value(1000)).toBeCloseTo(10);
  });

  it('창 밖의 오래된 프레임은 버린다', () => {
    const fps = new FpsCounter(1000);
    for (let t = 0; t < 2000; t += 50) fps.tick(t); // 20 fps
    for (let t = 2000; t <= 3000; t += 200) fps.tick(t); // 5 fps
    expect(fps.value(3000)).toBeCloseTo(5);
  });

  it('프레임이 끊기면 0이 된다', () => {
    const fps = new FpsCounter(1000);
    for (let t = 0; t <= 500; t += 100) fps.tick(t);
    expect(fps.value(600)).toBeGreaterThan(0);
    expect(fps.value(2000)).toBe(0);
  });

  it('긴 멈춤 뒤 프레임이 몰려 와도 튀지 않는다 (검출기 교체 직후 첫 추론이 느릴 때)', () => {
    const fps = new FpsCounter(1000);
    fps.tick(0);
    fps.tick(26);
    expect(fps.value(26)).toBeCloseTo(4);
    // 시작 직후 15fps 프레임 다섯 개(266ms)는 그대로 15
    const start = new FpsCounter(1000);
    for (let i = 0; i < 5; i++) start.tick((i * 1000) / 15);
    expect(start.value(267)).toBeCloseTo(15);
  });

  it('목표 FPS가 낮으면 창을 늘려 1fps도 0이 아니게 잰다 (멈추면 여전히 0)', () => {
    // 1초 창이면 1fps 프레임은 창에 하나뿐이라 대부분 0으로 읽힌다
    const plain = new FpsCounter(1000);
    const fitted = new FpsCounter(1000);
    fitted.setTargetFps(1);
    const readings: { plain: number; fitted: number }[] = [];
    for (let t = 0; t <= 10_000; t += 50) {
      if (t % 1000 === 0) {
        plain.tick(t);
        fitted.tick(t);
      }
      if (t >= 1000 && t % 250 === 0) readings.push({ plain: plain.value(t), fitted: fitted.value(t) });
    }
    expect(readings.filter((r) => r.plain === 0).length).toBeGreaterThan(readings.length / 2);
    for (const r of readings) expect(r.fitted).toBeCloseTo(1, 1);
    expect(fitted.value(10_000 + 2600)).toBe(0); // 2.5초 넘게 프레임이 없으면 0
    // 목표 FPS가 높으면 기본 창(1초) 그대로
    const fast = new FpsCounter(1000);
    fast.setTargetFps(15);
    for (let t = 0; t <= 2000; t += 100) fast.tick(t);
    expect(fast.value(2000)).toBeCloseTo(10);
    expect(fast.value(3100)).toBe(0);
  });

  it('프레임이 하나뿐이거나 reset 하면 0', () => {
    const fps = new FpsCounter();
    fps.tick(10);
    expect(fps.value(10)).toBe(0);
    fps.tick(20);
    fps.reset();
    expect(fps.value(20)).toBe(0);
  });
});

describe('formatStats', () => {
  it('FPS와 영상 크기를 보여 준다', () => {
    expect(formatStats({ renderFps: 14.96, videoWidth: 640, videoHeight: 480 })).toBe('Render 15.0 FPS · Video 640×480');
  });
  it('영상이 없으면 대시', () => {
    expect(formatStats({ renderFps: 0, videoWidth: 0, videoHeight: 0 })).toBe('Render 0.0 FPS · Video —');
  });
});

describe('LongTaskMonitor', () => {
  it('수·최대 시간을 세고 최근 것만 남긴다', () => {
    const m = new LongTaskMonitor(2);
    m.add(10, 60);
    m.add(200, 120);
    m.add(500, 55);
    expect(m.count).toBe(3);
    expect(m.maxMs).toBe(120);
    expect(m.recent).toEqual([
      { startMs: 200, durationMs: 120 },
      { startMs: 500, durationMs: 55 },
    ]);
  });
});
