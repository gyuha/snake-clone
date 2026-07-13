import { describe, expect, it } from 'vitest';
import { SKINS, skinOf } from './skins';

describe('SKINS (FR-COS-01)', () => {
  it('8종 이상이고 id가 인덱스와 일치하며 색이 서로 다르다', () => {
    expect(SKINS.length).toBeGreaterThanOrEqual(8);
    SKINS.forEach((s, i) => expect(s.id).toBe(i));
    expect(new Set(SKINS.map((s) => s.body)).size).toBe(SKINS.length);
  });

  it('범위 밖 id는 기본 스킨으로 폴백한다', () => {
    expect(skinOf(999)).toBe(SKINS[0]);
    expect(skinOf(-1)).toBe(SKINS[0]);
  });
});
