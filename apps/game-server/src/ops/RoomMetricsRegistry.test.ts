import { describe, expect, it } from 'vitest';
import { RoomMetricsRegistry } from './RoomMetricsRegistry';

describe('RoomMetricsRegistry', () => {
  it('활성 Room·인원·틱·RTT·AOI 전송량·오류를 제한된 표본으로 제공한다', () => {
    let now = 1_000;
    const metrics = new RoomMetricsRegistry({ now: () => now });
    metrics.register('room-a', 'v1');
    metrics.observeTick('room-a', 2, 3, 1);
    metrics.observeTick('room-a', 8, 3, 1);
    metrics.observeTick('room-a', 4, 3, 1);
    metrics.reportRtt('room-a', 'a', 40);
    metrics.reportRtt('room-a', 'b', 60);
    metrics.observeSnapshot('room-a', 100, 8);
    metrics.observeSnapshot('room-a', 300, 20);
    metrics.recordError('room-a');
    const snapshot = metrics.snapshot();
    expect(snapshot).toMatchObject({ activeRooms: 1, humans: 3, bots: 1 });
    expect(snapshot.rooms[0]).toMatchObject({
      tickLastMs: 4, tickP95Ms: 8, averageRttMs: 50, snapshotP95Bytes: 300,
      aoiEntitiesP95: 20, outboundBytesPerSecond: 400, errorCount: 1, errorRate: 1 / 3,
    });
    now = 2_001;
    expect(metrics.snapshot().rooms[0]!.outboundBytesPerSecond).toBe(0);
    metrics.unregister('room-a');
    expect(metrics.snapshot().activeRooms).toBe(0);
  });

  it('drain은 각 Room에 한 번만 전달하며 상태에 노출한다', async () => {
    let calls = 0;
    const metrics = new RoomMetricsRegistry();
    metrics.register('room-a', 'v1', async () => { calls++; });
    expect(await metrics.drain('missing')).toBe(false);
    expect(await metrics.drain('room-a')).toBe(true);
    expect(await metrics.drain('room-a')).toBe(true);
    expect(calls).toBe(1);
    expect(metrics.snapshot().rooms[0]!.draining).toBe(true);
  });

  it('tick P99가 임계값을 지속 초과하면 Room을 자동 drain한다', async () => {
    let now = 0;
    let calls = 0;
    const metrics = new RoomMetricsRegistry({ tickDrainP99Ms: 10, tickDrainSustainMs: 1_000, now: () => now });
    metrics.register('room-a', 'v1', async () => { calls++; });
    metrics.observeTick('room-a', 20, 1, 0);
    now = 999;
    metrics.observeTick('room-a', 20, 1, 0);
    await Promise.resolve();
    expect(calls).toBe(0);
    now = 1_000;
    metrics.observeTick('room-a', 20, 1, 0);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(metrics.snapshot().rooms[0]!.draining).toBe(true);
  });

  it('지속 tick·RTT·스냅샷·오류율·결과 backlog를 조치 가능한 등급 경보로 집계한다', () => {
    let now = 0;
    const metrics = new RoomMetricsRegistry({
      now: () => now, tickAlertP99Ms: 10, tickAlertSustainMs: 1_000, rttAlertP95Ms: 100,
      errorRateAlert: 0.1, snapshotAlertP95Bytes: 1_000, resultBacklog: () => 7, resultBacklogAlert: 5,
    });
    metrics.register('room-a', 'v1');
    for (let i = 0; i < 20; i += 1) {
      metrics.observeTick('room-a', 20, 1, 0);
      if (i < 4) metrics.recordError('room-a');
    }
    metrics.reportRtt('room-a', 'slow-a', 150);
    metrics.reportRtt('room-a', 'slow-b', 200);
    metrics.observeSnapshot('room-a', 1_200, 10);
    now = 1_000;
    metrics.observeTick('room-a', 20, 1, 0);
    const alerts = metrics.snapshot().alerts;
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'P1', code: 'tick_budget_exceeded', roomId: 'room-a' }),
      expect.objectContaining({ severity: 'P2', code: 'high_rtt', roomId: 'room-a' }),
      expect.objectContaining({ severity: 'P2', code: 'snapshot_budget_exceeded', roomId: 'room-a' }),
      expect.objectContaining({ severity: 'P3', code: 'high_error_rate', roomId: 'room-a' }),
      expect.objectContaining({ severity: 'P2', code: 'result_backlog' }),
    ]));
    expect(metrics.snapshot().rooms[0]!.rttP95Ms).toBe(200);
  });
});
