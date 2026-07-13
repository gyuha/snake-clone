import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { defaultGameConfig } from '@serpent/config';
import { registerMatchmaker } from './matchmaker';
import { validateNickname } from './nickname';
import { createInMemoryRepos, type MatchResult, type Repos } from './repos';
import { createToken, verifyToken } from './tokens';

/** 토큰 수명 */
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ApiOptions {
  /** 토큰 서명 시크릿 (운영은 env — dev 기본값). game-server와 공유한다. */
  secret?: string;
  /** 내부(game-server→api) 결과 저장 인증 시크릿 */
  internalSecret?: string;
  /** 매치 티켓이 가리키는 game-server WS 엔드포인트 */
  gameEndpoint?: string;
  repos?: Repos;
  now?: () => number;
}

export interface BuiltApi {
  app: FastifyInstance;
  repos: Repos;
  secret: string;
  internalSecret: string;
}

function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length);
}

/**
 * api-service (PRD §11.1~11.2 — MVP 부분집합).
 * 게스트 인증, 프로필/닉네임, 결과 저장(멱등), 리더보드, 공개 설정.
 */
export function buildApi(options: ApiOptions = {}): BuiltApi {
  const secret = options.secret ?? process.env.SERPENT_TOKEN_SECRET ?? 'dev-secret-change-me';
  const internalSecret =
    options.internalSecret ?? process.env.SERPENT_INTERNAL_SECRET ?? 'dev-internal-secret';
  const repos = options.repos ?? createInMemoryRepos();
  const now = options.now ?? Date.now;
  const app = Fastify({ logger: false });

  // CORS — 웹 클라이언트는 다른 오리진(포트)에서 호출한다.
  // 운영에서는 SERPENT_CORS_ORIGIN으로 좁힌다 (dev 기본 *).
  const corsOrigin = process.env.SERPENT_CORS_ORIGIN ?? '*';
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', corsOrigin);
    reply.header('access-control-allow-headers', 'authorization, content-type, x-internal-secret');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  const issueTokens = (userId: string) => ({
    accessToken: createToken({ sub: userId, type: 'access', exp: now() + ACCESS_TTL_MS }, secret),
    refreshToken: createToken({ sub: userId, type: 'refresh', exp: now() + REFRESH_TTL_MS }, secret),
  });

  const authenticate = (req: FastifyRequest): string | null => {
    const token = bearerOf(req);
    if (!token) return null;
    const payload = verifyToken(token, secret, 'access', now());
    return payload?.sub ?? null;
  };

  // ── 인증 ──────────────────────────────────────────────────────────────
  app.post('/v1/auth/guest', async (_req, reply) => {
    const userId = randomUUID();
    await repos.users.createGuest(userId, now());
    return reply.code(201).send({ userId, ...issueTokens(userId) });
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    const body = req.body as { refreshToken?: unknown } | null;
    const token = typeof body?.refreshToken === 'string' ? body.refreshToken : null;
    const payload = token ? verifyToken(token, secret, 'refresh', now()) : null;
    if (!payload) return reply.code(401).send({ code: 'invalid_refresh', message: 'refresh token invalid' });
    const user = await repos.users.get(payload.sub);
    if (!user) return reply.code(401).send({ code: 'unknown_user', message: 'user not found' });
    return reply.send({ userId: user.id, ...issueTokens(user.id) });
  });

  // ── 프로필 ────────────────────────────────────────────────────────────
  app.get('/v1/me', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const user = await repos.users.get(userId);
    if (!user) return reply.code(404).send({ code: 'not_found', message: 'user not found' });
    const stats = await repos.matches.statsOf(userId);
    return reply.send({ userId: user.id, nickname: user.nickname, stats });
  });

  app.patch('/v1/me', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const body = req.body as { nickname?: unknown } | null;
    const result = validateNickname(body?.nickname);
    if (!result.ok) return reply.code(400).send({ code: result.error, message: 'invalid nickname' });
    await repos.users.setNickname(userId, result.normalized);
    return reply.send({ userId, nickname: result.normalized });
  });

  // ── 결과 저장 (내부: game-server → api, matchId 멱등) ──────────────────
  app.post('/v1/internal/results', async (req, reply) => {
    if (req.headers['x-internal-secret'] !== internalSecret) {
      return reply.code(403).send({ code: 'forbidden', message: 'internal only' });
    }
    const b = req.body as Partial<MatchResult> | null;
    if (
      !b ||
      typeof b.matchId !== 'string' ||
      typeof b.userId !== 'string' ||
      typeof b.score !== 'number' ||
      !Number.isFinite(b.score)
    ) {
      return reply.code(400).send({ code: 'invalid_result', message: 'matchId/userId/score required' });
    }
    const saved = await repos.matches.save({
      matchId: b.matchId,
      userId: b.userId,
      score: b.score,
      rank: b.rank ?? 0,
      lengthAtDeath: b.lengthAtDeath ?? 0,
      survivalMs: b.survivalMs ?? 0,
      kills: b.kills ?? 0,
      reason: b.reason ?? 'unknown',
      endedAt: now(),
    });
    return reply.code(saved ? 201 : 200).send({ saved });
  });

  // ── 리더보드 ──────────────────────────────────────────────────────────
  app.get('/v1/leaderboards/:scope', async (req, reply) => {
    const entries = await repos.leaderboard.top(100);
    const userId = authenticate(req);
    const selfRank = userId ? await repos.leaderboard.rankOf(userId) : null;
    return reply.send({ scope: (req.params as { scope: string }).scope, entries, selfRank });
  });

  // ── 공개 설정 ─────────────────────────────────────────────────────────
  app.get('/v1/config/client', async (_req, reply) => {
    return reply.send({
      configVersion: defaultGameConfig.version,
      simulation: defaultGameConfig.simulation,
      network: defaultGameConfig.network,
    });
  });

  app.get('/health', async (_req, reply) => reply.send({ ok: true }));

  registerMatchmaker(app, {
    secret,
    now,
    gameEndpoint:
      options.gameEndpoint ?? process.env.SERPENT_GAME_ENDPOINT ?? 'ws://localhost:2567',
  });

  return { app, repos, secret, internalSecret };
}
