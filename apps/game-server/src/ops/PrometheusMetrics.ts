import type { ProcessMetrics } from './ProcessMetrics';
import type { RoomMetrics } from './RoomMetricsRegistry';

export interface PrometheusSnapshot {
  activeRooms: number;
  humans: number;
  bots: number;
  rooms: RoomMetrics[];
}

const metric = (name: string, help: string, type: 'gauge' | 'counter' = 'gauge') => `# HELP ${name} ${help}\n# TYPE ${name} ${type}`;
const labels = (values: Record<string, string>) => `{${Object.entries(values).map(([key, value]) => `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}`;

/** Prometheus text exposition. 게임 판정과 분리된 scrape 시점의 관측값만 직렬화한다. */
export function renderPrometheusMetrics(snapshot: PrometheusSnapshot, process: ProcessMetrics): string {
  const lines = [
    metric('serpent_game_active_rooms', 'Active Colyseus rooms'), `serpent_game_active_rooms ${snapshot.activeRooms}`,
    metric('serpent_game_active_players', 'Human players in active rooms'), `serpent_game_active_players ${snapshot.humans}`,
    metric('serpent_game_active_bots', 'Bots in active rooms'), `serpent_game_active_bots ${snapshot.bots}`,
    metric('serpent_process_rss_bytes', 'Node process resident memory'), `serpent_process_rss_bytes ${process.rssBytes}`,
    metric('serpent_process_heap_used_bytes', 'Node process heap used'), `serpent_process_heap_used_bytes ${process.heapUsedBytes}`,
    metric('serpent_event_loop_lag_p99_milliseconds', 'Node event loop lag P99'), `serpent_event_loop_lag_p99_milliseconds ${process.eventLoopLagP99Ms}`,
    metric('serpent_room_tick_p99_milliseconds', 'Room simulation tick P99'),
    metric('serpent_room_rtt_p95_milliseconds', 'Room reported RTT P95'),
    metric('serpent_room_snapshot_p95_bytes', 'Room snapshot payload P95'),
    metric('serpent_room_outbound_bytes_per_second', 'Room outbound snapshot bytes per second'),
  ];
  for (const room of snapshot.rooms) {
    const roomLabels = labels({ room_id: room.roomId, config_version: room.configVersion });
    lines.push(
      `serpent_room_tick_p99_milliseconds${roomLabels} ${room.tickP99Ms}`,
      `serpent_room_snapshot_p95_bytes${roomLabels} ${room.snapshotP95Bytes}`,
      `serpent_room_outbound_bytes_per_second${roomLabels} ${room.outboundBytesPerSecond}`,
    );
    if (room.rttP95Ms !== null) lines.push(`serpent_room_rtt_p95_milliseconds${roomLabels} ${room.rttP95Ms}`);
  }
  return `${lines.join('\n')}\n`;
}
