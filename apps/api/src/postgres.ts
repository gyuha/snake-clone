import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { defaultGameConfig, type GameConfig } from '@serpent/config';
import { defaultFeatureFlags, selectConfigRevision } from './repos';
import type {
  AnnouncementRepo, AuditRepo, ConfigRepo, ConfigRevision, CosmeticRepo, FriendRepo, IdentityRepo, LeaderboardRepo, LiveEventRepo, MatchRepo, MatchResult, SeasonRepo,
  MissionRepo, PlayerReport, ReportRepo, Repos, TelemetryRepo, TokenRevocationRepo, User, UserRepo, FeatureFlagRepo, FeatureFlags, StorageMetricsRepo,
} from './repos';

/** Additive local schema migration. Production should run the same DDL through a migration runner. */
export async function ensurePostgresSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, nickname TEXT, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
      banned_until BIGINT, ban_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS match_results (
      match_id TEXT NOT NULL, user_id TEXT NOT NULL, score DOUBLE PRECISION NOT NULL,
      rank INTEGER NOT NULL, length_at_death DOUBLE PRECISION NOT NULL, survival_ms BIGINT NOT NULL,
      kills INTEGER NOT NULL, reason TEXT NOT NULL, ended_at BIGINT NOT NULL,
      PRIMARY KEY (match_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS match_results_user_idx ON match_results (user_id);
    CREATE TABLE IF NOT EXISTS loadouts (user_id TEXT PRIMARY KEY, skin_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS owned_skins (user_id TEXT NOT NULL, skin_id INTEGER NOT NULL, PRIMARY KEY (user_id, skin_id));
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
      PRIMARY KEY (provider, subject)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, reporter_user_id TEXT NOT NULL, target_user_id TEXT, reason TEXT NOT NULL,
      detail TEXT, ip TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_rate_idx ON reports (reporter_user_id, ip, created_at);
    CREATE TABLE IF NOT EXISTS token_revocations (fingerprint TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS config_revisions (
      revision_id BIGSERIAL PRIMARY KEY, version TEXT NOT NULL, activated_at BIGINT NOT NULL, config JSONB NOT NULL, rollout_percent INTEGER NOT NULL DEFAULT 100
    );
    CREATE TABLE IF NOT EXISTS feature_flags (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), flags JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS telemetry_events (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, client_time BIGINT,
      properties JSONB NOT NULL, ip TEXT NOT NULL, received_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telemetry_rate_idx ON telemetry_events (user_id, ip, received_at);
    CREATE TABLE IF NOT EXISTS user_missions (user_id TEXT, mission_id TEXT, period TEXT, progress INTEGER NOT NULL, claimed BOOLEAN NOT NULL, PRIMARY KEY(user_id, mission_id, period));
    CREATE TABLE IF NOT EXISTS current_announcement (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton), message TEXT NOT NULL, updated_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS friendships (user_id TEXT NOT NULL, friend_user_id TEXT NOT NULL, PRIMARY KEY (user_id, friend_user_id));
    CREATE TABLE IF NOT EXISTS live_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL, target_regions JSONB NOT NULL DEFAULT '[]'::jsonb);
    CREATE TABLE IF NOT EXISTS seasons (id TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at BIGINT NOT NULL, ends_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS season_progress (user_id TEXT NOT NULL, season_id TEXT NOT NULL, matches INTEGER NOT NULL, PRIMARY KEY (user_id, season_id));
    CREATE TABLE IF NOT EXISTS season_claims (user_id TEXT NOT NULL, season_id TEXT NOT NULL, level INTEGER NOT NULL, PRIMARY KEY (user_id, season_id, level));
    CREATE TABLE IF NOT EXISTS admin_audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, created_at BIGINT NOT NULL);
  `);
  await pool.query('ALTER TABLE config_revisions ADD COLUMN IF NOT EXISTS rollout_percent INTEGER NOT NULL DEFAULT 100');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at BIGINT');
  await pool.query('UPDATE users SET last_seen_at = created_at WHERE last_seen_at IS NULL');
  await pool.query('ALTER TABLE users ALTER COLUMN last_seen_at SET NOT NULL');
  await pool.query(`ALTER TABLE live_events ADD COLUMN IF NOT EXISTS target_regions JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`INSERT INTO feature_flags (singleton, flags) SELECT TRUE, $1::jsonb WHERE NOT EXISTS (SELECT 1 FROM feature_flags)`, [JSON.stringify(defaultFeatureFlags)]);
  await pool.query(
    `INSERT INTO config_revisions (version, activated_at, config, rollout_percent)
     SELECT $1, 0, $2::jsonb, 100
     WHERE NOT EXISTS (SELECT 1 FROM config_revisions)`,
    [defaultGameConfig.version, JSON.stringify(defaultGameConfig)],
  );
}

const basicSkinIds = Array.from({ length: 8 }, (_, id) => id);
const unlockableSkinIds = new Set([8, 9, 10, 11, 12]);
const userFromRow = (row: Record<string, unknown>): User => ({
  id: String(row.id), type: row.type === 'account' ? 'account' : 'guest',
  nickname: row.nickname === null ? null : String(row.nickname), createdAt: Number(row.created_at),
  lastSeenAt: Number(row.last_seen_at),
  bannedUntil: row.banned_until === null ? null : Number(row.banned_until),
  banReason: row.ban_reason === null ? null : String(row.ban_reason),
});
const revisionFromRow = (row: Record<string, unknown>): ConfigRevision => ({
  version: String(row.version), activatedAt: Number(row.activated_at), config: row.config as GameConfig,
  rolloutPercent: Number(row.rollout_percent ?? 100),
});

/** PostgreSQL-backed implementation of every API repository contract. */
export function createPostgresRepos(pool: Pool): Repos {
  const users: UserRepo = {
    async createGuest(id, now) {
      const result = await pool.query(
        `INSERT INTO users (id, type, nickname, created_at, last_seen_at) VALUES ($1, 'guest', NULL, $2, $2)
         ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at RETURNING *`, [id, now],
      );
      return userFromRow(result.rows[0]!);
    },
    async get(id) {
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
      return result.rowCount ? userFromRow(result.rows[0]!) : null;
    },
    async setNickname(id, nickname) { await pool.query('UPDATE users SET nickname = $2 WHERE id = $1', [id, nickname]); },
    async setBan(id, bannedUntil, reason) {
      return (await pool.query('UPDATE users SET banned_until = $2, ban_reason = $3 WHERE id = $1', [id, bannedUntil, reason])).rowCount === 1;
    },
    async clearBan(id) {
      return (await pool.query('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = $1', [id])).rowCount === 1;
    },
    async isBanned(id, now) {
      const result = await pool.query('SELECT banned_until FROM users WHERE id = $1', [id]);
      const until = result.rows[0]?.banned_until;
      if (until === undefined || until === null) return false;
      if (Number(until) <= now) { await pool.query('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = $1', [id]); return false; }
      return true;
    },
    async touch(id, now) { await pool.query('UPDATE users SET last_seen_at = $2 WHERE id = $1', [id, now]); },
  };

  const matches: MatchRepo = {
    async save(result: MatchResult) {
      const inserted = await pool.query(
        `INSERT INTO match_results (match_id, user_id, score, rank, length_at_death, survival_ms, kills, reason, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (match_id, user_id) DO NOTHING`,
        [result.matchId, result.userId, result.score, result.rank, result.lengthAtDeath, result.survivalMs, result.kills, result.reason, result.endedAt],
      );
      return inserted.rowCount === 1;
    },
    async statsOf(userId) {
      const result = await pool.query(
        `SELECT count(*)::int AS games, coalesce(max(score), 0) AS best_score,
                coalesce(max(survival_ms), 0) AS best_survival_ms, coalesce(sum(kills), 0) AS total_kills
         FROM match_results WHERE user_id = $1`, [userId],
      );
      const row = result.rows[0]!;
      return { games: Number(row.games), bestScore: Number(row.best_score), bestSurvivalMs: Number(row.best_survival_ms), totalKills: Number(row.total_kills) };
    },
    async summarySince(since) {
      const result = await pool.query(
        `SELECT count(*)::int AS completed, count(DISTINCT user_id)::int AS unique_players,
                coalesce(avg(survival_ms), 0) AS average_survival_ms FROM match_results WHERE ended_at >= $1`, [since],
      );
      const row = result.rows[0]!;
      return { completed: Number(row.completed), uniquePlayers: Number(row.unique_players), averageSurvivalMs: Number(row.average_survival_ms) };
    },
  };

  const leaderboard: LeaderboardRepo = {
    async top(limit, since = Number.NEGATIVE_INFINITY) {
      const result = await pool.query(
        `SELECT m.user_id, u.nickname, max(m.score) AS score FROM match_results m
         LEFT JOIN users u ON u.id = m.user_id WHERE m.ended_at >= $1 GROUP BY m.user_id, u.nickname
         ORDER BY max(m.score) DESC, m.user_id ASC LIMIT $2`, [since, limit],
      );
      return result.rows.map((row) => ({ userId: String(row.user_id), nickname: row.nickname === null ? null : String(row.nickname), score: Number(row.score) }));
    },
    async rankOf(userId, since = Number.NEGATIVE_INFINITY) {
      const result = await pool.query(
        `WITH best AS (SELECT user_id, max(score) AS score FROM match_results WHERE ended_at >= $2 GROUP BY user_id),
         ranked AS (SELECT user_id, rank() OVER (ORDER BY score DESC, user_id ASC) AS position FROM best)
         SELECT position FROM ranked WHERE user_id = $1`, [userId, since],
      );
      return result.rowCount ? Number(result.rows[0]!.position) : null;
    },
  };

  const cosmetics: CosmeticRepo = {
    async ownedSkinIds(userId) {
      if (!(await users.get(userId))) return [];
      const extra = await pool.query('SELECT skin_id FROM owned_skins WHERE user_id = $1', [userId]);
      return [...basicSkinIds, ...extra.rows.map((row) => Number(row.skin_id))].sort((a, b) => a - b);
    },
    async selectedSkinId(userId) {
      const result = await pool.query('SELECT skin_id FROM loadouts WHERE user_id = $1', [userId]);
      return result.rowCount ? Number(result.rows[0]!.skin_id) : 0;
    },
    async setSelectedSkinId(userId, skinId) {
      if (!(await cosmetics.ownedSkinIds(userId)).includes(skinId)) return false;
      await pool.query(`INSERT INTO loadouts (user_id, skin_id) VALUES ($1,$2)
                        ON CONFLICT (user_id) DO UPDATE SET skin_id = EXCLUDED.skin_id`, [userId, skinId]);
      return true;
    },
    async grantSkinId(userId, skinId) {
      if (!(await users.get(userId)) || !unlockableSkinIds.has(skinId)) return false;
      await pool.query('INSERT INTO owned_skins (user_id, skin_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, skinId]);
      return true;
    },
  };

  const reports: ReportRepo = {
    async save(report) { await pool.query(`INSERT INTO reports VALUES ($1,$2,$3,$4,$5,$6,$7)`, [report.id, report.reporterUserId, report.targetUserId, report.reason, report.detail, report.ip, report.createdAt]); },
    async countSince(userId, ip, since) {
      const result = await pool.query(`SELECT count(*) FILTER (WHERE reporter_user_id = $1)::int AS account,
        count(*) FILTER (WHERE ip = $2)::int AS ip FROM reports WHERE created_at >= $3`, [userId, ip, since]);
      return { account: Number(result.rows[0]!.account), ip: Number(result.rows[0]!.ip) };
    },
    async recent(limit) {
      return (await pool.query('SELECT id, reporter_user_id, target_user_id, reason, detail, ip, created_at FROM reports ORDER BY created_at DESC, id DESC LIMIT $1', [limit])).rows.map((row) => ({
        id: String(row.id), reporterUserId: String(row.reporter_user_id), targetUserId: row.target_user_id === null ? null : String(row.target_user_id),
        reason: row.reason as PlayerReport['reason'], detail: row.detail === null ? null : String(row.detail), ip: String(row.ip), createdAt: Number(row.created_at),
      }));
    },
  };

  const tokenRevocations: TokenRevocationRepo = {
    async revoke(fingerprint, expiresAt) { await pool.query(`INSERT INTO token_revocations VALUES ($1,$2) ON CONFLICT (fingerprint) DO UPDATE SET expires_at = EXCLUDED.expires_at`, [fingerprint, expiresAt]); },
    async isRevoked(fingerprint, now) {
      const result = await pool.query('SELECT expires_at FROM token_revocations WHERE fingerprint = $1', [fingerprint]);
      if (!result.rowCount) return false;
      if (Number(result.rows[0]!.expires_at) <= now) { await pool.query('DELETE FROM token_revocations WHERE fingerprint = $1', [fingerprint]); return false; }
      return true;
    },
  };

  const configs: ConfigRepo = {
    async active() { return revisionFromRow((await pool.query('SELECT version, activated_at, config, rollout_percent FROM config_revisions ORDER BY revision_id DESC LIMIT 1')).rows[0]!); },
    async activeFor(rolloutKey) { return selectConfigRevision(await this.history(), rolloutKey); },
    async history() { return (await pool.query('SELECT version, activated_at, config, rollout_percent FROM config_revisions ORDER BY revision_id ASC')).rows.map(revisionFromRow); },
    async activate(config, now, rolloutPercent = 100) { return revisionFromRow((await pool.query(`INSERT INTO config_revisions (version, activated_at, config, rollout_percent) VALUES ($1,$2,$3::jsonb,$4) RETURNING version, activated_at, config, rollout_percent`, [config.version, now, JSON.stringify(config), rolloutPercent])).rows[0]!); },
    async advanceRollout(rolloutPercent, now) {
      const active = await this.active();
      return revisionFromRow((await pool.query(`INSERT INTO config_revisions (version, activated_at, config, rollout_percent) VALUES ($1,$2,$3::jsonb,$4) RETURNING version, activated_at, config, rollout_percent`, [active.version, now, JSON.stringify(active.config), rolloutPercent])).rows[0]!);
    },
    async rollback(version, now) {
      const selected = await pool.query('SELECT config FROM config_revisions WHERE version = $1 ORDER BY revision_id DESC LIMIT 1', [version]);
      if (!selected.rowCount) return null;
      return revisionFromRow((await pool.query(`INSERT INTO config_revisions (version, activated_at, config, rollout_percent) VALUES ($1,$2,$3::jsonb,100) RETURNING version, activated_at, config, rollout_percent`, [version, now, JSON.stringify(selected.rows[0]!.config)])).rows[0]!);
    },
  };

  const telemetry: TelemetryRepo = {
    async saveMany(events) {
      for (const event of events) await pool.query(`INSERT INTO telemetry_events (user_id,name,client_time,properties,ip,received_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`, [event.userId, event.name, event.clientTime, JSON.stringify(event.properties), event.ip, event.receivedAt]);
    },
    async countSince(userId, ip, since) {
      const result = await pool.query(`SELECT count(*) FILTER (WHERE user_id = $1)::int AS account,
        count(*) FILTER (WHERE ip = $2)::int AS ip FROM telemetry_events WHERE received_at >= $3`, [userId, ip, since]);
      return { account: Number(result.rows[0]!.account), ip: Number(result.rows[0]!.ip) };
    },
    async summarySince(since) {
      const result = await pool.query(
        `SELECT name, count(*)::int AS events, count(DISTINCT user_id)::int AS unique_users
         FROM telemetry_events WHERE received_at >= $1 GROUP BY name ORDER BY name ASC`, [since],
      );
      return result.rows.map((row) => ({ name: String(row.name), events: Number(row.events), uniqueUsers: Number(row.unique_users) }));
    },
    async retention(cohortStart, cohortEnd, activitySince) {
      const result = await pool.query(
        `WITH cohort AS (SELECT id FROM users WHERE created_at >= $1 AND created_at < $2),
         retained AS (SELECT DISTINCT t.user_id FROM telemetry_events t JOIN cohort c ON c.id = t.user_id WHERE t.received_at >= $3)
         SELECT (SELECT count(*)::int FROM cohort) AS cohort, (SELECT count(*)::int FROM retained) AS retained`,
        [cohortStart, cohortEnd, activitySince],
      );
      return { cohort: Number(result.rows[0]!.cohort), retained: Number(result.rows[0]!.retained) };
    },
  };
  const features: FeatureFlagRepo = {
    async active() {
      const result = await pool.query('SELECT flags FROM feature_flags WHERE singleton = TRUE');
      return { ...defaultFeatureFlags, ...(result.rows[0]?.flags as Partial<FeatureFlags> | undefined) };
    },
    async set(flags) {
      await pool.query(`INSERT INTO feature_flags (singleton, flags) VALUES (TRUE, $1::jsonb) ON CONFLICT(singleton) DO UPDATE SET flags = EXCLUDED.flags`, [JSON.stringify(flags)]);
      return { ...flags };
    },
  };

  const identities: IdentityRepo = {
    async link(userId, provider, subject) {
      if (!(await users.get(userId))) return 'unknown_user';
      const existing = await pool.query('SELECT user_id FROM identities WHERE provider = $1 AND subject = $2', [provider, subject]);
      if (existing.rowCount) return existing.rows[0]!.user_id === userId ? 'already_linked' : 'claimed';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO identities (provider, subject, user_id) VALUES ($1,$2,$3)', [provider, subject, userId]);
        await client.query(`UPDATE users SET type = 'account' WHERE id = $1`, [userId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      return 'linked';
    },
    async identitiesOf(userId) {
      const result = await pool.query('SELECT provider, subject FROM identities WHERE user_id = $1 ORDER BY provider', [userId]);
      return result.rows.map((row) => ({ provider: String(row.provider), subject: String(row.subject) }));
    },
  };

  const privacy = {
    async eraseUser(userId: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (!(await client.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) { await client.query('ROLLBACK'); return false; }
        const anonymousId = `deleted:${randomUUID()}`;
        await client.query('UPDATE match_results SET user_id = $2 WHERE user_id = $1', [userId, anonymousId]);
        await client.query('UPDATE reports SET reporter_user_id = $2 WHERE reporter_user_id = $1', [userId, anonymousId]);
        await client.query('UPDATE reports SET target_user_id = $2 WHERE target_user_id = $1', [userId, anonymousId]);
        await client.query('DELETE FROM telemetry_events WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM user_missions WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM identities WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM loadouts WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM owned_skins WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM friendships WHERE user_id = $1 OR friend_user_id = $1', [userId]);
        await client.query('DELETE FROM season_progress WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM season_claims WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM users WHERE id = $1', [userId]);
        await client.query('COMMIT');
        return true;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
  };
  const retention = {
    async purge(telemetryBefore: number, guestBefore: number) {
      const telemetry = await pool.query('DELETE FROM telemetry_events WHERE received_at < $1', [telemetryBefore]);
      const stale = await pool.query("SELECT id FROM users WHERE type = 'guest' AND last_seen_at < $1", [guestBefore]);
      let guests = 0;
      for (const row of stale.rows) if (await privacy.eraseUser(String(row.id))) guests++;
      return { telemetry: telemetry.rowCount ?? 0, guests };
    },
  };
  const missions: MissionRepo = {
    async list(userId, now) { const daily = new Date(now).toISOString().slice(0,10); const date = new Date(now); const dayStart = Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()); const weekly = new Date(dayStart-((new Date(dayStart).getUTCDay()+6)%7)*86_400_000).toISOString().slice(0,10); const r = await pool.query('SELECT mission_id,progress,claimed FROM user_missions WHERE user_id=$1 AND period = ANY($2)',[userId,[daily,weekly]]); const rows = new Map(r.rows.map((x) => [String(x.mission_id),x])); const d=rows.get('daily_matches_3'); const w=rows.get('weekly_matches_10'); return [{id:'daily_matches_3',title:'오늘 3경기 플레이',target:3,progress:Number(d?.progress??0),reward:'skin:8',claimed:Boolean(d?.claimed)},{id:'weekly_matches_10',title:'이번 주 10경기 플레이',target:10,progress:Number(w?.progress??0),reward:'skin:9',claimed:Boolean(w?.claimed)}]; },
    async recordMatch(userId, now) { const daily=new Date(now).toISOString().slice(0,10); const date=new Date(now); const dayStart=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()); const weekly=new Date(dayStart-((new Date(dayStart).getUTCDay()+6)%7)*86_400_000).toISOString().slice(0,10); await Promise.all([["daily_matches_3",daily,3],["weekly_matches_10",weekly,10]].map(([id,period,target])=>pool.query(`INSERT INTO user_missions VALUES ($1,$2,$3,1,false) ON CONFLICT(user_id,mission_id,period) DO UPDATE SET progress=LEAST($4,user_missions.progress+1)`,[userId,id,period,target]))); },
    async claim(userId,id,now) { const target=id==='daily_matches_3'?3:id==='weekly_matches_10'?10:null; if(target===null) return 'not_found'; const date=new Date(now); const dayStart=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()); const p=id==='daily_matches_3'?date.toISOString().slice(0,10):new Date(dayStart-((new Date(dayStart).getUTCDay()+6)%7)*86_400_000).toISOString().slice(0,10); const r=await pool.query(`UPDATE user_missions SET claimed=true WHERE user_id=$1 AND mission_id=$2 AND period=$3 AND progress >= $4 AND claimed=false RETURNING 1`,[userId,id,p,target]); if(r.rowCount) return 'claimed'; const q=await pool.query('SELECT progress,claimed FROM user_missions WHERE user_id=$1 AND mission_id=$2 AND period=$3',[userId,id,p]); return q.rows[0]?.claimed?'already_claimed':'incomplete'; },
  };
  const announcements: AnnouncementRepo = {
    async current() { const r = await pool.query('SELECT message, updated_at FROM current_announcement WHERE singleton = TRUE'); return r.rowCount ? { message: String(r.rows[0]!.message), updatedAt: Number(r.rows[0]!.updated_at) } : null; },
    async publish(message, now) { await pool.query(`INSERT INTO current_announcement (singleton,message,updated_at) VALUES (TRUE,$1,$2) ON CONFLICT (singleton) DO UPDATE SET message=EXCLUDED.message,updated_at=EXCLUDED.updated_at`, [message, now]); return { message, updatedAt: now }; },
    async clear() { await pool.query('DELETE FROM current_announcement WHERE singleton = TRUE'); },
  };
  const friends: FriendRepo = {
    async userIdsOf(userId) { return (await pool.query('SELECT friend_user_id FROM friendships WHERE user_id=$1 ORDER BY friend_user_id',[userId])).rows.map((row) => String(row.friend_user_id)); },
    async add(userId, friendUserId) {
      if (userId === friendUserId) return 'self';
      if (!(await users.get(userId)) || !(await users.get(friendUserId))) return 'not_found';
      const client = await pool.connect();
      try { await client.query('BEGIN'); const inserted=await client.query('INSERT INTO friendships (user_id,friend_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[userId,friendUserId]); if (!inserted.rowCount) { await client.query('ROLLBACK'); return 'already_friends'; } await client.query('INSERT INTO friendships (user_id,friend_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[friendUserId,userId]); await client.query('COMMIT'); return 'added'; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    async remove(userId, friendUserId) { const result=await pool.query('DELETE FROM friendships WHERE (user_id=$1 AND friend_user_id=$2) OR (user_id=$2 AND friend_user_id=$1)',[userId,friendUserId]); return (result.rowCount ?? 0) > 0; },
  };
  const liveEvents: LiveEventRepo = {
    async active(now, region) { const r=await pool.query(`SELECT id,title,theme,starts_at,ends_at,target_regions FROM live_events WHERE starts_at <= $1 AND ends_at > $1 AND (jsonb_array_length(target_regions)=0 OR ($2::text IS NOT NULL AND target_regions ? $2)) ORDER BY starts_at LIMIT 1`,[now,region ?? null]); return r.rowCount ? { id:String(r.rows[0]!.id),title:String(r.rows[0]!.title),theme:String(r.rows[0]!.theme),startsAt:Number(r.rows[0]!.starts_at),endsAt:Number(r.rows[0]!.ends_at),targetRegions:Array.isArray(r.rows[0]!.target_regions) ? r.rows[0]!.target_regions.map(String) : [] } : null; },
    async schedule(event) { await pool.query(`INSERT INTO live_events (id,title,theme,starts_at,ends_at,target_regions) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,theme=EXCLUDED.theme,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,target_regions=EXCLUDED.target_regions`,[event.id,event.title,event.theme,event.startsAt,event.endsAt,JSON.stringify(event.targetRegions)]); },
    async clear(id) { return ((await pool.query('DELETE FROM live_events WHERE id=$1',[id])).rowCount ?? 0) > 0; },
  };
  const seasonRow = (row: Record<string, unknown>) => ({ id: String(row.id), title: String(row.title), startsAt: Number(row.starts_at), endsAt: Number(row.ends_at) });
  const freeTrackTarget = (level: number) => ({ 1: 3, 2: 10, 3: 25 }[level] ?? null);
  const seasons: SeasonRepo = {
    async active(now) { const r=await pool.query('SELECT id,title,starts_at,ends_at FROM seasons WHERE starts_at <= $1 AND ends_at > $1 ORDER BY starts_at LIMIT 1',[now]); return r.rowCount ? seasonRow(r.rows[0]!) : null; },
    async schedule(season) { await pool.query(`INSERT INTO seasons (id,title,starts_at,ends_at) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at`,[season.id,season.title,season.startsAt,season.endsAt]); },
    async clear(id) { return ((await pool.query('DELETE FROM seasons WHERE id=$1',[id])).rowCount ?? 0) > 0; },
    async recordMatch(userId, now) { const season=await seasons.active(now); if (!season) return; await pool.query(`INSERT INTO season_progress (user_id,season_id,matches) VALUES ($1,$2,1) ON CONFLICT(user_id,season_id) DO UPDATE SET matches=season_progress.matches+1`,[userId,season.id]); },
    async progress(userId, now) { const season=await seasons.active(now); if (!season) return null; const [progress,claims]=await Promise.all([pool.query('SELECT matches FROM season_progress WHERE user_id=$1 AND season_id=$2',[userId,season.id]),pool.query('SELECT level FROM season_claims WHERE user_id=$1 AND season_id=$2 ORDER BY level',[userId,season.id])]); return { season, matches:Number(progress.rows[0]?.matches ?? 0), claimedLevels:claims.rows.map((row) => Number(row.level)) }; },
    async claim(userId,level,now) { const target=freeTrackTarget(level); const season=await seasons.active(now); if (!season || target===null) return 'not_found'; const progress=await pool.query('SELECT matches FROM season_progress WHERE user_id=$1 AND season_id=$2',[userId,season.id]); if (Number(progress.rows[0]?.matches ?? 0) < target) return 'incomplete'; const inserted=await pool.query('INSERT INTO season_claims (user_id,season_id,level) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1',[userId,season.id,level]); return inserted.rowCount ? 'claimed' : 'already_claimed'; },
  };
  const audit: AuditRepo = {
    async record(entry) { await pool.query('INSERT INTO admin_audit_log (id,action,target,created_at) VALUES ($1,$2,$3,$4)',[entry.id,entry.action,entry.target,entry.createdAt]); },
    async recent(limit) { return (await pool.query('SELECT id,action,target,created_at FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT $1',[limit])).rows.map((row) => ({ id:String(row.id),action:String(row.action),target:String(row.target),createdAt:Number(row.created_at) })); },
  };
  const storageMetrics: StorageMetricsRepo = {
    databasePool() {
      const total = pool.totalCount;
      const idle = pool.idleCount;
      const waiting = pool.waitingCount;
      const active = Math.max(0, total - idle);
      return { total, idle, waiting, saturation: total === 0 ? 0 : active / total };
    },
  };

  return { users, matches, leaderboard, cosmetics, reports, tokenRevocations, configs, features, telemetry, identities, privacy, retention, missions, announcements, friends, liveEvents, seasons, audit, storageMetrics };
}

export async function createReposFromEnv(): Promise<{ repos: Repos; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const { createInMemoryRepos } = await import('./repos');
    return { repos: createInMemoryRepos(), close: async () => undefined };
  }
  const pool = new Pool({ connectionString: url });
  await ensurePostgresSchema(pool);
  return { repos: createPostgresRepos(pool), close: () => pool.end() };
}
