import { createHash } from 'node:crypto';
import { createClient } from 'redis';

export interface RateLimitRule {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
  cost?: number;
}

/**
 * A small common interface lets unit tests and single-process development use
 * the same limits as production, while Redis makes the counters shared across
 * API instances.
 */
export interface RateLimiter {
  consume(rules: RateLimitRule[]): Promise<boolean>;
  close(): Promise<void>;
}

interface Counter {
  count: number;
  expiresAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(rules: RateLimitRule[]): Promise<boolean> {
    const timestamp = this.now();
    const requested = rules.map((rule) => ({ ...rule, cost: rule.cost ?? 1 }));
    for (const rule of requested) {
      const id = `${rule.scope}:${rule.key}`;
      const existing = this.counters.get(id);
      const count = existing && existing.expiresAt > timestamp ? existing.count : 0;
      if (count + rule.cost! > rule.limit) return false;
    }
    for (const rule of requested) {
      const id = `${rule.scope}:${rule.key}`;
      const existing = this.counters.get(id);
      const active = existing && existing.expiresAt > timestamp ? existing : undefined;
      this.counters.set(id, {
        count: (active?.count ?? 0) + rule.cost!,
        expiresAt: active?.expiresAt ?? timestamp + rule.windowMs,
      });
    }
    return true;
  }

  async close(): Promise<void> {}
}

const CONSUME_MANY_SCRIPT = `
for i = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  local cost = tonumber(ARGV[(i - 1) * 3 + 1])
  local limit = tonumber(ARGV[(i - 1) * 3 + 2])
  if current + cost > limit then return 0 end
end
for i = 1, #KEYS do
  local cost = tonumber(ARGV[(i - 1) * 3 + 1])
  local window = tonumber(ARGV[(i - 1) * 3 + 3])
  local next = redis.call('INCRBY', KEYS[i], cost)
  if next == cost then redis.call('PEXPIRE', KEYS[i], window) end
end
return 1
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly client: ReturnType<typeof createClient>) {}

  async consume(rules: RateLimitRule[]): Promise<boolean> {
    if (rules.length === 0) return true;
    const result = await this.client.eval(CONSUME_MANY_SCRIPT, {
      keys: rules.map((rule) => this.redisKey(rule.scope, rule.key)),
      arguments: rules.flatMap((rule) => [String(rule.cost ?? 1), String(rule.limit), String(rule.windowMs)]),
    });
    return result === 1;
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }

  private redisKey(scope: string, key: string): string {
    // Do not leave raw IP addresses or user IDs visible in shared Redis keys.
    const digest = createHash('sha256').update(key).digest('hex');
    return `serpent:rate:${scope}:${digest}`;
  }
}

export async function createRateLimiterFromEnv(): Promise<RateLimiter> {
  const url = process.env.REDIS_URL;
  if (!url) return new InMemoryRateLimiter();
  const client = createClient({ url });
  await client.connect();
  return new RedisRateLimiter(client);
}
