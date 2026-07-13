import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureGuestSession, submitReport } from './session';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
  globalThis.fetch = originalFetch;
});

describe('ensureGuestSession', () => {
  it('동시 호출은 하나의 guest 생성 요청만 공유한다', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
      },
    });
    let guestRequests = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/auth/guest')) {
        guestRequests++;
        return new Response(JSON.stringify({ userId: 'u1', accessToken: 'access', refreshToken: 'refresh' }), { status: 201 });
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 202 }); // best-effort telemetry
    }) as typeof fetch;

    const sessions = await Promise.all(Array.from({ length: 5 }, () => ensureGuestSession('http://api.test')));

    expect(guestRequests).toBe(1);
    expect(sessions).toEqual(Array.from({ length: 5 }, () => ({ userId: 'u1', accessToken: 'access', refreshToken: 'refresh' })));
  });
});

describe('submitReport', () => {
  it('인증된 신고 사유와 상세를 안전 API로 전송한다', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ reportId: 'r1' }), { status: 201 })) as typeof fetch;
    await submitReport('http://api.test', 'access-token', { reason: 'cheating', detail: 'room player: serpent-7' });
    expect(globalThis.fetch).toHaveBeenCalledWith('http://api.test/v1/reports', expect.objectContaining({
      method: 'POST',
      headers: { authorization: 'Bearer access-token', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'cheating', detail: 'room player: serpent-7' }),
    }));
  });
});
