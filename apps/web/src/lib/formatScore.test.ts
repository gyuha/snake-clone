import { describe, expect, it } from 'vitest';
import { formatScore } from './formatScore';

describe('formatScore', () => {
  it('천 단위 구분과 내림을 적용한다', () => {
    expect(formatScore(1234567.9)).toBe('1,234,567');
  });

  it('음수는 0으로 처리한다', () => {
    expect(formatScore(-5)).toBe('0');
  });
});
