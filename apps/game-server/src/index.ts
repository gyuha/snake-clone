import { Server } from 'colyseus';
import { ArenaRoom } from './rooms/ArenaRoom';

const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server();
gameServer.define('arena', ArenaRoom);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[game-server] listening on ws://0.0.0.0:${port}`);
  })
  .catch((err) => {
    console.error('[game-server] failed to start', err);
    process.exit(1);
  });
