import { createClient } from 'redis';
import { RedisRateLimiter } from './rateLimit';

const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is required');

const client = createClient({ url });
await client.connect();
const limiter = new RedisRateLimiter(client);
const key = `smoke-${Date.now()}`;

try {
  const rule = { scope: 'smoke', key, limit: 2, windowMs: 10_000 };
  if (!(await limiter.consume([rule])) || !(await limiter.consume([rule])) || await limiter.consume([rule])) {
    throw new Error('Redis rate limit did not enforce the configured quota');
  }
  console.log('[redis-smoke] shared atomic counter OK');
} finally {
  await limiter.close();
}
