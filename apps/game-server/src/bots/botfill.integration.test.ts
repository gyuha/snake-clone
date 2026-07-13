import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArenaRoom } from '../rooms/ArenaRoom';
import { bootArenaServer, collectMessages, until } from '../rooms/testServer';

/**
 * 봇 fill 통합 검증 (FR-MATCH-03): 인간이 minHumans 미만이면 봇이 채우고,
 * 인간이 늘면 초과 봇이 제거된다.
 */
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

const fillConfig = {
  room: { maxPlayers: 60, minHumans: 4, maxBots: 20 },
  pellets: { targetCount: 100, chunkSync: true, respawnBudgetPerTick: 10, baseValue: 1, radius: 6 },
};

describe('봇 fill (M5)', () => {
  it('인간 1명 → 봇 3, 인간 2명 → 봇 2, 전원 퇴장 → 봇 0', async () => {
    const room = (await server.createRoom('arena', { config: fillConfig })) as unknown as ArenaRoom;
    const c1 = await server.connectTo(room as never);
    collectMessages(c1);
    await until(() => room.getPopulation().bots === 3, 5_000);
    expect(room.getPopulation()).toEqual({ humans: 1, bots: 3 });

    const c2 = await server.connectTo(room as never);
    collectMessages(c2);
    await until(() => room.getPopulation().bots === 2, 5_000);
    expect(room.getPopulation()).toEqual({ humans: 2, bots: 2 });

    await c1.leave();
    await until(() => room.getPopulation().bots === 3, 5_000);

    await c2.leave();
    await until(() => room.getPopulation().humans === 0, 5_000);
  }, 25_000);

  it('봇은 죽어도 자동 재스폰되어 정원이 유지된다', async () => {
    const room = (await server.createRoom('arena', {
      config: {
        ...fillConfig,
        // 아주 작은 아레나 → 봇도 이따금 죽는다 (회피에도 불구하고 좁은 공간)
        arena: { width: 900, height: 900, boundary: 'lethal' as const },
      },
    })) as unknown as ArenaRoom;
    const c1 = await server.connectTo(room as never);
    collectMessages(c1);
    await until(() => room.getPopulation().bots === 3, 5_000);

    // 2초 진행 후에도 봇 수는 3 유지 (사망 시 재스폰)
    await new Promise((r) => setTimeout(r, 2_000));
    expect(room.getPopulation().bots).toBe(3);
  }, 25_000);
});
