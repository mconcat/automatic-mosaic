import { describe, expect, it } from 'vitest';
import { CameraError, cameraConstraints, toCameraError } from '../../src/sources/camera';

function domError(name: string): DOMException {
  return new DOMException('test', name);
}

describe('toCameraError', () => {
  it.each([
    ['NotAllowedError', 'not-allowed'],
    ['SecurityError', 'not-allowed'],
    ['NotFoundError', 'not-found'],
    ['NotReadableError', 'not-readable'],
    ['AbortError', 'not-readable'],
    ['OverconstrainedError', 'overconstrained'],
  ])('%s → %s', (name, code) => {
    const err = toCameraError(domError(name));
    expect(err).toBeInstanceOf(CameraError);
    expect(err.code).toBe(code);
    expect(err.cause).toBeInstanceOf(DOMException);
  });

  it('OverconstrainedError처럼 name만 있는 객체도 처리한다', () => {
    expect(toCameraError({ name: 'OverconstrainedError', constraint: 'width' }).code).toBe('overconstrained');
  });

  it('deviceId가 걸린 OverconstrainedError는 장치 없음(not-found)이다', () => {
    expect(toCameraError({ name: 'OverconstrainedError', constraint: 'deviceId' }).code).toBe('not-found');
  });

  it('모르는 오류는 unknown', () => {
    expect(toCameraError(new Error('boom')).code).toBe('unknown');
    expect(toCameraError('boom').code).toBe('unknown');
    expect(toCameraError(null).code).toBe('unknown');
  });

  it('CameraError는 그대로 돌려준다', () => {
    const err = new CameraError('disconnected');
    expect(toCameraError(err)).toBe(err);
  });

  it('문구는 한국어다', () => {
    for (const code of ['not-allowed', 'not-found', 'not-readable', 'overconstrained', 'unsupported', 'disconnected', 'unknown'] as const) {
      expect(new CameraError(code).message).toMatch(/camera/i);
    }
    expect(toCameraError(domError('NotAllowedError')).message).toContain('permission');
    expect(toCameraError(domError('NotAllowedError')).message).toContain('macOS System Settings');
  });
});

describe('cameraConstraints', () => {
  it('기본 장치는 1280x720을 이상값으로 요청하고 오디오는 끈다', () => {
    expect(cameraConstraints()).toEqual({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  });
  it('장치를 고르면 deviceId를 exact로 건다', () => {
    const c = cameraConstraints('abc');
    expect(c.video).toMatchObject({ deviceId: { exact: 'abc' } });
  });
});
