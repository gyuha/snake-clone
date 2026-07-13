import { buildApi } from './server';

const port = Number(process.env.API_PORT ?? 8080);
const { app } = buildApi();

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[api] listening on http://0.0.0.0:${port}`))
  .catch((err) => {
    console.error('[api] failed to start', err);
    process.exit(1);
  });
