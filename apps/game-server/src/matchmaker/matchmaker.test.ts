// 이 파일은 joinToken 강제 환경에서 실행된다 (vitest 파일 격리 — 다른 파일에 누출 없음)
process.env.SERPENT_REQUIRE_JOIN_TOKEN = '1';
process.env.SERPENT_TOKEN_SECRET = 'mm-secret';
process.env.SERPENT_INTERNAL_SECRET = 'mm-internal';

import type { ColyseusTestServer } from '@colyseus/testing';
import { buildApi, type BuiltApi } from '@serpent/api';
import { createToken } from '@serpent/api/tokens';
import type { WelcomeMessage } from '@serpent/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ArenaRoom } from '../rooms/ArenaRoom';
import { bootArenaServer, collectMessages, until } from '../rooms/testServer';

/**
 * 매치메이커·재연결 통합 (loop.md C8, PRD §11.3 / §14.2 / §5.5 / FR-GAME-04).
 */
let server: ColyseusTestServer;
let api: BuiltApi;

beforeAll(async () => {
  server = await bootArenaServer();
});

beforeEach(() => {
  api = buildApi({ secret: 'mm-secret', internalSecret: 'mm-internal' });
});

afterEach(async () => {
  await server.cleanup();
});

afterAll(async () => {
  await server.shutdown();
});

const quietConfig = {
  room: { maxPlayers: 60, minHumans: 1, maxBots: 0 },
  pellets: { targetCount: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
};

async function issueTicket() {
  const guest = (await api.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as {
    userId: string;
    accessToken: string;
  };
  const ticketRes = await api.app.inject({
    method: 'POST',
    url: '/v1/matches/tickets',
    headers: { authorization: `Bearer ${guest.accessToken}` },
    payload: { mode: 'classic' },
  });
  expect(ticketRes.statusCode).toBe(201);
  return { guest, ticket: ticketRes.json() as { roomName: string; endpoint: string; joinToken: string; expiresAt: string } };
}

describe('매치 티켓 (FR-MATCH-02)', () => {
  it('티켓에 만료와 1회용 joinToken이 포함된다', async () => {
    const { ticket } = await issueTicket();
    expect(ticket.roomName).toBe('arena');
    expect(ticket.joinToken).toContain('.');
    const msLeft = new Date(ticket.expiresAt).getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(5_000);
    expect(msLeft).toBeLessThanOrEqual(15_000);
  });

  it('무토큰 티켓 발급은 401', async () => {
    const res = await api.app.inject({ method: 'POST', url: '/v1/matches/tickets', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('game-server joinToken 검증 (PRD §14.2)', () => {
  it('유효 토큰은 입장, 재사용·위조·만료·무토큰은 거부된다', async () => {
    const room = await server.createRoom('arena', { config: quietConfig });
    const { ticket } = await issueTicket();

    // 유효 토큰 입장
    const c1 = await server.connectTo(room, { joinToken: ticket.joinToken });
    const m1 = collectMessages(c1);
    await until(() => m1.welcome.length >= 1);

    // 동일 토큰 재사용 → 거부 (1회용)
    await expect(server.connectTo(room, { joinToken: ticket.joinToken })).rejects.toThrow();

    // 위조 토큰(다른 시크릿) → 거부
    const forged = createToken(
      { sub: 'u', type: 'join', exp: Date.now() + 10_000, roomName: 'arena', nonce: 'f1' },
      'wrong-secret',
    );
    await expect(server.connectTo(room, { joinToken: forged })).rejects.toThrow();

    // 만료 토큰 → 거부
    const expired = createToken(
      { sub: 'u', type: 'join', exp: Date.now() - 1_000, roomName: 'arena', nonce: 'f2' },
      'mm-secret',
    );
    await expect(server.connectTo(room, { joinToken: expired })).rejects.toThrow();

    // 무토큰 → 거부
    await expect(server.connectTo(room)).rejects.toThrow();
  }, 25_000);
});

describe('재연결 (FR-GAME-04 / PRD §5.5)', () => {
  it('grace 내 재접속은 동일 playerId와 뱀 상태를 회수한다', async () => {
    const room = (await server.createRoom('arena', {
      config: { ...quietConfig, reconnect: { graceMs: 5_000 } },
    })) as unknown as ArenaRoom;
    const { ticket } = await issueTicket();
    const c1 = await server.connectTo(room as never, { joinToken: ticket.joinToken });
    const m1 = collectMessages(c1);
    await until(() => m1.welcome.length >= 1 && m1.snapshot.length >= 2);
    const sessionId = c1.sessionId;
    const reconnectionToken = c1.reconnectionToken;

    // 비의도 절단 (consented=false)
    await c1.leave(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(room.hasSnake(sessionId)).toBe(true); // grace 동안 뱀 유지

    // 재접속 — 동일 playerId 회수
    const c2 = await server.sdk.reconnect(reconnectionToken);
    const m2 = collectMessages(c2);
    await until(() => m2.welcome.length >= 1, 5_000);
    const welcome = m2.welcome[0] as WelcomeMessage;
    expect(c2.sessionId).toBe(sessionId);
    expect(welcome.playerId).toBe(sessionId);
    expect(welcome.players.find((p) => p.id === sessionId)?.alive).toBe(true);
  }, 25_000);

  it('grace 초과 시 뱀이 제거된다', async () => {
    const room = (await server.createRoom('arena', {
      config: { ...quietConfig, reconnect: { graceMs: 1_000 } },
    })) as unknown as ArenaRoom;
    const { ticket } = await issueTicket();
    const c1 = await server.connectTo(room as never, { joinToken: ticket.joinToken });
    const m1 = collectMessages(c1);
    await until(() => m1.welcome.length >= 1);
    const sessionId = c1.sessionId;

    await c1.leave(false);
    await until(() => !room.hasSnake(sessionId), 5_000);
    expect(room.hasSnake(sessionId)).toBe(false);
  }, 25_000);
});

describe('결과 저장 파이프 (PRD §9.7)', () => {
  it('사망 result가 api에 matchId 멱등으로 기록된다', async () => {
    // api를 실제 포트에 리슨시키고 game-server가 fetch로 전달
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const address = api.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    process.env.SERPENT_API_URL = `http://127.0.0.1:${port}`;

    try {
      const room = await server.createRoom('arena', {
        config: {
          ...quietConfig,
          arena: { width: 1200, height: 1200, boundary: 'lethal' as const },
        },
      });
      const { guest, ticket } = await issueTicket();
      const c1 = await server.connectTo(room, { joinToken: ticket.joinToken });
      const m1 = collectMessages(c1);
      await until(() => m1.welcome.length >= 1);

      // 경계로 돌진 → 사망
      let seq = 0;
      const driver = setInterval(() => c1.send('input', { seq: ++seq, dirX: 1, dirY: 0, boost: false }), 50);
      try {
        await until(() => m1.result.length >= 1, 15_000);
      } finally {
        clearInterval(driver);
      }

      // 플러시(500ms 주기) 후 저장 확인 — userId는 joinToken의 sub
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await api.repos.matches.statsOf(guest.userId)).games >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const stats = await api.repos.matches.statsOf(guest.userId);
      expect(stats.games).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.SERPENT_API_URL;
      await api.app.close();
    }
  }, 30_000);
});
