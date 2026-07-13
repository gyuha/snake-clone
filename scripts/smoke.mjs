/**
 * 스모크 테스트 (loop.md C8): game-server 기동 → colyseus.js로 arena 접속 →
 * welcome 수신 → tickId가 전진하는 snapshot 수신 → 정상 종료 시 exit 0.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.SMOKE_PORT ?? '2599';
const TIMEOUT_MS = 30_000;

const child = spawn('pnpm', ['--filter', '@serpent/game-server', 'start'], {
  env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
child.stdout.on('data', (d) => {
  serverOutput += d.toString();
});
child.stderr.on('data', (d) => {
  serverOutput += d.toString();
});

function shutdown(code, message) {
  if (message) console.log(message);
  if (code !== 0) {
    console.error('--- server output ---');
    console.error(serverOutput);
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

const deadline = Date.now() + TIMEOUT_MS;

while (!serverOutput.includes('listening')) {
  if (Date.now() > deadline) {
    shutdown(1, '[smoke] FAIL: server did not start within timeout');
    await delay(1000);
  }
  await delay(200);
}

try {
  const { Client } = await import('colyseus.js');
  const client = new Client(`ws://127.0.0.1:${PORT}`);
  const room = await client.joinOrCreate('arena');
  console.log(`[smoke] joined room ${room.roomId} as ${room.sessionId}`);

  let welcome = null;
  const snapshots = [];
  room.onMessage('welcome', (m) => {
    welcome = m;
  });
  room.onMessage('snapshot', (m) => snapshots.push(m));
  room.onMessage('event', () => {});
  room.onMessage('result', () => {});

  while (!welcome || snapshots.length < 3) {
    if (Date.now() > deadline) {
      shutdown(1, `[smoke] FAIL: welcome=${Boolean(welcome)} snapshots=${snapshots.length} within timeout`);
      await delay(1000);
    }
    await delay(100);
  }

  const checks = [
    [welcome.playerId === room.sessionId, 'welcome.playerId == sessionId'],
    [welcome.tickRate === 20, 'welcome.tickRate == 20'],
    [Array.isArray(welcome.pellets) && welcome.pellets.length > 0, 'welcome has pellet baseline (AOI)'],
    [snapshots[1].tickId > snapshots[0].tickId, 'snapshot tickId advances'],
    [snapshots.some((s) => s.snakes.some((p) => p.id === room.sessionId)), 'snapshot contains self delta'],
  ];
  const failed = checks.filter(([ok]) => !ok);
  if (failed.length > 0) {
    shutdown(1, `[smoke] FAIL: ${failed.map(([, name]) => name).join(', ')}`);
  } else {
    console.log(
      `[smoke] welcome ok (tickRate ${welcome.tickRate}, pellets ${welcome.pellets.length}), snapshots tick ${snapshots[0].tickId}→${snapshots[snapshots.length - 1].tickId}`,
    );
    await room.leave();
    shutdown(0, '[smoke] PASS: boot + join + welcome + advancing snapshots OK');
  }
} catch (err) {
  shutdown(1, `[smoke] FAIL: ${err?.message ?? err}`);
}
