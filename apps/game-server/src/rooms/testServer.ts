import { Server } from 'colyseus';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import type { Room } from 'colyseus.js';
import { ArenaRoom } from './ArenaRoom';

/** 테스트 서버 부트 — 실제 WS transport를 통해 검증한다 */
export async function bootArenaServer(): Promise<ColyseusTestServer> {
  process.env.SERPENT_ALLOW_ROOM_OPTIONS = '1'; // 테스트에서만 설정 오버라이드 허용
  const gameServer = new Server({ greet: false });
  gameServer.define('arena', ArenaRoom);
  return boot(gameServer);
}

export interface Collected {
  welcome: unknown[];
  snapshot: unknown[];
  event: unknown[];
  result: unknown[];
  pong: unknown[];
  leaderboard: unknown[];
}

/** 클라이언트 룸의 모든 프로토콜 메시지를 수집한다 */
export function collectMessages(room: Room): Collected {
  const collected: Collected = {
    welcome: [],
    snapshot: [],
    event: [],
    result: [],
    pong: [],
    leaderboard: [],
  };
  room.onMessage('welcome', (m) => collected.welcome.push(m));
  room.onMessage('snapshot', (m) => collected.snapshot.push(m));
  room.onMessage('event', (m) => collected.event.push(m));
  room.onMessage('result', (m) => collected.result.push(m));
  room.onMessage('pong', (m) => collected.pong.push(m));
  room.onMessage('leaderboard', (m) => collected.leaderboard.push(m));
  return collected;
}

/** 조건이 참이 될 때까지 폴링 */
export async function until(fn: () => boolean, timeoutMs = 10_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
