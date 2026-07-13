import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApi, type BuiltApi } from './server';
import { createToken, verifyToken } from './tokens';
import { validateNickname } from './nickname';
import { createGameConfig, defaultGameConfig, type GameConfig } from '@serpent/config';
import { createInMemoryRepos, selectConfigRevision } from './repos';
import { totpCode } from './totp';
import { ApiMetrics } from './opsMetrics';

/** fastify.inject 기반 통합 테스트 (loop.md C7) — 실제 라우팅/검증 경로를 통과한다 */
let api: BuiltApi;

beforeEach(() => {
  api = buildApi({
    secret: 'test-secret', internalSecret: 'test-internal', adminSecret: 'test-admin',
    identityVerifier: { verify: async (provider, proof) => proof === `verified:${provider}` ? { subject: `${provider}:subject-1` } : null },
  });
});

async function createGuest() {
  const res = await api.app.inject({ method: 'POST', url: '/v1/auth/guest' });
  expect(res.statusCode).toBe(201);
  return res.json() as { userId: string; accessToken: string; refreshToken: string };
}

describe('OpenAPI contract (PRD §11.1)', () => {
  it('핵심 공개 REST 경로와 표준 오류 스키마를 제공한다', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const document = res.json() as { openapi: string; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths).toMatchObject({
      '/auth/guest': expect.any(Object), '/me': expect.any(Object), '/matches/tickets': expect.any(Object),
      '/leaderboards/{scope}': expect.any(Object), '/config/client': expect.any(Object),
    });
    expect(document.components.schemas.Error).toBeTruthy();
    expect(document.components.schemas).toMatchObject({
      Session: { required: expect.arrayContaining(['userId', 'accessToken']) },
      MatchTicket: { required: expect.arrayContaining(['ticketId', 'joinToken', 'expiresAt']) },
      Profile: { required: expect.arrayContaining(['userId', 'stats']) },
    });
  });
});

