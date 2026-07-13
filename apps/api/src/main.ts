import { buildApi } from './server';
import { createReposFromEnv } from './postgres';
import { createRateLimiterFromEnv } from './rateLimit';
import { createMatchTargetDirectoryFromEnv } from './roomRegistry';

const port = Number(process.env.API_PORT ?? 8080);
const { repos, close } = await createReposFromEnv();
const rateLimiter = await createRateLimiterFromEnv();
const matchTargetDirectory = await createMatchTargetDirectoryFromEnv(process.env.SERPENT_GAME_ENDPOINT ?? 'ws://localhost:2567');
const { app } = buildApi({ repos, rateLimiter, matchTargets: matchTargetDirectory.targets });

const shutdown = async () => {
  await app.close();
  await close();
  await rateLimiter.close();
  await matchTargetDirectory.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[api] listening on http://0.0.0.0:${port}`))
  .catch((err) => {
    console.error('[api] failed to start', err);
    process.exit(1);
  });
