import { defaultGameConfig, type GameConfig } from '@serpent/config';
import { randomUUID } from 'node:crypto';

/**
 * 영속 저장소 인터페이스 + 인메모리 구현 (PRD §12 데이터 모델의 로컬 동형).
 * PostgreSQL 어댑터는 이 인터페이스 뒤에서 교체한다 (loop 계약: 실연동은 M7 범위 밖).
 */

export interface User {
  id: string;
  type: 'guest' | 'account';
  nickname: string | null;
  createdAt: number;
  lastSeenAt: number;
  bannedUntil: number | null;
  banReason: string | null;
}

export interface MatchResult {
  matchId: string;
  userId: string;
  score: number;
  rank: number;
  lengthAtDeath: number;
  survivalMs: number;
  kills: number;
  reason: string;
  endedAt: number;
}

export interface UserStats {
  games: number;
  bestScore: number;
  bestSurvivalMs: number;
  totalKills: number;
}

/** 관리자용 집계. 원시 사용자 식별자나 이벤트 속성은 반환하지 않는다. */
export interface MatchSummary {
  completed: number;
  uniquePlayers: number;
  averageSurvivalMs: number;
}

export interface LeaderboardEntry {
  userId: string;
  nickname: string | null;
  score: number;
}

export interface UserRepo {
  createGuest(id: string, now: number): Promise<User>;
  get(id: string): Promise<User | null>;
  setNickname(id: string, nickname: string): Promise<void>;
  setBan(id: string, bannedUntil: number, reason: string): Promise<boolean>;
  clearBan(id: string): Promise<boolean>;
  isBanned(id: string, now: number): Promise<boolean>;
  touch(id: string, now: number): Promise<void>;
}

export interface MatchRepo {
  /** matchId+userId 멱등 저장 — 중복이면 false */
  save(result: MatchResult): Promise<boolean>;
  statsOf(userId: string): Promise<UserStats>;
  summarySince(since: number): Promise<MatchSummary>;
}

export interface LeaderboardRepo {
  /** since가 주어지면 그 시점 이후의 경기 중 개인 최고 점수로 순위를 계산한다. */
  top(limit: number, since?: number): Promise<LeaderboardEntry[]>;
  rankOf(userId: string, since?: number): Promise<number | null>;
}

/**
 * 코스메틱은 게임 능력치와 분리된 표시 전용 데이터다. 기본 스킨은 모든 게스트가
 * 소유하며, 선택값은 서버에서 검증·보존한다 (FR-COS-01).
 */
export interface CosmeticRepo {
  ownedSkinIds(userId: string): Promise<number[]>;
  selectedSkinId(userId: string): Promise<number>;
  setSelectedSkinId(userId: string, skinId: number): Promise<boolean>;
  /** 미션/이벤트 보상은 이 멱등 grant 경로로만 소유권을 추가한다. */
  grantSkinId(userId: string, skinId: number): Promise<boolean>;
}

export interface PlayerReport {
  id: string;
  reporterUserId: string;
  targetUserId: string | null;
  reason: 'abuse' | 'cheating' | 'inappropriate_name' | 'other';
  detail: string | null;
  ip: string;
  createdAt: number;
}

export interface ReportRepo {
  save(report: PlayerReport): Promise<void>;
  countSince(reporterUserId: string, ip: string, since: number): Promise<{ account: number; ip: number }>;
  /** 운영 검토 큐. 호출자는 관리자 권한을 별도로 확인해야 한다. */
  recent(limit: number): Promise<PlayerReport[]>;
}

/** 토큰 원문은 보관하지 않고 fingerprint와 만료 시각만 보관한다. */
export interface TokenRevocationRepo {
  revoke(fingerprint: string, expiresAt: number): Promise<void>;
  isRevoked(fingerprint: string, now: number): Promise<boolean>;
}

export interface ConfigRevision {
  version: string;
  activatedAt: number;
  config: GameConfig;
  rolloutPercent: number;
}

