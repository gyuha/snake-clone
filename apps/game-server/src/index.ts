import { Server } from 'colyseus';
import { ArenaRoom } from './rooms/ArenaRoom';

const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server();

// E2E/개발용 아레나 크기 오버라이드 — SERPENT_ALLOW_ROOM_OPTIONS=1 과 함께 쓸 때만 반영
const arenaSize = Number(process.env.SERPENT_ARENA_SIZE ?? 0);
gameServer.define(
  'arena',
  ArenaRoom,
  arenaSize > 0
    ? { config: { arena: { width: arenaSize, height: arenaSize, boundary: 'lethal' as const } } }
    : undefined,
);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[game-server] listening on ws://0.0.0.0:${port}`);
  })
  .catch((err) => {
    console.error('[game-server] failed to start', err);
    process.exit(1);
  });
