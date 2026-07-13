import { describe, expect, it } from 'vitest';
import { renderPrometheusMetrics } from './PrometheusMetrics';

describe('Prometheus metrics exposition', () => {
  it('프로세스와 Room P99/RTT/전송량을 scrape 가능한 gauge로 출력한다', () => {
    const text = renderPrometheusMetrics({ activeRooms: 1, humans: 2, bots: 1, rooms: [{ roomId: 'a"b', configVersion: 'v1', humans: 2, bots: 1, tickLastMs: 2, tickP95Ms: 3, tickP99Ms: 4, averageRttMs: 5, rttP95Ms: 6, snapshotP95Bytes: 7, aoiEntitiesP95: 8, outboundBytesPerSecond: 9, errorCount: 0, errorRate: 0, draining: false }] }, { rssBytes: 10, heapUsedBytes: 11, heapTotalBytes: 12, externalBytes: 13, eventLoopLagP99Ms: 14 });
    expect(text).toContain('serpent_game_active_rooms 1');
    expect(text).toContain('serpent_event_loop_lag_p99_milliseconds 14');
    expect(text).toContain('room_id="a\\"b"');
    expect(text).toContain('serpent_room_rtt_p95_milliseconds{room_id="a\\"b",config_version="v1"} 6');
  });
});