describe('데이터 보존 정책 (PRD §12.3)', () => {
  it('90일 원시 telemetry와 180일 미사용 guest를 감사 가능하게 정리한다', async () => {
    const timestamp = 200 * 24 * 60 * 60 * 1000;
    const repos = createInMemoryRepos();
    await repos.users.createGuest('stale-guest', 0);
    await repos.telemetry.saveMany([{ userId: 'stale-guest', name: 'play_click', clientTime: null, properties: {}, ip: '127.0.0.1', receivedAt: 0 }]);
    const retained = await repos.users.createGuest('active-guest', timestamp - 1);
    const api = buildApi({ repos, adminSecret: 'retention-secret', now: () => timestamp });
    const response = await api.app.inject({ method: 'POST', url: '/v1/admin/retention/run', headers: { 'x-admin-secret': 'retention-secret' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ telemetry: 1, guests: 1, telemetryRetentionDays: 90, guestRetentionDays: 180 });
    expect(await repos.users.get('stale-guest')).toBeNull();
    expect(await repos.users.get(retained.id)).not.toBeNull();
    expect((await repos.audit.recent(1))[0]).toMatchObject({ action: 'retention.purge' });
    await api.app.close();
  });
});

describe('관리자 웹 세션 (S-08 / FR-ADMIN-01)', () => {
  it('MFA 검증 후 짧은 HttpOnly 세션으로 관리자 API를 호출하고 로그아웃한다', async () => {
    const timestamp = 1_700_000_000_000;
    const secured = buildApi({ secret: 'admin-session-secret', adminSecret: 'admin-password', adminTotpSecret: 'JBSWY3DPEHPK3PXP', now: () => timestamp });
    const totp = totpCode('JBSWY3DPEHPK3PXP', timestamp);
    const denied = await secured.app.inject({ method: 'POST', url: '/v1/admin/session', payload: { secret: 'admin-password' } });
    expect(denied.statusCode).toBe(403);
    const login = await secured.app.inject({ method: 'POST', url: '/v1/admin/session', payload: { secret: 'admin-password', totp } });
    expect(login.statusCode).toBe(204);
    const cookie = login.headers['set-cookie'] as string;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const config = await secured.app.inject({ method: 'GET', url: '/v1/admin/config', headers: { cookie } });
    expect(config.statusCode).toBe(200);
    const logout = await secured.app.inject({ method: 'DELETE', url: '/v1/admin/session', headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    const expired = await secured.app.inject({ method: 'GET', url: '/v1/admin/config', headers: { cookie: logout.headers['set-cookie'] as string } });
    expect(expired.statusCode).toBe(403);
    await secured.app.close();
  });

  it('웹 세션은 게임 서버 메트릭을 서버 간 비밀로만 프록시한다', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { drained: String(url).includes('/rooms/') ? 1 : 2 } : { activeRooms: 2, humans: 11, bots: 0, rooms: [] }), { status: 200 }));
    const secured = buildApi({ secret: 'admin-session-secret', adminSecret: 'admin-password', opsEndpoint: 'http://game.internal/', opsSecret: 'ops-only', opsFetch: fetchMock });
    const login = await secured.app.inject({ method: 'POST', url: '/v1/admin/session', payload: { secret: 'admin-password' } });
    const metrics = await secured.app.inject({ method: 'GET', url: '/v1/admin/ops/metrics', headers: { cookie: login.headers['set-cookie'] as string } });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({ activeRooms: 2, humans: 11 });
    expect(fetchMock).toHaveBeenCalledWith('http://game.internal/ops/metrics', { headers: { 'x-admin-secret': 'ops-only' } });
    const drainAll = await secured.app.inject({ method: 'POST', url: '/v1/admin/ops/drain', headers: { cookie: login.headers['set-cookie'] as string } });
    expect(drainAll.statusCode).toBe(202);
    const drainRoom = await secured.app.inject({ method: 'POST', url: '/v1/admin/ops/rooms/room%2F1/drain', headers: { cookie: login.headers['set-cookie'] as string } });
    expect(drainRoom.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith('http://game.internal/ops/rooms/room%2F1/drain', { method: 'POST', headers: { 'x-admin-secret': 'ops-only' } });
    await secured.app.close();
  });

  it('RBAC는 viewer 읽기, operator 라이브 운영, owner 설정 변경을 분리한다', async () => {
    const secured = buildApi({ secret: 'rbac-secret', adminRoleSecrets: { viewer: 'viewer-secret', operator: 'operator-secret', owner: 'owner-secret' } });
    const viewerLogin = await secured.app.inject({ method: 'POST', url: '/v1/admin/session', payload: { secret: 'viewer-secret' } });
    expect(viewerLogin.statusCode).toBe(204);
    const viewer = { cookie: viewerLogin.headers['set-cookie'] as string };
    expect((await secured.app.inject({ method: 'GET', url: '/v1/admin/api/metrics', headers: viewer })).statusCode).toBe(200);
    expect((await secured.app.inject({ method: 'PUT', url: '/v1/admin/announcements/current', headers: viewer, payload: { message: 'denied' } })).statusCode).toBe(403);
    const operator = { 'x-admin-secret': 'operator-secret' };
    expect((await secured.app.inject({ method: 'PUT', url: '/v1/admin/announcements/current', headers: operator, payload: { message: 'allowed' } })).statusCode).toBe(201);
    expect((await secured.app.inject({ method: 'PUT', url: '/v1/admin/features', headers: operator, payload: { features: { accountLink: false, missions: true, eventHud: true, binaryProtocol: false } } })).statusCode).toBe(403);
    const owner = { 'x-admin-secret': 'owner-secret' };
    expect((await secured.app.inject({ method: 'PUT', url: '/v1/admin/features', headers: owner, payload: { features: { accountLink: false, missions: true, eventHud: true, binaryProtocol: false } } })).statusCode).toBe(200);
    await secured.app.close();
  });

  it('관리자 세션으로 최근 API 처리량·지연·5xx 메트릭을 확인한다', async () => {
    const metrics = new ApiMetrics();
    const secured = buildApi({ secret: 'metrics-secret', adminSecret: 'admin-password', apiMetrics: metrics });
    await secured.app.inject({ method: 'GET', url: '/health' });
    const response = await secured.app.inject({ method: 'GET', url: '/v1/admin/api/metrics', headers: { 'x-admin-secret': 'admin-password' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ windowMs: 60_000, requests: 1, errors5xx: 0, databasePool: null });
    await secured.app.close();
  });

  it('관리자는 원시 식별자 없이 기간별 퍼널과 완료 경기 집계를 확인한다', async () => {
    const timestamp = Date.UTC(2024, 0, 10, 12);
    const dayStart = Date.UTC(2024, 0, 10);
    const repos = createInMemoryRepos();
    await repos.users.createGuest('d1-user', dayStart - 12 * 3_600_000);
    await repos.users.createGuest('d7-user', dayStart - 7 * 24 * 3_600_000 + 12 * 3_600_000);
    await repos.telemetry.saveMany([
      { userId: 'd1-user', name: 'landing_view', clientTime: null, properties: {}, ip: 'test', receivedAt: timestamp },
      { userId: 'd7-user', name: 'landing_view', clientTime: null, properties: {}, ip: 'test', receivedAt: timestamp },
    ]);
    const secured = buildApi({ secret: 'product-secret', internalSecret: 'product-internal', adminSecret: 'admin-password', now: () => timestamp, repos });
    const guest = (await secured.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as { userId: string; accessToken: string };
    await secured.app.inject({ method: 'POST', url: '/v1/telemetry/batch', headers: { authorization: `Bearer ${guest.accessToken}` }, payload: { events: [{ name: 'play_click' }, { name: 'room_joined' }] } });
    await secured.app.inject({ method: 'POST', url: '/v1/internal/results', headers: { 'x-internal-secret': 'product-internal' }, payload: { matchId: 'product-match', userId: guest.userId, score: 12, survivalMs: 9_000 } });
    const response = await secured.app.inject({ method: 'GET', url: '/v1/admin/product/metrics?windowHours=24', headers: { 'x-admin-secret': 'admin-password' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ windowHours: 24, matches: { completed: 1, uniquePlayers: 1, averageSurvivalMs: 9_000 }, funnel: [{ name: 'landing_view', events: 2, uniqueUsers: 2 }, { name: 'play_click', events: 1, uniqueUsers: 1 }, { name: 'room_joined', events: 1, uniqueUsers: 1 }], retention: { d1: { cohort: 1, retained: 1, rate: 1 }, d7: { cohort: 1, retained: 1, rate: 1 } } });
    await secured.app.close();
  });

  it('관리자는 공개 feature flag를 원자적으로 조회·갱신하고 클라이언트 설정에 반영한다', async () => {
    const secured = buildApi({ secret: 'features-secret', adminSecret: 'admin-password' });
    const admin = { 'x-admin-secret': 'admin-password' };
    expect((await secured.app.inject({ method: 'GET', url: '/v1/admin/features', headers: admin })).json()).toEqual({ features: { accountLink: true, missions: true, eventHud: true, binaryProtocol: false } });
    const flags = { accountLink: false, missions: true, eventHud: false, binaryProtocol: true };
    expect((await secured.app.inject({ method: 'PUT', url: '/v1/admin/features', headers: admin, payload: { features: flags } })).json()).toEqual({ features: flags });
    expect((await secured.app.inject({ method: 'GET', url: '/v1/config/client' })).json()).toMatchObject({ features: flags });
    const guest = (await secured.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as { accessToken: string };
    expect((await secured.app.inject({ method: 'POST', url: '/v1/auth/link', headers: { authorization: `Bearer ${guest.accessToken}` }, payload: { provider: 'email', proof: 'anything' } })).statusCode).toBe(404);
    const missionsDisabled = { ...flags, missions: false };
    await secured.app.inject({ method: 'PUT', url: '/v1/admin/features', headers: admin, payload: { features: missionsDisabled } });
    expect((await secured.app.inject({ method: 'GET', url: '/v1/missions', headers: { authorization: `Bearer ${guest.accessToken}` } })).statusCode).toBe(404);
    expect((await secured.app.inject({ method: 'PUT', url: '/v1/admin/features', headers: admin, payload: { features: { eventHud: true } } })).statusCode).toBe(400);
    await secured.app.close();
  });
});

describe('게스트 인증 (FR-AUTH-01)', () => {
  it('게스트 생성 시 userId와 access/refresh 토큰을 발급한다', async () => {
    const guest = await createGuest();
    expect(guest.userId).toBeTruthy();
    expect(guest.accessToken).toContain('.');
    expect(guest.refreshToken).toContain('.');
  });

  it('모든 API 응답은 추적 가능한 request ID를 반환한다', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('기본 CORS 허용 오리진은 로컬 웹 개발 주소로 제한한다', async () => {
    const response = await api.app.inject({ method: 'OPTIONS', url: '/v1/auth/guest' });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('로컬 127.0.0.1 개발 서버 포트도 CORS로 허용한다', async () => {
    const response = await api.app.inject({ method: 'OPTIONS', url: '/v1/auth/guest', headers: { origin: 'http://127.0.0.1:4399' } });
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4399');
  });

  it('API 응답은 기본 브라우저 보안 헤더를 포함한다', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/health' });
    expect(response.headers).toMatchObject({
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-site',
    });
  });

  it('같은 IP의 과도한 게스트 발급은 429로 제한한다', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await api.app.inject({ method: 'POST', url: '/v1/auth/guest' })).statusCode).toBe(201);
    }
    expect((await api.app.inject({ method: 'POST', url: '/v1/auth/guest' })).statusCode).toBe(429);
  });

  it('폐기한 access/refresh 토큰은 프로필·매칭·갱신에 다시 쓸 수 없다 (FR-SAFE-01)', async () => {
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };
    const revoke = await api.app.inject({
      method: 'POST', url: '/v1/auth/revoke', headers, payload: { refreshToken: guest.refreshToken },
    });
    expect(revoke.statusCode).toBe(204);

    const me = await api.app.inject({ method: 'GET', url: '/v1/me', headers });
    expect(me.statusCode).toBe(401);
    const ticket = await api.app.inject({ method: 'POST', url: '/v1/matches/tickets', headers });
    expect(ticket.statusCode).toBe(401);
    const refresh = await api.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: guest.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
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
    const replay = await api.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: guest.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

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

  it('운영 cookie 모드는 refresh token을 JSON에 노출하지 않고 HttpOnly Secure cookie로 갱신한다', async () => {
    const cookieApi = buildApi({ secret: 'cookie-secret', refreshCookie: true });
    const guest = await cookieApi.app.inject({ method: 'POST', url: '/v1/auth/guest' });
    expect(guest.statusCode).toBe(201);
    expect(guest.json()).toMatchObject({ accessToken: expect.any(String) });
    expect((guest.json() as { refreshToken?: string }).refreshToken).toBeUndefined();
    const cookie = guest.headers['set-cookie'] as string;
    expect(cookie).toContain('serpent_refresh=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    const refresh = await cookieApi.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie } });
    expect(refresh.statusCode).toBe(200);
    expect((refresh.json() as { refreshToken?: string }).refreshToken).toBeUndefined();
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

  it('운영 금칙어 설정은 기본 보호 목록에 추가 적용된다', async () => {
    const moderated = buildApi({ secret: 'test-secret', internalSecret: 'test-internal', bannedWords: ['vipword'] });
    const guest = await moderated.app.inject({ method: 'POST', url: '/v1/auth/guest' });
    const accessToken = (guest.json() as { accessToken: string }).accessToken;
    const response = await moderated.app.inject({
      method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${accessToken}` }, payload: { nickname: 'vipword_player' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('토큰 없이 /v1/me 접근은 401', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized', requestId: res.headers['x-request-id'] });
  });

  it('삭제 요청은 계정을 제거하고 현재 access token을 즉시 무효화한다', async () => {
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };
    expect((await api.app.inject({ method: 'DELETE', url: '/v1/me', headers })).statusCode).toBe(204);
    expect((await api.app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode).toBe(401);
    expect((await api.app.inject({ method: 'POST', url: '/v1/matches/tickets', headers })).statusCode).toBe(401);
    expect((await api.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: guest.refreshToken } })).statusCode).toBe(401);
  });
});

describe('게스트 계정 연결 (FR-AUTH-02)', () => {
  it('검증된 외부 identity만 진행도를 보존한 채 guest에 연결한다', async () => {
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };
    const linked = await api.app.inject({
      method: 'POST', url: '/v1/auth/link', headers,
      payload: { provider: 'google', proof: 'verified:google' },
    });
    expect(linked.statusCode).toBe(201);
    const me = await api.app.inject({ method: 'GET', url: '/v1/me', headers });
    expect(me.json()).toMatchObject({ accountType: 'account', identities: ['google'] });
    const idempotent = await api.app.inject({
      method: 'POST', url: '/v1/auth/link', headers,
      payload: { provider: 'google', proof: 'verified:google' },
    });
    expect(idempotent.statusCode).toBe(200);
  });

  it('위조 proof와 다른 계정에 이미 연결된 identity를 거부한다', async () => {
    const first = await createGuest();
    const second = await createGuest();
    const firstHeaders = { authorization: `Bearer ${first.accessToken}` };
    expect((await api.app.inject({
      method: 'POST', url: '/v1/auth/link', headers: firstHeaders,
      payload: { provider: 'email', proof: 'forged' },
    })).statusCode).toBe(401);
    expect((await api.app.inject({
      method: 'POST', url: '/v1/auth/link', headers: firstHeaders,
      payload: { provider: 'email', proof: 'verified:email' },
    })).statusCode).toBe(201);
    expect((await api.app.inject({
      method: 'POST', url: '/v1/auth/link', headers: { authorization: `Bearer ${second.accessToken}` },
      payload: { provider: 'email', proof: 'verified:email' },
    })).statusCode).toBe(409);
  });

  it('검증기 미설정 배포는 임의 연결 대신 안전하게 서비스를 거부한다', async () => {
    const withoutVerifier = buildApi({ secret: 'test-secret' });
    const guest = await (async () => {
      const res = await withoutVerifier.app.inject({ method: 'POST', url: '/v1/auth/guest' });
      return res.json() as { accessToken: string };
    })();
    const res = await withoutVerifier.app.inject({
      method: 'POST', url: '/v1/auth/link', headers: { authorization: `Bearer ${guest.accessToken}` },
      payload: { provider: 'email', proof: 'anything' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('친구 초대 (Phase 2)', () => {
  it('서명된 만료 초대를 수락하면 양쪽 목록에 친구가 추가되고 삭제할 수 있다', async () => {
    const inviter = await createGuest();
    const recipient = await createGuest();
    const inviterAuth = { authorization: `Bearer ${inviter.accessToken}` };
    const recipientAuth = { authorization: `Bearer ${recipient.accessToken}` };
    const created = await api.app.inject({ method: 'POST', url: '/v1/friends/invites', headers: inviterAuth });
    expect(created.statusCode).toBe(201);
    const inviteToken = (created.json() as { inviteToken: string }).inviteToken;
    expect((await api.app.inject({ method: 'POST', url: '/v1/friends/invites/accept', headers: recipientAuth, payload: { inviteToken } })).statusCode).toBe(201);
    expect((await api.app.inject({ method: 'GET', url: '/v1/friends', headers: inviterAuth })).json()).toMatchObject({ friends: [{ userId: recipient.userId }] });
    expect((await api.app.inject({ method: 'DELETE', url: `/v1/friends/${inviter.userId}`, headers: recipientAuth })).statusCode).toBe(204);
    expect((await api.app.inject({ method: 'GET', url: '/v1/friends', headers: inviterAuth })).json()).toEqual({ friends: [] });
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

describe('운영 공지 (S-08)', () => {
  it('관리자만 공지를 게시·철회하고 게임 클라이언트는 현재 공지를 읽는다', async () => {
    const forbidden = await api.app.inject({ method: 'PUT', url: '/v1/admin/announcements/current', payload: { message: '점검 예정' } });
    expect(forbidden.statusCode).toBe(403);
    const admin = { 'x-admin-secret': 'test-admin' };
    const published = await api.app.inject({ method: 'PUT', url: '/v1/admin/announcements/current', headers: admin, payload: { message: '  20:00 점검 예정  ' } });
    expect(published.statusCode).toBe(201);
    expect((await api.app.inject({ method: 'GET', url: '/v1/announcements/current' })).json()).toMatchObject({ announcement: { message: '20:00 점검 예정' } });
    expect((await api.app.inject({ method: 'DELETE', url: '/v1/admin/announcements/current', headers: admin })).statusCode).toBe(204);
    expect((await api.app.inject({ method: 'GET', url: '/v1/announcements/current' })).json()).toEqual({ announcement: null });
  });
});

describe('예약 테마 이벤트 (Phase 3)', () => {
  it('관리자가 이벤트를 예약하면 서버 시간이 범위 안일 때만 공개하고 철회할 수 있다', async () => {
    let timestamp = Date.UTC(2026, 6, 14, 12);
    const scoped = buildApi({ secret: 'event-secret', internalSecret: 'event-internal', adminSecret: 'event-admin', now: () => timestamp });
    const admin = { 'x-admin-secret': 'event-admin' };
    const event = { title: '여름 아레나', theme: '오로라', startsAt: new Date(timestamp + 1_000).toISOString(), endsAt: new Date(timestamp + 3_600_000).toISOString(), targetRegions: ['kr-seoul'] };
    expect((await scoped.app.inject({ method: 'PUT', url: '/v1/admin/events/summer-2026', headers: admin, payload: event })).statusCode).toBe(201);
    expect((await scoped.app.inject({ method: 'GET', url: '/v1/events/active' })).json()).toEqual({ event: null });
    timestamp += 2_000;
    expect((await scoped.app.inject({ method: 'GET', url: '/v1/events/active' })).json()).toEqual({ event: null });
    expect((await scoped.app.inject({ method: 'GET', url: '/v1/events/active?region=jp-tokyo' })).json()).toEqual({ event: null });
    expect((await scoped.app.inject({ method: 'GET', url: '/v1/events/active?region=kr-seoul' })).json()).toMatchObject({ event: { id: 'summer-2026', theme: '오로라', targetRegions: ['kr-seoul'] } });
    expect((await scoped.app.inject({ method: 'DELETE', url: '/v1/admin/events/summer-2026', headers: admin })).statusCode).toBe(204);
  });
});

describe('시즌 무료 트랙 (Phase 3)', () => {
  it('활성 시즌의 멱등 경기 결과로 진행하고 단계 보상을 한 번만 지급한다', async () => {
    const timestamp = Date.UTC(2026, 6, 14, 12);
    const scoped = buildApi({ secret: 'season-secret', internalSecret: 'season-internal', adminSecret: 'season-admin', now: () => timestamp });
    const admin = { 'x-admin-secret': 'season-admin' };
    expect((await scoped.app.inject({ method: 'PUT', url: '/v1/admin/seasons/s1', headers: admin, payload: { title: '프리시즌', startsAt: new Date(timestamp - 1_000).toISOString(), endsAt: new Date(timestamp + 86_400_000).toISOString() } })).statusCode).toBe(201);
    const guest = (await scoped.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as { userId: string; accessToken: string };
    const auth = { authorization: `Bearer ${guest.accessToken}` };
    for (let i = 0; i < 3; i += 1) expect((await scoped.app.inject({ method: 'POST', url: '/v1/internal/results', headers: { 'x-internal-secret': 'season-internal' }, payload: { matchId: `season-${i}`, userId: guest.userId, score: 1 } })).statusCode).toBe(201);
    expect((await scoped.app.inject({ method: 'GET', url: '/v1/seasons/current/progress', headers: auth })).json()).toMatchObject({ progress: { matches: 3, claimedLevels: [] } });
    const claim = await scoped.app.inject({ method: 'POST', url: '/v1/seasons/current/claim/1', headers: auth });
    expect(claim.statusCode).toBe(201);
    expect(claim.json()).toMatchObject({ reward: { skinId: 10 } });
    expect((await scoped.app.inject({ method: 'POST', url: '/v1/seasons/current/claim/1', headers: auth })).statusCode).toBe(409);
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

  it('daily/weekly 범위는 UTC 경계 이전의 경기와 selfRank를 제외한다', async () => {
    let timestamp = Date.UTC(2026, 6, 13, 12); // Monday
    const scoped = buildApi({ secret: 'scope-secret', internalSecret: 'scope-internal', repos: createInMemoryRepos(), now: () => timestamp });
    const create = async () => (await scoped.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as { userId: string; accessToken: string };
    const old = await create();
    const current = await create();
    const headers = { 'x-internal-secret': 'scope-internal' };
    timestamp -= 8 * 24 * 60 * 60 * 1000;
    await scoped.app.inject({ method: 'POST', url: '/v1/internal/results', headers, payload: { matchId: 'old', userId: old.userId, score: 999 } });
    timestamp += 8 * 24 * 60 * 60 * 1000;
    await scoped.app.inject({ method: 'POST', url: '/v1/internal/results', headers, payload: { matchId: 'current', userId: current.userId, score: 100 } });

    const daily = await scoped.app.inject({ method: 'GET', url: '/v1/leaderboards/daily', headers: { authorization: `Bearer ${old.accessToken}` } });
    expect(daily.json()).toMatchObject({ scope: 'daily', entries: [{ userId: current.userId }], selfRank: null });
    const all = await scoped.app.inject({ method: 'GET', url: '/v1/leaderboards/all', headers: { authorization: `Bearer ${old.accessToken}` } });
    expect((all.json() as { entries: { userId: string }[] }).entries[0]!.userId).toBe(old.userId);
    expect((await scoped.app.inject({ method: 'GET', url: '/v1/leaderboards/monthly' })).statusCode).toBe(400);
  });
});

describe('일일 미션/보상 (Phase 2)', () => {
  it('멱등 경기 결과 3건으로 완료되고 보상은 한 번만 수령된다', async () => {
    const guest = await createGuest();
    const auth = { authorization: `Bearer ${guest.accessToken}` };
    const internal = { 'x-internal-secret': 'test-internal' };
    for (let i = 0; i < 3; i += 1) {
      const payload = { matchId: `mission-${i}`, userId: guest.userId, score: 10 };
      expect((await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers: internal, payload })).statusCode).toBe(201);
      expect((await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers: internal, payload })).statusCode).toBe(200);
    }
    const listed = (await api.app.inject({ method: 'GET', url: '/v1/missions', headers: auth })).json() as { missions: { progress: number; target: number; claimed: boolean }[] };
    expect(listed.missions[0]).toMatchObject({ progress: 3, target: 3, claimed: false });
    const claim = await api.app.inject({ method: 'POST', url: '/v1/missions/daily_matches_3/claim', headers: auth });
    expect(claim.statusCode).toBe(201);
    expect(claim.json()).toMatchObject({ reward: { skinId: 8 } });
    const cosmetics = (await api.app.inject({ method: 'GET', url: '/v1/cosmetics', headers: auth })).json() as { skins: { id: number; owned: boolean }[] };
    expect(cosmetics.skins.find((skin) => skin.id === 8)).toEqual({ id: 8, owned: true });
    expect((await api.app.inject({ method: 'PUT', url: '/v1/me/loadout', headers: auth, payload: { skinId: 8 } })).statusCode).toBe(200);
    const ticket = await api.app.inject({ method: 'POST', url: '/v1/matches/tickets', headers: auth });
    const ticketPayload = verifyToken((ticket.json() as { joinToken: string }).joinToken, 'test-secret', 'join');
    expect(ticketPayload?.skinId).toBe(8);
    expect((await api.app.inject({ method: 'POST', url: '/v1/missions/daily_matches_3/claim', headers: auth })).statusCode).toBe(409);

    for (let i = 3; i < 10; i += 1) {
      expect((await api.app.inject({ method: 'POST', url: '/v1/internal/results', headers: internal, payload: { matchId: `mission-${i}`, userId: guest.userId, score: 10 } })).statusCode).toBe(201);
    }
    const weekly = (await api.app.inject({ method: 'GET', url: '/v1/missions', headers: auth })).json() as { missions: { id: string; progress: number; target: number }[] };
    expect(weekly.missions.find((mission) => mission.id === 'weekly_matches_10')).toMatchObject({ progress: 10, target: 10 });
    const weeklyClaim = await api.app.inject({ method: 'POST', url: '/v1/missions/weekly_matches_10/claim', headers: auth });
    expect(weeklyClaim.statusCode).toBe(201);
    expect(weeklyClaim.json()).toMatchObject({ reward: { skinId: 9 } });
  });
});

describe('기본 스킨과 장착 (FR-COS-01)', () => {
  it('모든 기본 스킨 소유 상태와 서버에 저장된 장착값을 반환한다', async () => {
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };

    const catalog = await api.app.inject({ method: 'GET', url: '/v1/cosmetics', headers });
    expect(catalog.statusCode).toBe(200);
    const initial = catalog.json() as { skins: { id: number; owned: boolean }[]; selectedSkinId: number };
    expect(initial.skins).toHaveLength(13);
    expect(initial.skins.filter((skin) => skin.id < 8).every((skin) => skin.owned)).toBe(true);
    expect(initial.skins.find((skin) => skin.id === 8)).toEqual({ id: 8, owned: false });
    expect(initial.skins.find((skin) => skin.id === 9)).toEqual({ id: 9, owned: false });
    expect(initial.skins.find((skin) => skin.id === 10)).toEqual({ id: 10, owned: false });
    expect(initial.selectedSkinId).toBe(0);

    const equip = await api.app.inject({ method: 'PUT', url: '/v1/me/loadout', headers, payload: { skinId: 5 } });
    expect(equip.statusCode).toBe(200);
    expect((equip.json() as { selectedSkinId: number }).selectedSkinId).toBe(5);

    const me = await api.app.inject({ method: 'GET', url: '/v1/me', headers });
    expect((me.json() as { selectedSkinId: number }).selectedSkinId).toBe(5);
  });

  it('매치 티켓은 저장된 닉네임·장착 스킨을 서명해 전달한다', async () => {
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };
    await api.app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { nickname: '서버프로필' } });
    await api.app.inject({ method: 'PUT', url: '/v1/me/loadout', headers, payload: { skinId: 5 } });

    const ticket = await api.app.inject({ method: 'POST', url: '/v1/matches/tickets', headers });
    expect(ticket.statusCode).toBe(201);
    const payload = verifyToken((ticket.json() as { joinToken: string }).joinToken, 'test-secret', 'join');
    expect(payload).toMatchObject({ sub: guest.userId, nickname: '서버프로필', skinId: 5 });
  });

  it('비정수 또는 소유하지 않은 스킨은 장착할 수 없다', async () => {
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };
    const malformed = await api.app.inject({ method: 'PUT', url: '/v1/me/loadout', headers, payload: { skinId: '3' } });
    expect(malformed.statusCode).toBe(400);
    const unowned = await api.app.inject({ method: 'PUT', url: '/v1/me/loadout', headers, payload: { skinId: 8 } });
    expect(unowned.statusCode).toBe(403);
  });
});

describe('신고 안전장치 (FR-SAFE-01)', () => {
  it('인증된 사용자는 검증된 신고를 제출하고, 자신은 신고할 수 없다', async () => {
    const reporter = await createGuest();
    const target = await createGuest();
    const headers = { authorization: `Bearer ${reporter.accessToken}` };
    const created = await api.app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers,
      payload: { targetUserId: target.userId, reason: 'cheating', detail: 'impossible movement' },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { reportId: string }).reportId).toBeTruthy();

    const self = await api.app.inject({
      method: 'POST', url: '/v1/reports', headers,
      payload: { targetUserId: reporter.userId, reason: 'other' },
    });
    expect(self.statusCode).toBe(400);
  });

  it('Idempotency-Key가 있는 중복 신고는 최초 응답을 재생한다', async () => {
    const reporter = await createGuest();
    const target = await createGuest();
    const headers = { authorization: `Bearer ${reporter.accessToken}`, 'idempotency-key': 'report-retry-1' };
    const first = await api.app.inject({
      method: 'POST', url: '/v1/reports', headers,
      payload: { targetUserId: target.userId, reason: 'cheating', detail: 'repeat-safe' },
    });
    const retry = await api.app.inject({
      method: 'POST', url: '/v1/reports', headers,
      payload: { targetUserId: target.userId, reason: 'cheating', detail: 'repeat-safe' },
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBe('true');
    expect(retry.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(retry.json()).toEqual(first.json());
  });

  it('관리자만 IP를 제외한 최근 신고 검토 큐를 볼 수 있다', async () => {
    const reporter = await createGuest();
    const created = await api.app.inject({
      method: 'POST', url: '/v1/reports', headers: { authorization: `Bearer ${reporter.accessToken}` },
      payload: { targetUserId: 'review-target', reason: 'abuse', detail: 'review this' },
    });
    expect(created.statusCode).toBe(201);
    const denied = await api.app.inject({ method: 'GET', url: '/v1/admin/reports' });
    expect(denied.statusCode).toBe(403);
    const queue = await api.app.inject({ method: 'GET', url: '/v1/admin/reports?limit=1', headers: { 'x-admin-secret': 'test-admin' } });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toMatchObject({ reports: [{ targetUserId: 'review-target', reason: 'abuse', detail: 'review this' }] });
    expect(JSON.stringify(queue.json())).not.toContain('127.0.0.1');
  });

  it('익명·잘못된 신고와 계정당 시간당 여섯 번째 신고를 거부한다', async () => {
    const reporter = await createGuest();
    const headers = { authorization: `Bearer ${reporter.accessToken}` };
    const unauthenticated = await api.app.inject({
      method: 'POST', url: '/v1/reports', payload: { reason: 'other', detail: 'test' },
    });
    expect(unauthenticated.statusCode).toBe(401);
    const invalid = await api.app.inject({
      method: 'POST', url: '/v1/reports', headers, payload: { reason: 'nope', detail: 'test' },
    });
    expect(invalid.statusCode).toBe(400);

    for (let i = 0; i < 5; i++) {
      const accepted = await api.app.inject({
        method: 'POST', url: '/v1/reports', headers,
        payload: { targetUserId: `target-${i}`, reason: 'other' },
      });
      expect(accepted.statusCode).toBe(201);
    }
    const blocked = await api.app.inject({
      method: 'POST', url: '/v1/reports', headers,
      payload: { targetUserId: 'target-6', reason: 'other' },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it('같은 IP에서 여러 계정이 제출한 열한 번째 신고를 거부한다', async () => {
    for (let i = 0; i < 10; i++) {
      const reporter = await createGuest();
      const accepted = await api.app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: { authorization: `Bearer ${reporter.accessToken}` },
        payload: { targetUserId: `target-${i}`, reason: 'abuse' },
      });
      expect(accepted.statusCode).toBe(201);
    }
    const finalReporter = await createGuest();
    const blocked = await api.app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { authorization: `Bearer ${finalReporter.accessToken}` },
      payload: { targetUserId: 'target-final', reason: 'abuse' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('퍼널 텔레메트리 (PRD §16.1)', () => {
  it('인증된 사용자는 허용된 이벤트 배치를 제출한다', async () => {
    const guest = await createGuest();
    const res = await api.app.inject({
      method: 'POST', url: '/v1/telemetry/batch',
      headers: { authorization: `Bearer ${guest.accessToken}` },
      payload: {
        events: [
          { name: 'landing_view', clientTime: 123, properties: { source: 'direct', retry: false } },
          { name: 'play_click' },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2 });
  });

  it('익명, 비허용 이벤트, 과도한 속도와 민감한 형태의 속성을 거부한다', async () => {
    expect((await api.app.inject({
      method: 'POST', url: '/v1/telemetry/batch', payload: { events: [{ name: 'play_click' }] },
    })).statusCode).toBe(401);
    const guest = await createGuest();
    const headers = { authorization: `Bearer ${guest.accessToken}` };
    expect((await api.app.inject({
      method: 'POST', url: '/v1/telemetry/batch', headers, payload: { events: [{ name: 'free_text', properties: { email: 'x@y.z' } }] },
    })).statusCode).toBe(400);
    expect((await api.app.inject({
      method: 'POST', url: '/v1/telemetry/batch', headers,
      payload: { events: Array.from({ length: 50 }, () => ({ name: 'play_click' })) },
    })).statusCode).toBe(202);
    for (let i = 0; i < 3; i++) {
      expect((await api.app.inject({
        method: 'POST', url: '/v1/telemetry/batch', headers,
        payload: { events: Array.from({ length: 50 }, () => ({ name: 'retry_click' })) },
      })).statusCode).toBe(202);
    }
    expect((await api.app.inject({
      method: 'POST', url: '/v1/telemetry/batch', headers, payload: { events: [{ name: 'retry_click' }] },
    })).statusCode).toBe(429);
  });
});

describe('운영자 닉네임 제재 (FR-SAFE-01)', () => {
  it('TOTP MFA 설정 시 관리자 비밀만으로는 변경할 수 없다', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const mfaApi = buildApi({ secret: 'mfa-token', adminSecret: 'mfa-admin', adminTotpSecret: secret });
    const guest = (await mfaApi.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as { userId: string };
    const payload = { until: new Date(Date.now() + 60_000).toISOString(), reason: 'mfa check' };
    expect((await mfaApi.app.inject({ method: 'POST', url: `/v1/admin/users/${guest.userId}/ban`, headers: { 'x-admin-secret': 'mfa-admin' }, payload })).statusCode).toBe(403);
    const code = totpCode(secret, Date.now())!;
    expect((await mfaApi.app.inject({ method: 'POST', url: `/v1/admin/users/${guest.userId}/ban`, headers: { 'x-admin-secret': 'mfa-admin', 'x-admin-totp': code }, payload })).statusCode).toBe(200);
  });

  it('제재된 사용자의 access/refresh/매칭을 차단하고 해제 후 다시 허용한다', async () => {
    const guest = await createGuest();
    const admin = { 'x-admin-secret': 'test-admin' };
    const until = new Date(Date.now() + 60_000).toISOString();
    const banned = await api.app.inject({
      method: 'POST', url: `/v1/admin/users/${guest.userId}/ban`, headers: admin,
      payload: { until, reason: 'repeated inappropriate name' },
    });
    expect(banned.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${guest.accessToken}` };
    expect((await api.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).statusCode).toBe(401);
    expect((await api.app.inject({ method: 'POST', url: '/v1/matches/tickets', headers: auth })).statusCode).toBe(401);
    expect((await api.app.inject({
      method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: guest.refreshToken },
    })).statusCode).toBe(403);

    expect((await api.app.inject({ method: 'DELETE', url: `/v1/admin/users/${guest.userId}/ban`, headers: admin })).statusCode).toBe(204);
    expect((await api.app.inject({ method: 'GET', url: '/v1/me', headers: auth })).statusCode).toBe(200);
  });

  it('운영자 비밀 또는 유효한 제재 기간 없이 제재할 수 없다', async () => {
    const guest = await createGuest();
    const noAuth = await api.app.inject({
      method: 'POST', url: `/v1/admin/users/${guest.userId}/ban`,
      payload: { until: new Date(Date.now() + 60_000).toISOString(), reason: 'bad name' },
    });
    expect(noAuth.statusCode).toBe(403);
    const invalid = await api.app.inject({
      method: 'POST', url: `/v1/admin/users/${guest.userId}/ban`, headers: { 'x-admin-secret': 'test-admin' },
      payload: { until: new Date(Date.now() - 1).toISOString(), reason: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('운영 설정 롤아웃/롤백 (FR-OPS-01/02)', () => {
  it('단계 롤아웃은 고정 인스턴스 키에 결정적으로 배정하고 키가 없으면 안정 버전을 유지한다', async () => {
    const previous = { version: 'stable', activatedAt: 1, config: defaultGameConfig, rolloutPercent: 100 };
    const staged = { version: 'canary', activatedAt: 2, config: createGameConfig({ version: 'canary' }), rolloutPercent: 20 };
    const selected = Array.from({ length: 200 }, (_, index) => `server-${index}`).find((key) => selectConfigRevision([previous, staged], key).version === 'canary')!;
    expect(selectConfigRevision([previous, staged]).version).toBe('stable');
    expect(selectConfigRevision([previous, staged], selected).version).toBe('canary');
    expect(selectConfigRevision([previous, staged], selected).version).toBe('canary');
  });

  it('관리자는 단계 배포 비율을 활성화하고 공개 설정 조회는 서버 키별 버전을 반환한다', async () => {
    const next = createGameConfig({ version: '2026-07-14.canary' });
    const activate = await api.app.inject({ method: 'PUT', url: '/v1/admin/config/activate', headers: { 'x-admin-secret': 'test-admin' }, payload: { config: next, rolloutPercent: 1 } });
    expect(activate.statusCode).toBe(201);
    expect(activate.json()).toMatchObject({ rolloutPercent: 1 });
    const unkeyed = await api.app.inject({ method: 'GET', url: '/v1/config/client' });
    expect(unkeyed.json()).toMatchObject({ configVersion: defaultGameConfig.version });
    const invalid = await api.app.inject({ method: 'PUT', url: '/v1/admin/config/activate', headers: { 'x-admin-secret': 'test-admin' }, payload: { config: createGameConfig({ version: 'bad-rollout' }), rolloutPercent: 101 } });
    expect(invalid.statusCode).toBe(400);
  });

  it('단계 배포는 1%→10%처럼 단조롭게 승격되고 P1 경보에서는 자동 중단된다', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ alerts: [] }), { status: 200 }));
    const guarded = buildApi({ secret: 'rollout-secret', adminSecret: 'rollout-admin', opsEndpoint: 'http://game.internal', opsSecret: 'ops-secret', opsFetch: fetchMock });
    const admin = { 'x-admin-secret': 'rollout-admin' };
    const canary = createGameConfig({ version: 'guarded-canary' });
    expect((await guarded.app.inject({ method: 'PUT', url: '/v1/admin/config/activate', headers: admin, payload: { config: canary, rolloutPercent: 1 } })).statusCode).toBe(201);
    const promoted = await guarded.app.inject({ method: 'POST', url: '/v1/admin/config/rollout', headers: admin, payload: { rolloutPercent: 10 } });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ configVersion: 'guarded-canary', rolloutPercent: 10 });
    const repeated = await guarded.app.inject({ method: 'POST', url: '/v1/admin/config/rollout', headers: admin, payload: { rolloutPercent: 10 } });
    expect(repeated.statusCode).toBe(409);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ alerts: [{ severity: 'P1', code: 'tick_budget_exceeded' }] }), { status: 200 }));
    const paused = await guarded.app.inject({ method: 'POST', url: '/v1/admin/config/rollout', headers: admin, payload: { rolloutPercent: 50 } });
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toMatchObject({ code: 'rollout_paused' });
    await guarded.app.close();
  });

  it('유효한 새 configVersion을 활성화하고 이전 버전으로 즉시 되돌린다', async () => {
    const admin = { 'x-admin-secret': 'test-admin' };
    const next = createGameConfig({
      version: '2026-07-14.1',
      snake: { ...defaultGameConfig.snake, baseSpeed: 190, boostSpeed: 285 },
    });
    const activate = await api.app.inject({
      method: 'PUT', url: '/v1/admin/config/activate', headers: admin, payload: { config: next },
    });
    expect(activate.statusCode).toBe(201);
    const client = await api.app.inject({ method: 'GET', url: '/v1/config/client' });
    expect((client.json() as { configVersion: string; config: GameConfig }).configVersion).toBe(next.version);
    expect((client.json() as { config: GameConfig }).config.snake.baseSpeed).toBe(190);

    const rollback = await api.app.inject({
      method: 'POST', url: '/v1/admin/config/rollback', headers: admin,
      payload: { version: defaultGameConfig.version },
    });
    expect(rollback.statusCode).toBe(200);
    expect((await api.app.inject({ method: 'GET', url: '/v1/config/client' })).json()).toMatchObject({
      configVersion: defaultGameConfig.version,
    });
    const audit = await api.app.inject({ method: 'GET', url: '/v1/admin/audit?limit=2', headers: admin });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as { entries: { action: string }[] }).entries.map((entry) => entry.action)).toEqual(['config.rollback', 'config.activate']);
  });

  it('운영자 권한, 새 버전, 안전한 tick 설정을 검증한다', async () => {
    const duplicate = await api.app.inject({
      method: 'PUT', url: '/v1/admin/config/activate', headers: { 'x-admin-secret': 'test-admin' },
      payload: { config: defaultGameConfig },
    });
    expect(duplicate.statusCode).toBe(409);
    const invalid = await api.app.inject({
      method: 'PUT', url: '/v1/admin/config/activate', headers: { 'x-admin-secret': 'test-admin' },
      payload: { config: createGameConfig({ version: 'bad-tick', simulation: { ...defaultGameConfig.simulation, fixedDeltaMs: 10 } }) },
    });
    expect(invalid.statusCode).toBe(400);
    const unauthorized = await api.app.inject({
      method: 'PUT', url: '/v1/admin/config/activate', payload: { config: createGameConfig({ version: 'unauthorized' }) },
    });
    expect(unauthorized.statusCode).toBe(403);
  });
});

describe('validateNickname 단위', () => {
  it('공백 trim 후 저장 형태를 돌려준다', () => {
    const r = validateNickname('  Snake_1 ');
    expect(r).toEqual({ ok: true, normalized: 'Snake_1' });
  });
});
