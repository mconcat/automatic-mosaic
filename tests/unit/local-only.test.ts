import { describe, expect, it, vi } from 'vitest';
import { blockedRequests, installLocalOnlyFetch, isAllowedUrl } from '../../src/core/local-only';

const ORIGIN = 'http://localhost:5317';

describe('isAllowedUrl', () => {
  it('같은 출처, 공식 모델·WASM 저장소, data:/blob:은 허용한다', () => {
    expect(isAllowedUrl('/assets/index.js', ORIGIN)).toBe(true);
    expect(isAllowedUrl('https://storage.googleapis.com/mediapipe-models/face_detector/x.tflite', ORIGIN)).toBe(true);
    expect(isAllowedUrl('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm/vision_wasm_internal.wasm', ORIGIN)).toBe(true);
    expect(isAllowedUrl('https://huggingface.co/Xenova/owlvit-base-patch32/resolve/main/config.json', ORIGIN)).toBe(true);
    expect(isAllowedUrl('data:,x', ORIGIN)).toBe(true);
    expect(isAllowedUrl('blob:http://localhost:5317/abc', ORIGIN)).toBe(true);
  });

  it('MediaPipe 텔레메트리는 막는다', () => {
    expect(isAllowedUrl('https://odml.pa.googleapis.com/v1/log', ORIGIN)).toBe(false);
  });
});

describe('installLocalOnlyFetch', () => {
  it('텔레메트리 요청은 보내지 않고 거부하며 기록한다. 모델 요청은 그대로 보낸다', async () => {
    const native = vi.fn(async () => new Response('ok'));
    const win = { fetch: native, location: { origin: ORIGIN } } as unknown as Window;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    installLocalOnlyFetch(win);

    await expect(win.fetch('https://odml.pa.googleapis.com/v1/log', { method: 'POST' })).rejects.toThrow(TypeError);
    expect(native).not.toHaveBeenCalled();
    expect(blockedRequests).toContain('https://odml.pa.googleapis.com/v1/log');

    await expect(win.fetch(new Request('https://odml.pa.googleapis.com/v1/log'))).rejects.toThrow(TypeError);
    expect(native).not.toHaveBeenCalled();

    const model = 'https://storage.googleapis.com/mediapipe-models/a.tflite';
    const res = await win.fetch(model);
    expect(await res.text()).toBe('ok');
    expect(native).toHaveBeenCalledWith(model, undefined);
    info.mockRestore();
  });

  it('Worker처럼 다른 scope에도 걸고, 막은 URL을 콜백으로 넘긴다', async () => {
    const native = vi.fn(async () => new Response('ok'));
    const scope = { fetch: native as unknown as typeof fetch, location: { origin: ORIGIN } };
    const blocked: string[] = [];
    installLocalOnlyFetch(scope, (url) => blocked.push(url));
    await expect(scope.fetch('https://odml.pa.googleapis.com/v1/log')).rejects.toThrow(TypeError);
    expect(blocked).toEqual(['https://odml.pa.googleapis.com/v1/log']);
    await scope.fetch('/wasm/vision_wasm_module_internal.wasm');
    expect(native).toHaveBeenCalledTimes(1);
  });
});

describe('다운로드 진행률', () => {
  it('모델 파일 응답을 복제해 받은 바이트를 알리고, 원래 응답은 그대로 읽힌다', async () => {
    const body = new Uint8Array(1000).fill(7);
    const native = vi.fn(async () => new Response(body, { headers: { 'content-length': '1000' } }));
    const scope = { fetch: native as unknown as typeof fetch, location: { origin: ORIGIN } };
    const seen: { loaded: number; total: number; done: boolean }[] = [];
    installLocalOnlyFetch(scope, () => {}, (p) => seen.push(p));
    const res = await scope.fetch('https://storage.googleapis.com/mediapipe-models/x/model.tflite');
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    await vi.waitFor(() => expect(seen.at(-1)?.done).toBe(true));
    expect(seen[0]).toMatchObject({ loaded: 0, total: 1000, done: false });
    expect(seen.at(-1)).toMatchObject({ loaded: 1000, total: 1000 });
  });

  it('모델이 아닌 요청은 세지 않는다', async () => {
    const native = vi.fn(async () => new Response('{}', { headers: { 'content-length': '2' } }));
    const scope = { fetch: native as unknown as typeof fetch, location: { origin: ORIGIN } };
    const seen: unknown[] = [];
    installLocalOnlyFetch(scope, () => {}, (p) => seen.push(p));
    await (await scope.fetch('https://huggingface.co/x/resolve/main/config.json')).text();
    expect(seen).toEqual([]);
  });
});
