import type { ColyseusTestServer } from '@colyseus/testing';
import type { EventMessage, ResultMessage, SnapshotMessage, WelcomeMessage } from '@serpent/protocol';
import type { ArenaRoom } from './ArenaRoom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootArenaServer, collectMessages, until } from './testServer';

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootArenaServer();
});

afterEach(async () => {
  await server.cleanup();
});

afterAll(async () => {
  await server.shutdown();
});

// 테스트 전용 소형 설정: 펠릿 없음(점수 통제), 작은 아레나(빠른 경계 도달)
const smallConfig = {
  arena: { width: 1200, height: 1200, boundary: 'lethal' as const },
  room: { maxPlayers: 60, minHumans: 1, maxBots: 0 },
  pellets: { targetCount: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
};

describe('ArenaRoom 통합 (M2)', () => {
  it('접속하면 welcome과 tickId가 증가하는 snapshot을 받는다', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);

    await until(() => msgs.welcome.length >= 1 && msgs.snapshot.length >= 3);
    const welcome = msgs.welcome[0] as WelcomeMessage;
    expect(welcome.playerId).toBe(client.sessionId);
    expect(welcome.tickRate).toBe(20);
    expect(welcome.snapshotRate).toBe(10);
    expect(welcome.players.some((p) => p.id === client.sessionId)).toBe(true);

    const snaps = msgs.snapshot as SnapshotMessage[];
    expect(snaps[1]!.tickId).toBeGreaterThan(snaps[0]!.tickId);
    expect(snaps[2]!.tickId).toBeGreaterThan(snaps[1]!.tickId);
    expect(snaps[0]!.snakes.some((p) => p.id === client.sessionId)).toBe(true);
  }, 20_000);

  it('두 클라이언트가 동일한 tickId와 원인의 사망 이벤트를 받는다 (PRD §6.1 사망)', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const c1 = await server.connectTo(room);
    const c2 = await server.connectTo(room);
    const m1 = collectMessages(c1);
    const m2 = collectMessages(c2);

    // 무작위 스폰된 c2 몸통을 향하지 않는 가장 가까운 경계로 c1을 보낸다.
    // 이 선택이 없으면 간헐적으로 body 충돌이 경계보다 먼저 발생할 수 있다.
    await until(() => m2.welcome.length >= 1, 5_000);
    const positions = (m2.welcome[0] as WelcomeMessage).players;
    const self = positions.find((player) => player.id === c1.sessionId)!;
    const other = positions.find((player) => player.id === c2.sessionId)!;
    const directions = [
      { dirX: -1, dirY: 0, distance: self.x },
      { dirX: 1, dirY: 0, distance: 1200 - self.x },
      { dirX: 0, dirY: -1, distance: self.y },
      { dirX: 0, dirY: 1, distance: 1200 - self.y },
    ].map((candidate) => ({ ...candidate, towardOther: candidate.dirX * (other.x - self.x) + candidate.dirY * (other.y - self.y) }))
      .filter((candidate) => candidate.towardOther <= 0)
      .sort((a, b) => a.distance - b.distance);
    const direction = directions[0]!;
    let seq = 0;
    const driver = setInterval(() => {
      c1.send('input', { seq: ++seq, dirX: direction.dirX, dirY: direction.dirY, boost: false });
    }, 50);

    try {
      const deathOf = (events: unknown[]) =>
        (events as EventMessage[]).find((e) => e.type === 'death' && e.snakeId === c1.sessionId);
      await until(() => Boolean(deathOf(m1.event) && deathOf(m2.event)), 15_000);

      const d1 = deathOf(m1.event)!;
      const d2 = deathOf(m2.event)!;
      expect(d1).toEqual(d2); // 동일 tickId, 동일 원인, 동일 대상
      if (d1.type === 'death') {
        expect(d1.cause).toBe('boundary');
        expect(d1.tickId).toBeGreaterThan(0);
      }
      // 본인에게는 result가 간다
      await until(() => m1.result.length >= 1, 5_000);
      const result = m1.result[0] as ResultMessage;
      expect(result.matchId).toContain(`:${c1.sessionId}:`);
    } finally {
      clearInterval(driver);
    }
  }, 25_000);

  it('ping을 보내면 nonce/clientTime 에코와 serverTime이 담긴 pong이 온다 (PRD §9.5)', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);
    await until(() => msgs.welcome.length >= 1);

    const before = Date.now();
    client.send('ping', { nonce: 77, clientTime: 12345 });
    await until(() => msgs.pong.length >= 1, 5_000);
    const pong = msgs.pong[0] as { nonce: number; clientTime: number; serverTime: number };
    expect(pong.nonce).toBe(77);
    expect(pong.clientTime).toBe(12345);
    expect(pong.serverTime).toBeGreaterThanOrEqual(before);
  }, 20_000);

  it('drain 시작은 현재 플레이어에게 신뢰성 유지보수 notice를 보낸다', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const client = await server.connectTo(room);
    const messages = collectMessages(client);
    await until(() => messages.welcome.length >= 1);

    await (room as unknown as ArenaRoom).drain();

    await until(() => (messages.event as EventMessage[]).some((event) => event.type === 'notice'), 5_000);
    const notice = (messages.event as EventMessage[]).find((event) => event.type === 'notice');
    expect(notice).toMatchObject({ type: 'notice', level: 'warning' });
  }, 20_000);

  it('resync를 보내면 full baseline(welcome)이 재전송된다 (PRD §11.4)', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);
    await until(() => msgs.welcome.length >= 1 && msgs.snapshot.length >= 2);

    const welcomesBefore = msgs.welcome.length;
    client.send('resync', { lastGoodTickId: 0, reason: 'test' });
    await until(() => msgs.welcome.length > welcomesBefore, 5_000);
    const rewelcome = msgs.welcome[msgs.welcome.length - 1] as WelcomeMessage;
    expect(rewelcome.players.some((p) => p.id === client.sessionId)).toBe(true);
    expect(rewelcome.pellets.length).toBeGreaterThanOrEqual(0);
    expect(rewelcome.tickId).toBeGreaterThan(0);
  }, 20_000);

  it('리더보드가 점수순+생존 타이브레이크로 4Hz 전파되고 본인 순위를 담는다 (FR-RANK-01)', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const c1 = await server.connectTo(room, { nickname: '첫째뱀', skinId: 2 });
    const m1 = collectMessages(c1);
    await until(() => m1.welcome.length >= 1);
    const c2 = await server.connectTo(room, { nickname: '둘째뱀', skinId: 5 });
    const m2 = collectMessages(c2);

    await until(() => m1.leaderboard.length >= 2 && m2.leaderboard.length >= 1);
    type LB = { entries: { id: string; name: string; score: number }[]; selfRank: number; totalPlayers: number };
    const lb1 = m1.leaderboard[m1.leaderboard.length - 1] as LB;
    const lb2 = m2.leaderboard[m2.leaderboard.length - 1] as LB;

    // 점수 동률 → 먼저 스폰한 c1이 상위 (생존 타이브레이크)
    expect(lb1.entries[0]!.id).toBe(c1.sessionId);
    expect(lb1.entries[0]!.name).toBe('첫째뱀');
    expect(lb1.selfRank).toBe(1);
    expect(lb2.selfRank).toBe(2);
    expect(lb1.totalPlayers).toBe(2);
    // welcome baseline에 스킨이 반사된다 (FR-COS-01)
    const w1 = m1.welcome[0] as WelcomeMessage;
    expect(w1.players.find((p) => p.id === c1.sessionId)?.skinId).toBe(2);
  }, 20_000);

  it('사망 후 respawn을 보내면 새 welcome과 함께 살아난다', async () => {
    const room = await server.createRoom('arena', { config: smallConfig });
    const c1 = await server.connectTo(room);
    const m1 = collectMessages(c1);

    let seq = 0;
    const driver = setInterval(() => {
      c1.send('input', { seq: ++seq, dirX: 0, dirY: -1, boost: false });
    }, 50);

    try {
      await until(
        () =>
          (m1.event as EventMessage[]).some(
            (e) => e.type === 'death' && e.snakeId === c1.sessionId,
          ),
        15_000,
      );
      clearInterval(driver);

      const welcomesBefore = m1.welcome.length;
      c1.send('respawn', {});
      await until(() => m1.welcome.length > welcomesBefore, 5_000);
      const rewelcome = m1.welcome[m1.welcome.length - 1] as WelcomeMessage;
      const self = rewelcome.players.find((p) => p.id === c1.sessionId);
      expect(self?.alive).toBe(true);
    } finally {
      clearInterval(driver);
    }
  }, 25_000);
});
