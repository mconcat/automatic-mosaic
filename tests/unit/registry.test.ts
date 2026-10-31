import { describe, expect, it } from 'vitest';
import { Registry } from '../../src/core/registry';
import { pixelate } from '../../src/effects/pixelate';
import { solid } from '../../src/effects/solid';
import type { Effect } from '../../src/core/types';

describe('Registry', () => {
  it('id로 찾고, 등록 순서대로 나열한다', () => {
    const r = new Registry<Effect>().register(pixelate).register(solid);
    expect(r.get('solid')).toBe(solid);
    expect(r.get('blur')).toBeUndefined();
    expect(r.list().map((e) => [e.id, e.label])).toEqual([
      ['pixelate', 'Pixelate'],
      ['solid', 'Solid fill'],
    ]);
  });

  it('같은 id를 두 번 등록하면 던진다', () => {
    const r = new Registry<{ id: string; label: string }>().register({ id: 'a', label: 'A' });
    expect(() => r.register({ id: 'a', label: 'B' })).toThrow(/a/);
  });
});