/** 활성 설정과 롤백 가능한 버전 이력. 프로덕션에서는 PostgreSQL 어댑터로 교체한다. */
export interface ConfigRepo {
  active(): Promise<ConfigRevision>;
  activeFor(rolloutKey?: string): Promise<ConfigRevision>;
  history(): Promise<ConfigRevision[]>;
  activate(config: GameConfig, now: number, rolloutPercent?: number): Promise<ConfigRevision>;
  /** 같은 활성 configVersion의 노출 비율을 감사 가능한 새 revision으로 승격한다. */
  advanceRollout(rolloutPercent: number, now: number): Promise<ConfigRevision>;
  rollback(version: string, now: number): Promise<ConfigRevision | null>;
}

/** 공개 기능의 활성 상태. 게임 밸런스 Config와 분리해 즉시 되돌릴 수 있다. */
export interface FeatureFlags {
  accountLink: boolean;
  missions: boolean;
  eventHud: boolean;
  binaryProtocol: boolean;
}
export const defaultFeatureFlags: FeatureFlags = { accountLink: true, missions: true, eventHud: true, binaryProtocol: false };
export interface FeatureFlagRepo {
  active(): Promise<FeatureFlags>;
  set(flags: FeatureFlags): Promise<FeatureFlags>;
}

/** Stable rollout selection: no key remains on the last fully deployed version. */
export function selectConfigRevision(history: readonly ConfigRevision[], rolloutKey?: string): ConfigRevision {
  const latest = history.at(-1);
  if (!latest || latest.rolloutPercent >= 100) return latest!;
  const fallback = [...history.slice(0, -1)].reverse().find((revision) => revision.version !== latest.version) ?? latest;
  if (!rolloutKey) return fallback;
  let hash = 2166136261;
  for (let i = 0; i < rolloutKey.length; i += 1) hash = Math.imul(hash ^ rolloutKey.charCodeAt(i)!, 16777619);
  return (hash >>> 0) % 100 < latest.rolloutPercent ? latest : fallback;
}

export interface TelemetryEvent {
  userId: string;
  name: string;
  clientTime: number | null;
  properties: Record<string, string | number | boolean>;
  ip: string;
  receivedAt: number;
}

export interface TelemetryRepo {
  saveMany(events: TelemetryEvent[]): Promise<void>;
  countSince(userId: string, ip: string, since: number): Promise<{ account: number; ip: number }>;
  summarySince(since: number): Promise<{ name: string; events: number; uniqueUsers: number }[]>;
  /** 가입 코호트 중 activitySince 이후 telemetry를 보낸 익명 재방문 수. */
  retention(cohortStart: number, cohortEnd: number, activitySince: number): Promise<{ cohort: number; retained: number }>;
}

export interface IdentityRepo {
  /** verified external identity를 현재 사용자에게 연결. 이미 다른 사용자면 claimed. */
  link(userId: string, provider: string, subject: string): Promise<'linked' | 'already_linked' | 'claimed' | 'unknown_user'>;
  identitiesOf(userId: string): Promise<{ provider: string; subject: string }[]>;
}

