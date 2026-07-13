import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Server } from 'colyseus';
import { ArenaRoom } from './rooms/ArenaRoom';
import { RoomMetricsRegistry } from './ops/RoomMetricsRegistry';
import { loadRuntimeConfig } from './runtimeConfig';
import { snapshotProcessMetrics } from './ops/ProcessMetrics';
import { EventLoopDrainGuard } from './ops/EventLoopDrainGuard';
import { renderPrometheusMetrics } from './ops/PrometheusMetrics';
import { RoomRegistryPublisher } from './ops/RoomRegistryPublisher';

const port = Number(process.env.PORT ?? 2567);
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const positiveEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const metrics = new RoomMetricsRegistry({
  tickDrainP99Ms: positiveEnv('SERPENT_TICK_DRAIN_P99_MS', 80),
  tickDrainSustainMs: positiveEnv('SERPENT_TICK_DRAIN_SUSTAIN_MS', 5 * 60_000),
  tickAlertP99Ms: positiveEnv('SERPENT_TICK_ALERT_P99_MS', 45),
  tickAlertSustainMs: positiveEnv('SERPENT_TICK_ALERT_SUSTAIN_MS', 5 * 60_000),
  snapshotAlertP95Bytes: positiveEnv('SERPENT_SNAPSHOT_ALERT_P95_BYTES', 4 * 1024),
  resultBacklogAlert: positiveEnv('SERPENT_RESULT_BACKLOG_ALERT', 100),
  resultBacklog: () => ArenaRoom.resultBacklogSize(),
});
const eventLoopGuard = new EventLoopDrainGuard({
  thresholdMs: positiveEnv('SERPENT_EVENT_LOOP_DRAIN_P99_MS', 80),
  sustainMs: positiveEnv('SERPENT_EVENT_LOOP_DRAIN_SUSTAIN_MS', 5 * 60_000),
});
let processHealth = eventLoopGuard.observe(0);
let shuttingDown = false;
let registryPublisher: RoomRegistryPublisher | undefined;
let registryCapacity = positiveEnv('SERPENT_ROOM_CAPACITY', 60);
const observeProcessHealth = (): void => {
  const processMetrics = snapshotProcessMetrics(process.memoryUsage(), eventLoopDelay.percentile(99));
  processHealth = eventLoopGuard.observe(processMetrics.eventLoopLagP99Ms);
  if (processHealth.draining) void metrics.drainAll();
  // 다음 관측 구간의 P99가 이전 spike에 고정되지 않도록 한다.
  eventLoopDelay.reset();
};
const processHealthTimer = setInterval(observeProcessHealth, 5_000);
processHealthTimer.unref();
const adminSecret = process.env.SERPENT_ADMIN_SECRET;
const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    const status = processHealth.draining || shuttingDown ? 503 : 200;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: status === 200, draining: processHealth.draining || shuttingDown }));
    return;
  }
  if (!req.url?.startsWith('/ops/')) return;
  if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'forbidden' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/ops/metrics') {
    const roomMetrics = metrics.snapshot();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ...roomMetrics,
      alerts: processHealth.alert ? [...roomMetrics.alerts, processHealth.alert] : roomMetrics.alerts,
      process: { ...snapshotProcessMetrics(process.memoryUsage(), eventLoopDelay.percentile(99)), draining: processHealth.draining },
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/ops/prometheus') {
    const roomMetrics = metrics.snapshot();
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderPrometheusMetrics(roomMetrics, snapshotProcessMetrics(process.memoryUsage(), eventLoopDelay.percentile(99))));
    return;
  }
  if (req.method === 'POST' && req.url === '/ops/drain') {
    void metrics.drainAll().then((drained) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ drained }));
    });
    return;
  }
  const roomMatch = req.url.match(/^\/ops\/rooms\/([^/]+)\/drain$/);
  if (req.method === 'POST' && roomMatch) {
    void metrics.drain(decodeURIComponent(roomMatch[1]!)).then((drained) => {
      res.writeHead(drained ? 202 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(drained ? { drained: 1 } : { code: 'not_found' }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'not_found' }));
});
const gameServer = new Server({ server: httpServer });

// E2E/개발용 아레나 크기 오버라이드 — SERPENT_ALLOW_ROOM_OPTIONS=1 과 함께 쓸 때만 반영
const arenaSize = Number(process.env.SERPENT_ARENA_SIZE ?? 0);
loadRuntimeConfig()
  .then((runtimeConfig) => {
    registryCapacity = runtimeConfig.room.maxPlayers;
    gameServer.define('arena', ArenaRoom, {
      runtimeConfig: arenaSize > 0
        ? { ...runtimeConfig, arena: { ...runtimeConfig.arena, width: arenaSize, height: arenaSize } }
        : runtimeConfig,
      metrics,
    });
    return gameServer.listen(port);
  })
  .then(() => {
    const redisUrl = process.env.REDIS_URL;
    const endpoint = process.env.SERPENT_PUBLIC_GAME_ENDPOINT ?? process.env.SERPENT_GAME_ENDPOINT;
    if (redisUrl && endpoint) {
      registryPublisher = new RoomRegistryPublisher({
        url: redisUrl,
        instanceId: process.env.SERPENT_INSTANCE_ID ?? `game-${process.pid}`,
        region: process.env.SERPENT_REGION ?? 'local', endpoint, roomName: 'arena',
        capacity: registryCapacity, modes: ['classic'], metrics,
        isDraining: () => processHealth.draining || shuttingDown,
      });
      return registryPublisher.start().then(() => {
        const timer = setInterval(() => void registryPublisher?.publish().catch((error) => console.error('[room-registry] publish failed', error)), 5_000);
        timer.unref();
      }).catch((error) => {
        // Redis가 내려가도 이미 listen 중인 Room은 계속 플레이한다. heartbeat가 없으므로
        // API는 이 인스턴스에 새 매치를 보내지 않는다.
        console.error('[room-registry] initial publish failed; new matching stays stopped', error);
        registryPublisher = undefined;
      });
    }
    return undefined;
  })
  .then(() => {
    console.log(`[game-server] listening on ws://0.0.0.0:${port}`);
  })
  .catch((err) => {
    console.error('[game-server] failed to start', err);
    process.exit(1);
  });

/**
 * Kubernetes termination: 먼저 readiness를 내리고 모든 Room을 drain한 뒤 새 연결을
 * 차단한다. 무한 경기 Room을 영구 대기하지 않도록 deployment grace보다 짧은 상한을 둔다.
 */
const shutdownDrainTimeoutMs = positiveEnv('SERPENT_SHUTDOWN_DRAIN_TIMEOUT_MS', 110_000);
const gracefulShutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[game-server] shutdown: draining rooms before termination');
  await metrics.drainAll();
  await registryPublisher?.stop();
  // 신규 TCP/WSS 연결을 즉시 차단한다. 활성 Room의 WebSocket은 남아 drain 동안
  // 계속 진행하며, 활성 Room이 없으면 프로세스는 곧바로 종료된다.
  httpServer.close();
  const forceExit = setTimeout(() => process.exit(0), shutdownDrainTimeoutMs);
  forceExit.unref();
};
// 개발/테스트에서 SIGTERM은 즉시 종료가 기대되므로 production 배포에서만 opt-in한다.
if (process.env.SERPENT_GRACEFUL_SHUTDOWN === '1') {
  process.once('SIGTERM', () => void gracefulShutdown());
  process.once('SIGINT', () => void gracefulShutdown());
}
