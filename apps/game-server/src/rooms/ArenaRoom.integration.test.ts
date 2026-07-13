import type { ColyseusTestServer } from '@colyseus/testing';
import type { EventMessage, SnapshotMessage, WelcomeMessage } from '@serpent/protocol';
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

    // c1을 오른쪽 경계로 직진시킨다 (1200 아레나 → 수 초 내 사망)
    let seq = 0;
    const driver = setInterval(() => {
      c1.send('input', { seq: ++seq, dirX: 1, dirY: 0, boost: false });
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
    } finally {
      clearInterval(driver);
    }
  }, 25_000);

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
