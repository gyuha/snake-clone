import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './rateLimit';

describe('rate limiter', () => {
  it('여러 제한 키를 함께 예약하고, 하나라도 초과하면 어느 키도 소모하지 않는다', async () => {
    let now = 1_000;
    const limiter = new InMemoryRateLimiter(() => now);
    const account = { scope: 'account', key: 'user-1', limit: 2, windowMs: 100 };
    const ip = { scope: 'ip', key: '127.0.0.1', limit: 1, windowMs: 100 };

    expect(await limiter.consume([account, ip])).toBe(true);
    expect(await limiter.consume([account, ip])).toBe(false);
    // account quota was not partially consumed by the failed multi-key attempt.
    expect(await limiter.consume([{ ...account, key: 'user-2' }])).toBe(true);

    now += 101;
    expect(await limiter.consume([account, ip])).toBe(true);
  });
});
