/** PostgreSQL repository contract smoke test. Requires DATABASE_URL. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPostgresRepos, ensurePostgresSchema } from './postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: url });
try {
  await ensurePostgresSchema(pool);
  const repos = createPostgresRepos(pool);
  const userId = `smoke-${randomUUID()}`;
  await repos.users.createGuest(userId, Date.now());
  await repos.users.setNickname(userId, 'PgSmoke');
  const saved = await repos.matches.save({
    matchId: `smoke-${randomUUID()}`, userId, score: 123, rank: 1,
    lengthAtDeath: 200, survivalMs: 3_000, kills: 2, reason: 'boundary', endedAt: Date.now(),
  });
  if (!saved || !(await repos.matches.statsOf(userId)).games) throw new Error('match persistence failed');
  const leaderboard = await repos.leaderboard.top(10, Date.now() - 60_000);
  if (!leaderboard.some((entry) => entry.userId === userId && entry.score === 123)) throw new Error('scoped leaderboard failed');
  if (!(await repos.cosmetics.setSelectedSkinId(userId, 3))) throw new Error('loadout persistence failed');
  if ((await repos.cosmetics.selectedSkinId(userId)) !== 3) throw new Error('loadout read failed');
  if ((await repos.identities.link(userId, 'email', `smoke-${randomUUID()}`)) !== 'linked') throw new Error('identity persistence failed');
  console.log('[postgres-smoke] PASS: users, results, scoped leaderboard, loadout, identity');
} finally {
  await pool.end();
}
