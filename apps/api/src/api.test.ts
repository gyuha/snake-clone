import { beforeEach, describe, expect, it } from 'vitest';
import { buildApi, type BuiltApi } from './server';
import { createToken } from './tokens';
import { validateNickname } from './nickname';

/** fastify.inject 기반 통합 테스트 (loop.md C7) — 실제 라우팅/검증 경로를 통과한다 */
let api: BuiltApi;

beforeEach(() => {
  api = buildApi({ secret: 'test-secret', internalSecret: 'test-internal' });
});

async function createGuest() {
  const res = await api.app.inject({ method: 'POST', url: '/v1/auth/guest' });
  expect(res.statusCode).toBe(201);
  return res.json() as { userId: string; accessToken: string; refreshToken: string };
}

describe('게스트 인증 (FR-AUTH-01)', () => {
  it('게스트 생성 시 userId와 access/refresh 토큰을 발급한다', async () => {
    const guest = await createGuest();
    expect(guest.userId).toBeTruthy();
    expect(guest.accessToken).toContain('.');
    expect(guest.refreshToken).toContain('.');
  });

  it('refresh로 새 access를 발급하고, 만료/위조 refresh는 401', async () => {
    const guest = await createGuest();
    const ok = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: guest.refreshToken },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { accessToken: string }).accessToken).toBeTruthy();

    const expired = createToken(
      { sub: guest.userId, type: 'refresh', exp: Date.now() - 1000 },
      'test-secret',
    );
    const r1 = await api.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: expired } });
    expect(r1.statusCode).toBe(401);

    const forged = createToken(
      { sub: guest.userId, type: 'refresh', exp: Date.now() + 10000 },
      'wrong-secret',
    );
    const r2 = await api.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: forged } });
    expect(r2.statusCode).toBe(401);

    // access 토큰을 refresh 자리에 넣어도 거부 (타입 바인딩)
    const r3 = await api.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: guest.accessToken } });
    expect(r3.statusCode).toBe(401);
  });
});

describe('프로필/닉네임 (FR-PROF-01)', () => {
  it('유효 닉네임은 저장되고 GET /v1/me에 반영된다', async () => {
    const guest = await createGuest();
    const auth = { authorization: `Bearer ${guest.accessToken}` };
    const patch = await api.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: auth,
      payload: { nickname: '뱀장어_9' },
    });
    expect(patch.statusCode).toBe(200);
    const me = await api.app.inject({ method: 'GET', url: '/v1/me', headers: auth });
    expect((me.json() as { nickname: string }).nickname).toBe('뱀장어_9');
  });

  it('길이/문자셋/금칙어 위반은 400', async () => {
    const guest = await createGuest();
    const auth = { authorization: `Bearer ${guest.accessToken}` };
    for (const bad of ['a', 'x'.repeat(17), 'hi there', 'adMin짱', '<script>']) {
      const res = await api.app.inject({ method: 'PATCH', url: '/v1/me', headers: auth, payload: { nickname: bad } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('토큰 없이 /v1/me 접근은 401', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('결과 저장 멱등성 (PRD §12.2 / RISK-07)', () => {
  it('동일 matchId+userId 중복 저장은 1건만 유지되고, 통계·리더보드에 반영된다', async () => {
    const guest = await createGuest();
    const payload = {
      matchId: 'm-1',
      userId: guest.userId,
      score: 500,
      rank: 2,
      survivalMs: 60_000,
      kills: 3,
      reason: 'body',
    };
    const headers = { 'x-internal-secret': 'test-internal' };
    const first = await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers, payload });
    expect(first.statusCode).toBe(201);
    const dup = await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers, payload });
    expect(dup.statusCode).toBe(200);
    expect((dup.json() as { saved: boolean }).saved).toBe(false);

    const me = await api.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${guest.accessToken}` },
    });
    const stats = (me.json() as { stats: { games: number; bestScore: number } }).stats;
    expect(stats.games).toBe(1); // 중복이 2가 되지 않음
    expect(stats.bestScore).toBe(500);
  });

  it('내부 시크릿 없는 결과 저장은 403', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/internal/results',
      payload: { matchId: 'm', userId: 'u', score: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('리더보드', () => {
  it('점수 내림차순 정렬과 selfRank를 반환한다', async () => {
    const a = await createGuest();
    const b = await createGuest();
    const headers = { 'x-internal-secret': 'test-internal' };
    await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers, payload: { matchId: 'm1', userId: a.userId, score: 100 } });
    await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers, payload: { matchId: 'm2', userId: b.userId, score: 300 } });

    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/leaderboards/all',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const body = res.json() as { entries: { userId: string; score: number }[]; selfRank: number };
    expect(body.entries[0]!.userId).toBe(b.userId);
    expect(body.entries[1]!.userId).toBe(a.userId);
    expect(body.selfRank).toBe(2);
  });
});

describe('validateNickname 단위', () => {
  it('공백 trim 후 저장 형태를 돌려준다', () => {
    const r = validateNickname('  Snake_1 ');
    expect(r).toEqual({ ok: true, normalized: 'Snake_1' });
  });
});
