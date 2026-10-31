import { describe, expect, it } from 'vitest';
import { withReloadHint } from '../../src/core/chunk-error';

describe('withReloadHint', () => {
  it('동적 import 실패(Safari·Chrome·Firefox 문구)는 새로고침 안내로 바꾼다', () => {
    for (const msg of ['Importing a module script failed.', 'Failed to fetch dynamically imported module: https://x/assets/a.js', 'error loading dynamically imported module']) {
      const out = withReloadHint(new TypeError(msg)) as Error;
      expect(out.message).toContain('reload the page');
      expect(out.message).toContain(msg);
    }
  });

  it('다른 오류는 그대로 둔다', () => {
    const err = new Error('WebGL2 is not available.');
    expect(withReloadHint(err)).toBe(err);
  });
});
