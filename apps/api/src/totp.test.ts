import { describe, expect, it } from 'vitest';
import { totpCode, verifyTotp } from './totp';

describe('TOTP admin MFA', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = 1_700_000_000_000;

  it('같은 시간창 코드를 검증하고 이전/다음 30초 창만 허용한다', () => {
    const code = totpCode(secret, now)!;
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 60_000), now)).toBe(false);
  });

  it('잘못된 형식 또는 비밀은 거부한다', () => {
    expect(verifyTotp(secret, '000000', now)).toBe(false);
    expect(verifyTotp('bad', '123456', now)).toBe(false);
  });
});
