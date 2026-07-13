/**
 * 통합 스모크 (loop.md C10): api + game-server 기동 →
 * 게스트 생성 → 매치 티켓 → joinToken 입장 → welcome/전진 snapshot →
 * 운영 drain(기존 경기 유지·동일 Room 신규 입장 거부) → 경계 사망 →
 * result 수신 → api 전적 저장 확인 → exit 0.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const GAME_PORT = process.env.SMOKE_PORT ?? '2599';
const API_PORT = process.env.SMOKE_API_PORT ?? '8599';
const API = `http://127.0.0.1:${API_PORT}`;
const ADMIN_SECRET = 'smoke-admin-secret';
const TIMEOUT_MS = 90_000;
const deadline = Date.now() + TIMEOUT_MS;

const children = [];
let output = '';

function spawnService(name, args, env) {
  const child = spawn('pnpm', args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (output += `[${name}] ${d}`));
  child.stderr.on('data', (d) => (output += `[${name}!] ${d}`));
  children.push(child);
  return child;
}

function shutdown(code, message) {
  if (message) console.log(message);
  if (code !== 0) {
    console.error('--- service output ---');
    console.error(output.slice(-4000));
  }
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

async function waitFor(predicate, what) {
  while (!predicate()) {
    if (Date.now() > deadline) {
      shutdown(1, `[smoke] FAIL: timeout waiting for ${what}`);
      await delay(2000);
    }
    await delay(150);
  }
}

// ── 서비스 기동 ─────────────────────────────────────────────────────────
spawnService('api', ['--filter', '@serpent/api', 'start'], { API_PORT });
spawnService('game', ['--filter', '@serpent/game-server', 'start'], {
  PORT: GAME_PORT,
  SERPENT_REQUIRE_JOIN_TOKEN: '1',
  SERPENT_API_URL: API,
  SERPENT_ADMIN_SECRET: ADMIN_SECRET,
});

await waitFor(() => output.includes('[api] listening'), 'api boot');
await waitFor(() => output.includes('[game-server] listening'), 'game-server boot');

try {
  // ── 게스트 → 티켓 ──────────────────────────────────────────────────────
  const guest = await (await fetch(`${API}/v1/auth/guest`, { method: 'POST' })).json();
  if (!guest.accessToken) throw new Error('guest creation failed');
  console.log(`[smoke] guest ${guest.userId}`);

  const ticket = await (
    await fetch(`${API}/v1/matches/tickets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${guest.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'classic' }),
    })
  ).json();
  if (!ticket.joinToken) throw new Error('ticket issue failed');
  console.log(`[smoke] ticket ${ticket.ticketId} → ${ticket.roomName}`);

  // ── joinToken 입장 ─────────────────────────────────────────────────────
  const { Client } = await import('colyseus.js');
  const client = new Client(`ws://127.0.0.1:${GAME_PORT}`);
  const room = await client.joinOrCreate('arena', { joinToken: ticket.joinToken });
  console.log(`[smoke] joined room ${room.roomId} as ${room.sessionId}`);

  let welcome = null;
  const snapshots = [];
  let result = null;
  const events = [];
  room.onMessage('welcome', (m) => (welcome = m));
  room.onMessage('snapshot', (m) => snapshots.push(m));
  room.onMessage('result', (m) => (result = m));
  room.onMessage('event', (event) => events.push(event));
  room.onMessage('pong', () => {});
  room.onMessage('leaderboard', () => {});

  await waitFor(() => welcome && snapshots.length >= 3, 'welcome + snapshots');
  const checks = [
    [welcome.playerId === room.sessionId, 'welcome.playerId == sessionId'],
    [welcome.tickRate === 20, 'welcome.tickRate == 20'],
    [welcome.pellets.length > 0, 'welcome has AOI pellet baseline'],
    [snapshots[1].tickId > snapshots[0].tickId, 'snapshot tickId advances'],
    [snapshots.some((s) => s.snakes.some((p) => p.id === room.sessionId)), 'snapshot contains self delta'],
  ];
  const failed = checks.filter(([ok]) => !ok);
  if (failed.length > 0) throw new Error(`checks failed: ${failed.map(([, n]) => n).join(', ')}`);
  console.log(`[smoke] welcome/snapshot ok (pellets ${welcome.pellets.length})`);

  // ── 배포 drain 리허설: 현재 경기는 유지, 동일 Room 신규 입장은 차단 ──────
  const tickBeforeDrain = snapshots.at(-1).tickId;
  const drainResponse = await fetch(`http://127.0.0.1:${GAME_PORT}/ops/drain`, {
    method: 'POST', headers: { 'x-admin-secret': ADMIN_SECRET },
  });
  if (drainResponse.status !== 202) throw new Error(`drain request failed (${drainResponse.status})`);
  await waitFor(() => events.some((event) => event?.type === 'notice'), 'drain maintenance notice');
  await waitFor(() => snapshots.some((snapshot) => snapshot.tickId > tickBeforeDrain), 'current game continues after drain');

  const nextGuest = await (await fetch(`${API}/v1/auth/guest`, { method: 'POST' })).json();
  const nextTicket = await (await fetch(`${API}/v1/matches/tickets`, {
    method: 'POST', headers: { authorization: `Bearer ${nextGuest.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'classic' }),
  })).json();
  const blockedClient = new Client(`ws://127.0.0.1:${GAME_PORT}`);
  let blocked = false;
  try { await blockedClient.joinById(room.roomId, { joinToken: nextTicket.joinToken }); } catch { blocked = true; }
  if (!blocked) throw new Error('draining room accepted a new join');
  console.log('[smoke] drain ok: notice delivered, current snapshots advance, same Room blocks new join');

  // ── 가장 가까운 경계로 돌진 → 사망 → result ───────────────────────────
  const self = welcome.players.find((p) => p.id === room.sessionId);
  const { width, height } = welcome.arena;
  const candidates = [
    { dirX: -1, dirY: 0, dist: self.x },
    { dirX: 1, dirY: 0, dist: width - self.x },
    { dirX: 0, dirY: -1, dist: self.y },
    { dirX: 0, dirY: 1, dist: height - self.y },
  ].sort((a, b) => a.dist - b.dist);
  const dir = candidates[0];
  console.log(`[smoke] driving to boundary (${Math.round(dir.dist)}u away)`);
  let seq = 0;
  const driver = setInterval(() => {
    room.send('input', { seq: ++seq, dirX: dir.dirX, dirY: dir.dirY, boost: false });
  }, 50);
  await waitFor(() => result !== null, 'death result');
  clearInterval(driver);
  console.log(`[smoke] died: reason=${result.reason} score=${result.score} rank=${result.rank}`);

  // ── api 전적 저장 확인 (matchId 멱등 파이프) ───────────────────────────
  let stats = null;
  await waitFor(() => {
    fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${guest.accessToken}` } })
      .then((r) => r.json())
      .then((me) => (stats = me.stats))
      .catch(() => {});
    return stats && stats.games >= 1;
  }, 'result persisted to api');
  console.log(`[smoke] stats: games=${stats.games} bestScore=${stats.bestScore}`);

  await room.leave();
  shutdown(0, '[smoke] PASS: guest → ticket → token join → drain rehearsal → play → death → result persisted');
} catch (err) {
  shutdown(1, `[smoke] FAIL: ${err?.message ?? err}`);
}