/** 삭제 요청: 식별 가능한 계정 데이터는 제거하고, 운영상 보존할 경기/신고는 익명 ID로 치환한다. */
export interface PrivacyRepo {
  eraseUser(userId: string): Promise<boolean>;
}
export interface RetentionRepo {
  purge(telemetryBefore: number, guestBefore: number): Promise<{ telemetry: number; guests: number }>;
}
export interface MissionProgress { id: string; title: string; target: number; progress: number; reward: string; claimed: boolean; }
export interface MissionRepo {
  list(userId: string, now: number): Promise<MissionProgress[]>;
  recordMatch(userId: string, now: number): Promise<void>;
  claim(userId: string, missionId: string, now: number): Promise<'claimed'|'incomplete'|'already_claimed'|'not_found'>;
}
/** 게임 상단에 노출하는 운영 공지. 단일 현재 공지로 단순화해 즉시 철회할 수 있다. */
export interface Announcement { message: string; updatedAt: number; }
export interface AnnouncementRepo {
  current(): Promise<Announcement | null>;
  publish(message: string, now: number): Promise<Announcement>;
  clear(): Promise<void>;
}
export interface FriendRepo {
  userIdsOf(userId: string): Promise<string[]>;
  add(userId: string, friendUserId: string): Promise<'added' | 'already_friends' | 'not_found' | 'self'>;
  remove(userId: string, friendUserId: string): Promise<boolean>;
}
/** 예약·종료를 서버 시간으로 판정하는 테마 이벤트 매니페스트 (Phase 3 Live Ops). */
/** targetRegions가 비어 있으면 모든 지역에 노출한다. */
export interface LiveEvent { id: string; title: string; theme: string; startsAt: number; endsAt: number; targetRegions: string[]; }
export interface LiveEventRepo {
  active(now: number, region?: string): Promise<LiveEvent | null>;
  schedule(event: LiveEvent): Promise<void>;
  clear(id: string): Promise<boolean>;
}
export interface Season { id: string; title: string; startsAt: number; endsAt: number; }
export interface SeasonProgress { season: Season; matches: number; claimedLevels: number[]; }
export interface SeasonRepo {
  active(now: number): Promise<Season | null>;
  schedule(season: Season): Promise<void>;
  clear(id: string): Promise<boolean>;
  recordMatch(userId: string, now: number): Promise<void>;
  progress(userId: string, now: number): Promise<SeasonProgress | null>;
  claim(userId: string, level: number, now: number): Promise<'claimed' | 'incomplete' | 'already_claimed' | 'not_found'>;
}
export interface AuditEntry { id: string; action: string; target: string; createdAt: number; }
export interface AuditRepo {
  record(entry: AuditEntry): Promise<void>;
  recent(limit: number): Promise<AuditEntry[]>;
}

/** 요청 경로와 분리된 저장소 런타임 상태. 사용자 데이터는 포함하지 않는다. */
export interface StorageMetricsRepo {
  databasePool(): { total: number; idle: number; waiting: number; saturation: number } | null;
}

export interface Repos {
  users: UserRepo;
  matches: MatchRepo;
  leaderboard: LeaderboardRepo;
  cosmetics: CosmeticRepo;
  reports: ReportRepo;
  tokenRevocations: TokenRevocationRepo;
  configs: ConfigRepo;
  features: FeatureFlagRepo;
  telemetry: TelemetryRepo;
  identities: IdentityRepo;
  privacy: PrivacyRepo;
  retention: RetentionRepo;
  missions: MissionRepo;
  announcements: AnnouncementRepo;
  friends: FriendRepo;
  liveEvents: LiveEventRepo;
  seasons: SeasonRepo;
  audit: AuditRepo;
  storageMetrics: StorageMetricsRepo;
}

// ---------------------------------------------------------------------------
// In-memory 구현
// ---------------------------------------------------------------------------

