import type { ColyseusTestServer } from '@colyseus/testing';
import type { SnapshotMessage, WelcomeMessage } from '@serpent/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootArenaServer, collectMessages, until } from './testServer';

/**
 * 서버 권위 검증 (loop.md C5, PRD §11.5 / §14.2):
 * 클라이언트가 좌표/점수/길이를 위조해 보내도 서버 상태는 변하지 않고,
 * 비정상 입력(NaN, seq 역행, 폭주 빈도)은 폐기된다.
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

// 펠릿 0개(점수/질량 통제), 넉넉한 아레나(경계 사망 배제)
const cleanConfig = {
  arena: { width: 8000, height: 8000, boundary: 'lethal' as const },
  room: { maxPlayers: 60, minHumans: 1, maxBots: 0 },
  pellets: { targetCount: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
};

function latestSnapshot(msgs: { snapshot: unknown[] }): SnapshotMessage | undefined {
  return msgs.snapshot[msgs.snapshot.length - 1] as SnapshotMessage | undefined;
}

describe('서버 권위 (M2)', () => {
  it('위조된 x/y/score/length 필드는 서버 상태에 어떤 영향도 주지 않는다', async () => {
    const room = await server.createRoom('arena', { config: cleanConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);
    await until(() => msgs.welcome.length >= 1);
    const welcome = msgs.welcome[0] as WelcomeMessage;
    const spawn = welcome.players.find((p) => p.id === client.sessionId)!;

    // 좌표/점수를 위조한 입력 폭탄
    client.send('input', {
      seq: 1,
      dirX: 1,
      dirY: 0,
      boost: false,
      x: 99_999,
      y: 99_999,
      score: 1_000_000,
      length: 9_999,
    });

    await until(() => msgs.snapshot.length >= 4);
    const snap = latestSnapshot(msgs)!;
    const self = snap.snakes.find((p) => p.id === client.sessionId)!;

    // 점수/질량은 그대로, 위치는 서버 시뮬레이션 궤적 안 (위조 좌표 근처가 아님)
    expect(self.score).toBe(0);
    expect(self.mass).toBeCloseTo(spawn.mass, 5);
    const moved = Math.hypot(self.x - spawn.x, self.y - spawn.y);
    expect(moved).toBeLessThan(1000); // 몇 백 ms 이동 거리 수준
    expect(Math.hypot(self.x - 99_999, self.y - 99_999)).toBeGreaterThan(10_000);
    // 입력 자체(방향/부스트)는 정상 수락되어 ack된다
    expect(snap.lastAckInputSeq).toBe(1);
  }, 20_000);

  it('NaN 방향 입력은 폐기되어 ack가 전진하지 않는다', async () => {
    const room = await server.createRoom('arena', { config: cleanConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);
    await until(() => msgs.snapshot.length >= 1);

    client.send('input', { seq: 1, dirX: 1, dirY: 0, boost: false });
    await until(() => latestSnapshot(msgs)?.lastAckInputSeq === 1);

    client.send('input', { seq: 2, dirX: NaN, dirY: 0, boost: false });
    client.send('input', { seq: 3, dirX: 1, dirY: Infinity, boost: false });
    // 유효한 4번이 오면 2,3은 건너뛰어졌음이 확정된다
    client.send('input', { seq: 4, dirX: 0, dirY: 1, boost: false });
    await until(() => latestSnapshot(msgs)?.lastAckInputSeq === 4);
    // 2/3이 수락된 순간은 존재하지 않아야 한다
    const acks = (msgs.snapshot as SnapshotMessage[]).map((s) => s.lastAckInputSeq);
    expect(acks).not.toContain(2);
    expect(acks).not.toContain(3);
  }, 20_000);

  it('seq 역행/중복 입력은 폐기된다', async () => {
    const room = await server.createRoom('arena', { config: cleanConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);
    await until(() => msgs.snapshot.length >= 1);

    client.send('input', { seq: 10, dirX: 1, dirY: 0, boost: false });
    await until(() => latestSnapshot(msgs)?.lastAckInputSeq === 10);

    client.send('input', { seq: 5, dirX: 0, dirY: 1, boost: false }); // 역행
    client.send('input', { seq: 10, dirX: 0, dirY: 1, boost: false }); // 중복
    client.send('input', { seq: 11, dirX: -1, dirY: 0, boost: false }); // 정상
    await until(() => latestSnapshot(msgs)?.lastAckInputSeq === 11);
    const acks = (msgs.snapshot as SnapshotMessage[]).map((s) => s.lastAckInputSeq);
    expect(Math.max(...acks)).toBe(11);
  }, 20_000);

  it('초당 빈도 제한을 넘는 입력 폭주는 드롭된다 (PRD §14.2)', async () => {
    const room = await server.createRoom('arena', { config: cleanConfig });
    const client = await server.connectTo(room);
    const msgs = collectMessages(client);
    await until(() => msgs.snapshot.length >= 1);

    // 200개 연사 (inputRate 20 → cap 30/s)
    for (let seq = 1; seq <= 200; seq++) {
      client.send('input', { seq, dirX: 1, dirY: 0, boost: false });
    }
    await until(() => (latestSnapshot(msgs)?.lastAckInputSeq ?? 0) >= 1, 5_000);
    // 윈도 롤오버 여유를 두어도 전량 수락은 불가능하다
    await new Promise((r) => setTimeout(r, 600));
    const finalAck = latestSnapshot(msgs)!.lastAckInputSeq;
    expect(finalAck).toBeGreaterThanOrEqual(1);
    expect(finalAck).toBeLessThanOrEqual(90); // cap 30 × 최대 2~3윈도 << 200
  }, 20_000);
});
