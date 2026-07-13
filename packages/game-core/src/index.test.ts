import { describe, expect, it } from 'vitest';
import { normalizeDirection } from './index';

describe('normalizeDirection', () => {
  it('벡터를 단위 길이로 정규화한다', () => {
    const n = normalizeDirection({ x: 3, y: 4 });
    expect(n).not.toBeNull();
    expect(Math.hypot(n!.x, n!.y)).toBeCloseTo(1);
  });

  it('NaN/Infinity/영벡터는 거부한다', () => {
    expect(normalizeDirection({ x: NaN, y: 0 })).toBeNull();
    expect(normalizeDirection({ x: Infinity, y: 1 })).toBeNull();
    expect(normalizeDirection({ x: 0, y: 0 })).toBeNull();
  });
});