export function createInMemoryRepos(): Repos {
  const users = new Map<string, User>();
  const results = new Map<string, MatchResult>(); // key: matchId:userId
  const selectedSkins = new Map<string, number>();
  const reports: PlayerReport[] = [];
  const revokedTokens = new Map<string, number>();
  const configHistory: ConfigRevision[] = [{
    version: defaultGameConfig.version,
    activatedAt: 0,
    config: structuredClone(defaultGameConfig),
    rolloutPercent: 100,
  }];
  let featureFlags: FeatureFlags = { ...defaultFeatureFlags };
  const telemetry: TelemetryEvent[] = [];
  const identitiesByKey = new Map<string, string>();
  const identitiesByUser = new Map<string, { provider: string; subject: string }[]>();
  const basicSkinIds = Array.from({ length: 8 }, (_, id) => id);
  const unlockableSkinIds = new Set([8, 9, 10, 11, 12]);
  const rewardedSkins = new Map<string, Set<number>>();
  const missionState = new Map<string, { progress: number; claimed: boolean }>();
  let announcement: Announcement | null = null;
  const friendsByUser = new Map<string, Set<string>>();
  const liveEvents = new Map<string, LiveEvent>();
  const seasons = new Map<string, Season>();
  const seasonMatches = new Map<string, number>();
  const seasonClaims = new Map<string, Set<number>>();
  const auditEntries: AuditEntry[] = [];
  const storageMetrics: StorageMetricsRepo = { databasePool: () => null };
  const missions = [
    { id: 'daily_matches_3', title: '오늘 3경기 플레이', target: 3, reward: 'skin:8', period: 'daily' },
    { id: 'weekly_matches_10', title: '이번 주 10경기 플레이', target: 10, reward: 'skin:9', period: 'weekly' },
  ] as const;
  const periodOf = (now: number, cadence: 'daily' | 'weekly') => {
    const date = new Date(now);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (cadence === 'daily') return new Date(dayStart).toISOString().slice(0, 10);
    const monday = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * 86_400_000;
    return new Date(monday).toISOString().slice(0, 10);
  };
  const missionKey = (userId: string, missionId: string, period: string) => `${userId}:${missionId}:${period}`;

  const userRepo: UserRepo = {
    async createGuest(id, now) {
      const user: User = { id, type: 'guest', nickname: null, createdAt: now, lastSeenAt: now, bannedUntil: null, banReason: null };
      users.set(id, user);
      selectedSkins.set(id, 0);
      return user;
    },
    async get(id) {
      return users.get(id) ?? null;
    },
    async setNickname(id, nickname) {
      const user = users.get(id);
      if (user) user.nickname = nickname;
    },
    async setBan(id, bannedUntil, reason) {
      const user = users.get(id);
      if (!user) return false;
      user.bannedUntil = bannedUntil;
      user.banReason = reason;
      return true;
    },
    async clearBan(id) {
      const user = users.get(id);
      if (!user) return false;
      user.bannedUntil = null;
      user.banReason = null;
      return true;
    },
    async isBanned(id, now) {
      const user = users.get(id);
      if (!user || user.bannedUntil === null) return false;
      if (user.bannedUntil <= now) {
        user.bannedUntil = null;
        user.banReason = null;
        return false;
      }
      return true;
    },
    async touch(id, now) { const user = users.get(id); if (user) user.lastSeenAt = now; },
  };

  const matchRepo: MatchRepo = {
    async save(result) {
      const key = `${result.matchId}:${result.userId}`;
      if (results.has(key)) return false; // 멱등: 중복 무시 (PRD §12.2)
      results.set(key, result);
      return true;
    },
    async statsOf(userId) {
      const stats: UserStats = { games: 0, bestScore: 0, bestSurvivalMs: 0, totalKills: 0 };
      for (const r of results.values()) {
        if (r.userId !== userId) continue;
        stats.games++;
        stats.bestScore = Math.max(stats.bestScore, r.score);
        stats.bestSurvivalMs = Math.max(stats.bestSurvivalMs, r.survivalMs);
        stats.totalKills += r.kills;
      }
      return stats;
    },
    async summarySince(since) {
      const users = new Set<string>();
      let completed = 0;
      let survivalTotal = 0;
      for (const result of results.values()) {
        if (result.endedAt < since) continue;
        completed++;
        survivalTotal += result.survivalMs;
        users.add(result.userId);
      }
      return { completed, uniquePlayers: users.size, averageSurvivalMs: completed === 0 ? 0 : survivalTotal / completed };
    },
  };

  const leaderboardRepo: LeaderboardRepo = {
    async top(limit, since = Number.NEGATIVE_INFINITY) {
      const scores = bestScoresSince(since);
      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([userId, score]) => ({
          userId,
          nickname: users.get(userId)?.nickname ?? null,
          score,
        }));
    },
    async rankOf(userId, since = Number.NEGATIVE_INFINITY) {
      const scores = bestScoresSince(since);
      if (!scores.has(userId)) return null;
      const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
      return sorted.findIndex(([id]) => id === userId) + 1;
    },
  };

  function bestScoresSince(since: number): Map<string, number> {
    const scores = new Map<string, number>();
    for (const result of results.values()) {
      if (result.endedAt < since) continue;
      scores.set(result.userId, Math.max(scores.get(result.userId) ?? 0, result.score));
    }
    return scores;
  }

  const cosmeticRepo: CosmeticRepo = {
    async ownedSkinIds(userId) {
      return users.has(userId) ? [...basicSkinIds, ...(rewardedSkins.get(userId) ?? [])].sort((a, b) => a - b) : [];
    },
    async selectedSkinId(userId) {
      return selectedSkins.get(userId) ?? 0;
    },
    async setSelectedSkinId(userId, skinId) {
      if (!users.has(userId) || !(await cosmeticRepo.ownedSkinIds(userId)).includes(skinId)) return false;
      selectedSkins.set(userId, skinId);
      return true;
    },
    async grantSkinId(userId, skinId) {
      if (!users.has(userId) || !unlockableSkinIds.has(skinId)) return false;
      const owned = rewardedSkins.get(userId) ?? new Set<number>();
      owned.add(skinId);
      rewardedSkins.set(userId, owned);
      return true;
    },
  };

  const reportRepo: ReportRepo = {
    async save(report) {
      reports.push(report);
    },
    async countSince(reporterUserId, ip, since) {
      let account = 0;
      let ipCount = 0;
      for (const report of reports) {
        if (report.createdAt < since) continue;
        if (report.reporterUserId === reporterUserId) account++;
        if (report.ip === ip) ipCount++;
      }
      return { account, ip: ipCount };
    },
    async recent(limit) { return reports.slice(-limit).reverse().map((report) => ({ ...report })); },
  };

  const tokenRevocationRepo: TokenRevocationRepo = {
    async revoke(fingerprint, expiresAt) {
      revokedTokens.set(fingerprint, expiresAt);
    },
    async isRevoked(fingerprint, now) {
      const expiresAt = revokedTokens.get(fingerprint);
      if (expiresAt === undefined) return false;
      if (expiresAt <= now) {
        revokedTokens.delete(fingerprint);
        return false;
      }
      return true;
    },
  };

  const configRepo: ConfigRepo = {
    async active() {
      return structuredClone(configHistory.at(-1)!);
    },
    async activeFor(rolloutKey) { return structuredClone(selectConfigRevision(configHistory, rolloutKey)); },
    async history() {
      return structuredClone(configHistory);
    },
    async activate(config, now, rolloutPercent = 100) {
      const revision = { version: config.version, activatedAt: now, config: structuredClone(config), rolloutPercent };
      configHistory.push(revision);
      return structuredClone(revision);
    },
    async advanceRollout(rolloutPercent, now) {
      const active = configHistory.at(-1)!;
      const revision = { version: active.version, activatedAt: now, config: structuredClone(active.config), rolloutPercent };
      configHistory.push(revision);
      return structuredClone(revision);
    },
    async rollback(version, now) {
      const selected = [...configHistory].reverse().find((revision) => revision.version === version);
      if (!selected) return null;
      const revision = { version: selected.version, activatedAt: now, config: structuredClone(selected.config), rolloutPercent: 100 };
      configHistory.push(revision);
      return structuredClone(revision);
    },
  };

  const telemetryRepo: TelemetryRepo = {
    async saveMany(events) {
      telemetry.push(...events);
      // 로컬 개발 구현도 무한 누적하지 않는다. 실제 보존은 분석 저장소 정책으로 대체한다.
      if (telemetry.length > 10_000) telemetry.splice(0, telemetry.length - 10_000);
    },
    async countSince(userId, ip, since) {
      let account = 0;
      let ipCount = 0;
      for (const event of telemetry) {
        if (event.receivedAt < since) continue;
        if (event.userId === userId) account++;
        if (event.ip === ip) ipCount++;
      }
      return { account, ip: ipCount };
    },
    async summarySince(since) {
      const byName = new Map<string, { events: number; users: Set<string> }>();
      for (const event of telemetry) {
        if (event.receivedAt < since) continue;
        const summary = byName.get(event.name) ?? { events: 0, users: new Set<string>() };
        summary.events++;
        summary.users.add(event.userId);
        byName.set(event.name, summary);
      }
      return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, summary]) => ({ name, events: summary.events, uniqueUsers: summary.users.size }));
    },
    async retention(cohortStart, cohortEnd, activitySince) {
      const cohort = new Set([...users.values()].filter((user) => user.createdAt >= cohortStart && user.createdAt < cohortEnd).map((user) => user.id));
      const retained = new Set(telemetry.filter((event) => event.receivedAt >= activitySince && cohort.has(event.userId)).map((event) => event.userId));
      return { cohort: cohort.size, retained: retained.size };
    },
  };
  const featureRepo: FeatureFlagRepo = {
    async active() { return { ...featureFlags }; },
    async set(flags) { featureFlags = { ...flags }; return { ...featureFlags }; },
  };

  const identityRepo: IdentityRepo = {
    async link(userId, provider, subject) {
      if (!users.has(userId)) return 'unknown_user';
      const key = `${provider}:${subject}`;
      const owner = identitiesByKey.get(key);
      if (owner && owner !== userId) return 'claimed';
      if (owner === userId) return 'already_linked';
      identitiesByKey.set(key, userId);
      const identities = identitiesByUser.get(userId) ?? [];
      identities.push({ provider, subject });
      identitiesByUser.set(userId, identities);
      users.get(userId)!.type = 'account';
      return 'linked';
    },
    async identitiesOf(userId) {
      return structuredClone(identitiesByUser.get(userId) ?? []);
    },
  };

  const privacyRepo: PrivacyRepo = {
    async eraseUser(userId) {
      if (!users.has(userId)) return false;
      const anonymousId = `deleted:${randomUUID()}`;
      for (const result of results.values()) if (result.userId === userId) result.userId = anonymousId;
      for (const report of reports) {
        if (report.reporterUserId === userId) report.reporterUserId = anonymousId;
        if (report.targetUserId === userId) report.targetUserId = anonymousId;
      }
      for (let index = telemetry.length - 1; index >= 0; index -= 1) if (telemetry[index]!.userId === userId) telemetry.splice(index, 1);
      for (const identity of identitiesByUser.get(userId) ?? []) identitiesByKey.delete(`${identity.provider}:${identity.subject}`);
      identitiesByUser.delete(userId);
      for (const key of missionState.keys()) if (key.startsWith(`${userId}:`)) missionState.delete(key);
      selectedSkins.delete(userId);
      rewardedSkins.delete(userId);
      friendsByUser.delete(userId);
      for (const friends of friendsByUser.values()) friends.delete(userId);
      for (const key of seasonMatches.keys()) if (key.startsWith(`${userId}:`)) seasonMatches.delete(key);
      for (const key of seasonClaims.keys()) if (key.startsWith(`${userId}:`)) seasonClaims.delete(key);
      users.delete(userId);
      return true;
    },
  };
  const retentionRepo: RetentionRepo = {
    async purge(telemetryBefore, guestBefore) {
      const initial = telemetry.length;
      for (let index = telemetry.length - 1; index >= 0; index--) if (telemetry[index]!.receivedAt < telemetryBefore) telemetry.splice(index, 1);
      const stale = [...users.values()].filter((user) => user.type === 'guest' && user.lastSeenAt < guestBefore).map((user) => user.id);
      for (const userId of stale) await privacyRepo.eraseUser(userId);
      return { telemetry: initial - telemetry.length, guests: stale.length };
    },
  };
  const missionRepo: MissionRepo = {
    async list(userId, now) { return missions.map((mission) => { const s = missionState.get(missionKey(userId, mission.id, periodOf(now, mission.period))); return { ...mission, progress: s?.progress ?? 0, claimed: s?.claimed ?? false }; }); },
    async recordMatch(userId, now) { for (const mission of missions) { const key = missionKey(userId, mission.id, periodOf(now, mission.period)); const s = missionState.get(key) ?? { progress: 0, claimed: false }; s.progress = Math.min(mission.target, s.progress + 1); missionState.set(key, s); } },
    async claim(userId, id, now) { const mission = missions.find((candidate) => candidate.id === id); if (!mission) return 'not_found'; const s = missionState.get(missionKey(userId, id, periodOf(now, mission.period))); if (!s || s.progress < mission.target) return 'incomplete'; if (s.claimed) return 'already_claimed'; s.claimed = true; return 'claimed'; },
  };
  const announcementRepo: AnnouncementRepo = {
    async current() { return announcement; },
    async publish(message, now) { announcement = { message, updatedAt: now }; return announcement; },
    async clear() { announcement = null; },
  };
  const friendRepo: FriendRepo = {
    async userIdsOf(userId) { return [...(friendsByUser.get(userId) ?? [])].sort(); },
    async add(userId, friendUserId) {
      if (userId === friendUserId) return 'self';
      if (!users.has(userId) || !users.has(friendUserId)) return 'not_found';
      const own = friendsByUser.get(userId) ?? new Set<string>();
      if (own.has(friendUserId)) return 'already_friends';
      own.add(friendUserId); friendsByUser.set(userId, own);
      const other = friendsByUser.get(friendUserId) ?? new Set<string>(); other.add(userId); friendsByUser.set(friendUserId, other);
      return 'added';
    },
    async remove(userId, friendUserId) { const own = friendsByUser.get(userId); if (!own?.delete(friendUserId)) return false; friendsByUser.get(friendUserId)?.delete(userId); return true; },
  };
  const liveEventRepo: LiveEventRepo = {
    async active(now, region) { return [...liveEvents.values()].filter((event) => event.startsAt <= now && now < event.endsAt && (event.targetRegions.length === 0 || (region !== undefined && event.targetRegions.includes(region)))).sort((a, b) => a.startsAt - b.startsAt)[0] ?? null; },
    async schedule(event) { liveEvents.set(event.id, event); },
    async clear(id) { return liveEvents.delete(id); },
  };
  const activeSeason = (now: number) => [...seasons.values()].filter((season) => season.startsAt <= now && now < season.endsAt).sort((a, b) => a.startsAt - b.startsAt)[0] ?? null;
  const seasonKey = (userId: string, seasonId: string) => `${userId}:${seasonId}`;
  const freeTrackTarget = (level: number) => ({ 1: 3, 2: 10, 3: 25 }[level] ?? null);
  const seasonRepo: SeasonRepo = {
    async active(now) { return activeSeason(now); },
    async schedule(season) { seasons.set(season.id, season); },
    async clear(id) { return seasons.delete(id); },
    async recordMatch(userId, now) { const season = activeSeason(now); if (season) { const key = seasonKey(userId, season.id); seasonMatches.set(key, (seasonMatches.get(key) ?? 0) + 1); } },
    async progress(userId, now) { const season = activeSeason(now); if (!season) return null; const key = seasonKey(userId, season.id); return { season, matches: seasonMatches.get(key) ?? 0, claimedLevels: [...(seasonClaims.get(key) ?? [])].sort((a, b) => a - b) }; },
    async claim(userId, level, now) { const target = freeTrackTarget(level); const season = activeSeason(now); if (!season || target === null) return 'not_found'; const key = seasonKey(userId, season.id); if ((seasonMatches.get(key) ?? 0) < target) return 'incomplete'; const claims = seasonClaims.get(key) ?? new Set<number>(); if (claims.has(level)) return 'already_claimed'; claims.add(level); seasonClaims.set(key, claims); return 'claimed'; },
  };
  const auditRepo: AuditRepo = {
    async record(entry) { auditEntries.push(entry); },
    async recent(limit) { return auditEntries.slice(-limit).reverse().map((entry) => ({ ...entry })); },
  };

  return {
    users: userRepo,
    matches: matchRepo,
    leaderboard: leaderboardRepo,
    cosmetics: cosmeticRepo,
    reports: reportRepo,
    tokenRevocations: tokenRevocationRepo,
    configs: configRepo,
    features: featureRepo,
    telemetry: telemetryRepo,
    identities: identityRepo,
    privacy: privacyRepo,
    retention: retentionRepo,
    missions: missionRepo,
    announcements: announcementRepo,
    friends: friendRepo,
    liveEvents: liveEventRepo,
    seasons: seasonRepo,
    audit: auditRepo,
    storageMetrics,
  };
}
