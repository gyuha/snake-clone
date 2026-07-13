/**
 * 영속 저장소 인터페이스 + 인메모리 구현 (PRD §12 데이터 모델의 로컬 동형).
 * PostgreSQL 어댑터는 이 인터페이스 뒤에서 교체한다 (loop 계약: 실연동은 M7 범위 밖).
 */

export interface User {
  id: string;
  type: 'guest';
  nickname: string | null;
  createdAt: number;
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

export interface LeaderboardEntry {
  userId: string;
  nickname: string | null;
  score: number;
}

export interface UserRepo {
  createGuest(id: string, now: number): Promise<User>;
  get(id: string): Promise<User | null>;
  setNickname(id: string, nickname: string): Promise<void>;
}

export interface MatchRepo {
  /** matchId+userId 멱등 저장 — 중복이면 false */
  save(result: MatchResult): Promise<boolean>;
  statsOf(userId: string): Promise<UserStats>;
}

export interface LeaderboardRepo {
  top(limit: number): Promise<LeaderboardEntry[]>;
  rankOf(userId: string): Promise<number | null>;
}

export interface Repos {
  users: UserRepo;
  matches: MatchRepo;
  leaderboard: LeaderboardRepo;
}

// ---------------------------------------------------------------------------
// In-memory 구현
// ---------------------------------------------------------------------------

export function createInMemoryRepos(): Repos {
  const users = new Map<string, User>();
  const results = new Map<string, MatchResult>(); // key: matchId:userId
  const bestScores = new Map<string, number>();

  const userRepo: UserRepo = {
    async createGuest(id, now) {
      const user: User = { id, type: 'guest', nickname: null, createdAt: now };
      users.set(id, user);
      return user;
    },
    async get(id) {
      return users.get(id) ?? null;
    },
    async setNickname(id, nickname) {
      const user = users.get(id);
      if (user) user.nickname = nickname;
    },
  };

  const matchRepo: MatchRepo = {
    async save(result) {
      const key = `${result.matchId}:${result.userId}`;
      if (results.has(key)) return false; // 멱등: 중복 무시 (PRD §12.2)
      results.set(key, result);
      const best = bestScores.get(result.userId) ?? 0;
      if (result.score > best) bestScores.set(result.userId, result.score);
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
  };

  const leaderboardRepo: LeaderboardRepo = {
    async top(limit) {
      return [...bestScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([userId, score]) => ({
          userId,
          nickname: users.get(userId)?.nickname ?? null,
          score,
        }));
    },
    async rankOf(userId) {
      if (!bestScores.has(userId)) return null;
      const sorted = [...bestScores.entries()].sort((a, b) => b[1] - a[1]);
      return sorted.findIndex(([id]) => id === userId) + 1;
    },
  };

  return { users: userRepo, matches: matchRepo, leaderboard: leaderboardRepo };
}
