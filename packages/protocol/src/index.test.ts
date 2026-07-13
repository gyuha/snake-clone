import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, validateInputMessage } from './index';

describe('protocol', () => {
  it('프로토콜 버전이 정의되어 있다', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('validateInputMessage (PRD §14.2)', () => {
  const valid = { seq: 1, dirX: 1, dirY: 0, boost: false };

  it('유효한 입력을 통과시킨다', () => {
    expect(validateInputMessage(valid)).toEqual(valid);
  });

  it('NaN/Infinity 방향을 거부한다', () => {
    expect(validateInputMessage({ ...valid, dirX: NaN })).toBeNull();
    expect(validateInputMessage({ ...valid, dirY: Infinity })).toBeNull();
  });

  it('비정수/음수/초과 seq를 거부한다', () => {
    expect(validateInputMessage({ ...valid, seq: 1.5 })).toBeNull();
    expect(validateInputMessage({ ...valid, seq: -1 })).toBeNull();
    expect(validateInputMessage({ ...valid, seq: 2 ** 33 })).toBeNull();
  });

  it('boost가 boolean이 아니면 거부한다', () => {
    expect(validateInputMessage({ ...valid, boost: 1 })).toBeNull();
  });

  it('객체가 아닌 페이로드를 거부한다', () => {
    expect(validateInputMessage(null)).toBeNull();
    expect(validateInputMessage('input')).toBeNull();
  });

  it('위조 필드(x/y/score/length)는 결과에 복사되지 않는다 (§11.5 좌표 불신)', () => {
    const forged = { ...valid, x: 9999, y: 9999, score: 100000, length: 500 };
    const out = validateInputMessage(forged);
    expect(out).toEqual(valid);
    expect(out).not.toHaveProperty('x');
    expect(out).not.toHaveProperty('score');
  });
});
