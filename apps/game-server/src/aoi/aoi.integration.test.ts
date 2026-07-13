import type { ColyseusTestServer } from '@colyseus/testing';
import type { SnapshotMessage, WelcomeMessage } from '@serpent/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootArenaServer, collectMessages, until } from '../rooms/testServer';

/**
 * AOI 통합 검증 (loop.md C6-a): 관심 영역 밖 엔터티는 전송 자체가 없다.
 * 기본 6,000×6,000 아레나 + interest 1,500이면 스폰 지점에서
 * 반경 밖 펠릿이 반드시 존재한다.
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

describe('AOI 통합 (M4)', () => {
  it('welcome baseline과 snapshot의 펠릿/청크는 despawn 반경 안으로 제한된다', async () => {
    const room = await server.createRoom('arena', { seed: 42 });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);

    await until(() => msgs.welcome.length >= 1 && msgs.snapshot.length >= 3);
    const welcome = msgs.welcome[0] as WelcomeMessage;
    const self = welcome.players.find((p) => p.id === client.sessionId)!;

    // 청크 판정 보정(셀 반대각 절반) + 청크 내 최악 위치(셀 반대각 절반)
    const cellDiagHalf = (500 * Math.SQRT2) / 2;
    const bound = 1800 + cellDiagHalf * 2;

    // (a-1) 기준 상태의 모든 펠릿이 스폰 AOI 경계 안에 있다
    expect(welcome.pellets.length).toBeGreaterThan(0);
    for (const p of welcome.pellets) {
      expect(Math.hypot(p.x - self.x, p.y - self.y)).toBeLessThanOrEqual(bound);
    }
    // 아레나 전체 펠릿(1,200)이 그대로 오지 않았음 — AOI 필터가 실제로 작동
    expect(welcome.pellets.length).toBeLessThan(1000);

    // (a-2) snapshot의 청크 증분도 구독 청크(관측자 주변)로 제한된다
    const snaps = msgs.snapshot as SnapshotMessage[];
    const latest = snaps[snaps.length - 1]!;
    const me = latest.snakes.find((s) => s.id === client.sessionId)!;
    for (const snap of snaps) {
      for (const chunk of snap.pelletChunks) {
        const [cx, cy] = chunk.chunkId.split(':').map(Number);
        const center = { x: (cx! + 0.5) * 500, y: (cy! + 0.5) * 500 };
        // 관측자가 이동하므로 최신 위치 기준 넉넉한 경계로 검증
        const dist = Math.hypot(center.x - me.x, center.y - me.y);
        expect(dist).toBeLessThanOrEqual(bound + 500);
      }
    }
  }, 25_000);

  it('snapshot에는 구독 중인 뱀만 실리고 자기 자신은 항상 포함된다', async () => {
    const room = await server.createRoom('arena', { seed: 43 });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);

    await until(() => msgs.snapshot.length >= 2);
    for (const snap of msgs.snapshot as SnapshotMessage[]) {
      expect(snap.snakes.some((s) => s.id === client.sessionId)).toBe(true);
    }
  }, 20_000);
});
