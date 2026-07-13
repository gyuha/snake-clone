import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type GameConfig, validateGameConfig } from '@serpent/config';
import { matchTargetsFromEnv, registerMatchmaker, type MatchTargetDirectory } from './matchmaker';
import { parseBannedWords, validateNickname } from './nickname';
import { createInMemoryRepos, defaultFeatureFlags, type FeatureFlags, type MatchResult, type Repos } from './repos';
import { InMemoryRateLimiter, type RateLimiter } from './rateLimit';
import { createToken, tokenFingerprint, verifyToken } from './tokens';
import { verifyTotp } from './totp';
import { openApiDocument } from './openapi';
import { ApiMetrics } from './opsMetrics';

/** 토큰 수명 */
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 15 * 60 * 1000;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const REPORT_LIMIT_PER_ACCOUNT = 5;
const REPORT_LIMIT_PER_IP = 10;
const REPORT_REASONS = new Set(['abuse', 'cheating', 'inappropriate_name', 'other']);
const MAX_BAN_MS = 365 * 24 * 60 * 60 * 1000;
const FRIEND_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const seasonRewardSkinId = (level: number): number | null => ({ 1: 10, 2: 11, 3: 12 }[level] ?? null);
const TELEMETRY_EVENTS = new Set([
  'landing_view', 'play_click', 'guest_created', 'ticket_created', 'room_joined',
  'first_input', 'match_ended', 'retry_click', 'account_linked',
]);
const TELEMETRY_WINDOW_MS = 60_000;
const TELEMETRY_ACCOUNT_LIMIT = 200;
const TELEMETRY_IP_LIMIT = 500;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 10_000;
const TELEMETRY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GUEST_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

interface IdempotencyEntry {
  statusCode: number;
  payload: string | null;
  contentType: string | undefined;
  expiresAt: number;
}

type LeaderboardScope = 'daily' | 'weekly' | 'all';

function leaderboardSince(scope: LeaderboardScope, timestamp: number): number | undefined {
  if (scope === 'all') return undefined;
  const date = new Date(timestamp);
  const midnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (scope === 'daily') return midnightUtc;
  // ISO week (Monday 00:00 UTC) keeps the boundary independent of API host locale.
  const day = new Date(midnightUtc).getUTCDay();
  return midnightUtc - ((day + 6) % 7) * 24 * 60 * 60 * 1000;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function validFeatureFlags(value: unknown): value is FeatureFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const flags = value as Record<string, unknown>;
  return Object.keys(flags).length === Object.keys(defaultFeatureFlags).length &&
    Object.keys(defaultFeatureFlags).every((key) => typeof flags[key] === 'boolean');
}

export interface VerifiedIdentity {
  /** identity provider가 검증한 안정적인 외부 subject. 이메일 원문/토큰은 저장하지 않는다. */
  subject: string;
}

export interface IdentityVerifier {
  verify(provider: string, proof: string): Promise<VerifiedIdentity | null>;
}

export interface ApiOptions {
  /** 토큰 서명 시크릿 (운영은 env — dev 기본값). game-server와 공유한다. */
  secret?: string;
  /** 내부(game-server→api) 결과 저장 인증 시크릿 */
  internalSecret?: string;
  /** 운영자 제재 API용 별도 비밀. 운영 환경에서는 반드시 설정한다. */
  adminSecret?: string;
  /** 선택적 최소 권한 관리자 비밀. { viewer, operator, owner }별 비밀을 매핑한다. */
  adminRoleSecrets?: Partial<Record<AdminRole, string>>;
  /** 실제 OAuth callback·이메일 검증을 담당하는 어댑터. 미설정 시 계정 연결은 안전하게 비활성화된다. */
  identityVerifier?: IdentityVerifier;
  /** 매치 티켓이 가리키는 game-server WS 엔드포인트 */
  gameEndpoint?: string;
  /** 실시간 registry/heartbeat를 연결하는 매치 타깃 디렉터리. */
  matchTargets?: MatchTargetDirectory;
  repos?: Repos;
  rateLimiter?: RateLimiter;
  now?: () => number;
  /** 운영용: refresh token을 JSON 대신 HttpOnly Secure 쿠키로 발급한다. */
  refreshCookie?: boolean;
  /** base32 TOTP secret. 설정 시 모든 관리자 변경 API에 두 번째 요소를 요구한다. */
  adminTotpSecret?: string;
  /** 기본 목록에 추가할 운영 금칙어. production은 환경 또는 설정 저장소로 주입한다. */
  bannedWords?: string[];
  /** 게임 서버 운영 메트릭 endpoint. 관리자 API가 서버 간 비밀로 프록시한다. */
  opsEndpoint?: string;
  opsSecret?: string;
  opsFetch?: typeof fetch;
  /** API RPS/지연/5xx 관측을 외부 exporter와 공유할 때 주입한다. */
  apiMetrics?: ApiMetrics;
}

export type AdminRole = 'viewer' | 'operator' | 'owner';
const ADMIN_ROLE_RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, owner: 3 };

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

function cookieOf(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  const prefix = `${name}=`;
  const part = header.split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix));
  if (!part) return null;
  try { return decodeURIComponent(part.slice(prefix.length)); } catch { return null; }
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
  const featureEnabled = async (name: keyof FeatureFlags): Promise<boolean> => (await repos.features.active())[name];
  const adminSecret = options.adminSecret ?? process.env.SERPENT_ADMIN_SECRET;
  const configuredRoleSecrets = options.adminRoleSecrets ?? (() => {
    try {
      const parsed = JSON.parse(process.env.SERPENT_ADMIN_ROLE_SECRETS ?? '{}') as Record<string, unknown>;
      return Object.fromEntries((['viewer', 'operator', 'owner'] as AdminRole[]).flatMap((role) => typeof parsed[role] === 'string' && parsed[role].length > 0 ? [[role, parsed[role]]] : [])) as Partial<Record<AdminRole, string>>;
    } catch { return {}; }
  })();
  const adminTotpSecret = options.adminTotpSecret ?? process.env.SERPENT_ADMIN_TOTP_SECRET;
  const adminTotpRequired = options.adminTotpSecret !== undefined || process.env.NODE_ENV === 'production';
  const identityVerifier = options.identityVerifier;
  const now = options.now ?? Date.now;
  const rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter(now);
  const refreshCookie = options.refreshCookie ?? process.env.SERPENT_REFRESH_COOKIE === '1';
  const bannedWords = options.bannedWords ?? parseBannedWords(process.env.SERPENT_BANNED_WORDS);
  const opsEndpoint = options.opsEndpoint ?? process.env.SERPENT_GAME_OPS_ENDPOINT;
  const opsSecret = options.opsSecret ?? process.env.SERPENT_GAME_OPS_SECRET ?? adminSecret;
  const opsFetch = options.opsFetch ?? fetch;
  const apiMetrics = options.apiMetrics ?? new ApiMetrics(now);
  // Fastify의 reqId는 ingress부터 오류 응답까지 동일하게 유지된다. 운영에서만
  // 구조화 로그를 켜서 개발/테스트 출력은 조용하게 유지한다.
  const app = Fastify({
    logger: process.env.SERPENT_REQUEST_LOG === '1' ? { level: 'info' } : false,
    genReqId: () => randomUUID(),
  });
  const requestStartedAt = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', async (req) => { requestStartedAt.set(req, now()); });
  app.addHook('onResponse', async (req, reply) => { apiMetrics.observe(Math.max(0, now() - (requestStartedAt.get(req) ?? now())), reply.statusCode); });

  app.get('/v1/openapi.json', async (_req, reply) => reply.type('application/json').send(openApiDocument));

  // CORS — 인증 토큰을 쓰므로 기본값을 개발 웹 오리진으로 제한한다. 다중 도메인
  // 배포는 reverse proxy 또는 명시적인 단일 public origin을 사용한다.
  const configuredCorsOrigin = process.env.SERPENT_CORS_ORIGIN;
  const localWebOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-site');
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const corsOrigin = configuredCorsOrigin ?? (localWebOrigin.test(requestOrigin) ? requestOrigin : 'http://localhost:5173');
    reply.header('access-control-allow-origin', corsOrigin);
    reply.header('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-internal-secret, x-admin-secret, x-admin-totp');
    reply.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    reply.header('access-control-allow-credentials', 'true');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  // 수동 reply.code() 경로까지 포함해 표준 오류 본문(code, message, requestId)을
  // 보장한다. request ID는 헤더와 같은 값으로 추적·지원 문의에 사용한다.
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
    try {
      const body = JSON.parse(payload) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('code' in body)) return payload;
      const error = body as Record<string, unknown>;
      if (typeof error.requestId === 'string') return payload;
      return JSON.stringify({ ...error, requestId: req.id });
    } catch {
      return payload;
    }
  });

  // 변경 요청은 네트워크 재시도 시에도 같은 결과를 돌려준다. 이 훅은 CORS/보안
  // 헤더 훅 다음에 등록해, 재생 응답에도 브라우저 정책 헤더가 빠지지 않게 한다.
  const idempotencyEntries = new Map<string, IdempotencyEntry>();
  const idempotencyRequests = new WeakMap<FastifyRequest, string>();
  const isWrite = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  app.addHook('onRequest', async (req, reply) => {
    if (!isWrite(req.method)) return;
    const rawKey = req.headers['idempotency-key'];
    if (rawKey === undefined) return;
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      return reply.code(400).send({ code: 'invalid_idempotency_key', message: 'Idempotency-Key must be 1-128 safe characters' });
    }
    const credential = [req.headers.authorization, req.headers['x-admin-secret'], req.headers['x-internal-secret']]
      .filter((value): value is string => typeof value === 'string')
      .join('|') || `ip:${req.ip}`;
    const requestKey = `${req.method}:${req.url}:${credential}:${key}`;
    const cached = idempotencyEntries.get(requestKey);
    if (cached && cached.expiresAt > now()) {
      reply.header('idempotency-replayed', 'true');
      if (cached.contentType) reply.type(cached.contentType);
      return reply.code(cached.statusCode).send(cached.payload ?? undefined);
    }
    if (cached) idempotencyEntries.delete(requestKey);
    idempotencyRequests.set(req, requestKey);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const requestKey = idempotencyRequests.get(req);
    if (!requestKey || reply.statusCode >= 500) return payload;
    const at = now();
    for (const [key, entry] of idempotencyEntries) {
      if (entry.expiresAt <= at) idempotencyEntries.delete(key);
    }
    while (idempotencyEntries.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = idempotencyEntries.keys().next().value as string | undefined;
      if (!oldest) break;
      idempotencyEntries.delete(oldest);
    }
    idempotencyEntries.set(requestKey, {
      statusCode: reply.statusCode,
      payload: typeof payload === 'string' ? payload : null,
      contentType: typeof reply.getHeader('content-type') === 'string' ? reply.getHeader('content-type') as string : undefined,
      expiresAt: at + IDEMPOTENCY_TTL_MS,
    });
    return payload;
  });

  const issueTokens = (userId: string) => ({
    accessToken: createToken({ sub: userId, type: 'access', exp: now() + ACCESS_TTL_MS }, secret),
    refreshToken: createToken({ sub: userId, type: 'refresh', exp: now() + REFRESH_TTL_MS }, secret),
  });
  const sendSession = (reply: { header(name: string, value: string): unknown; code(status: number): { send(value: unknown): unknown } }, userId: string, statusCode: number) => {
    const tokens = issueTokens(userId);
    if (refreshCookie) {
      reply.header('set-cookie', `serpent_refresh=${encodeURIComponent(tokens.refreshToken)}; HttpOnly; Secure; SameSite=None; Path=/v1/auth; Max-Age=${Math.floor(REFRESH_TTL_MS / 1000)}`);
      return reply.code(statusCode).send({ userId, accessToken: tokens.accessToken });
    }
    return reply.code(statusCode).send({ userId, ...tokens });
  };

  const authenticate = async (req: FastifyRequest): Promise<string | null> => {
    const token = bearerOf(req);
    if (!token) return null;
    if (await repos.tokenRevocations.isRevoked(tokenFingerprint(token), now())) return null;
    const payload = verifyToken(token, secret, 'access', now());
    if (payload && !(await repos.users.get(payload.sub))) return null;
    if (payload && (await repos.users.isBanned(payload.sub, now()))) return null;
    if (payload) await repos.users.touch(payload.sub, now());
    return payload?.sub ?? null;
  };

  const adminRoleForCredentials = (providedSecret: unknown, providedTotp: unknown): AdminRole | null => {
    if (typeof providedSecret !== 'string') return null;
    const configured = (['owner', 'operator', 'viewer'] as AdminRole[]).find((role) => configuredRoleSecrets[role] === providedSecret);
    const role = configured ?? (typeof adminSecret === 'string' && adminSecret.length > 0 && providedSecret === adminSecret ? 'owner' : null);
    if (!role) return null;
    if (!adminTotpRequired) return role;
    return typeof adminTotpSecret === 'string' && typeof providedTotp === 'string' && verifyTotp(adminTotpSecret, providedTotp, now()) ? role : null;
  };
  const requireAdmin = (req: FastifyRequest, required: AdminRole = 'owner'): boolean => {
    const headerRole = adminRoleForCredentials(req.headers['x-admin-secret'], req.headers['x-admin-totp']);
    if (headerRole) return ADMIN_ROLE_RANK[headerRole] >= ADMIN_ROLE_RANK[required];
    const session = cookieOf(req, 'serpent_admin');
    const role = typeof session === 'string' ? verifyToken(session, secret, 'admin-session', now())?.sub : null;
    return role === 'viewer' || role === 'operator' || role === 'owner' ? ADMIN_ROLE_RANK[role] >= ADMIN_ROLE_RANK[required] : false;
  };
  const audit = (action: string, target: string) => repos.audit.record({ id: randomUUID(), action, target, createdAt: now() });

  // ── 인증 ──────────────────────────────────────────────────────────────
  app.post('/v1/auth/guest', async (req, reply) => {
    if (!(await rateLimiter.consume([{ scope: 'guest-ip', key: req.ip, limit: 20, windowMs: 60_000 }]))) {
      return reply.code(429).send({ code: 'guest_rate_limited', message: 'try again later' });
    }
    const userId = randomUUID();
    await repos.users.createGuest(userId, now());
    return sendSession(reply, userId, 201);
  });

  // 웹 콘솔은 관리자 비밀을 저장하거나 번들에 포함하지 않는다. MFA 검증 뒤에만
  // 짧은 HttpOnly 세션을 발급하며, API 자동화는 기존 비밀 헤더를 계속 쓸 수 있다.
  app.post('/v1/admin/session', async (req, reply) => {
    const body = req.body as { secret?: unknown; totp?: unknown } | null;
    const role = adminRoleForCredentials(body?.secret, body?.totp);
    if (!role) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const token = createToken({ sub: role, type: 'admin-session', exp: now() + ADMIN_SESSION_TTL_MS }, secret);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    reply.header('set-cookie', `serpent_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secure}`);
    await audit('admin.session.create', role);
    return reply.code(204).send();
  });
  app.delete('/v1/admin/session', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    reply.header('set-cookie', 'serpent_admin=; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=0');
    await audit('admin.session.delete', 'admin');
    return reply.code(204).send();
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    if (!(await rateLimiter.consume([{ scope: 'refresh-ip', key: req.ip, limit: 60, windowMs: 60_000 }]))) {
      return reply.code(429).send({ code: 'refresh_rate_limited', message: 'try again later' });
    }
    const body = req.body as { refreshToken?: unknown } | null;
    const token = typeof body?.refreshToken === 'string' ? body.refreshToken : cookieOf(req, 'serpent_refresh');
    const payload = token ? verifyToken(token, secret, 'refresh', now()) : null;
    if (token && (await repos.tokenRevocations.isRevoked(tokenFingerprint(token), now()))) {
      return reply.code(401).send({ code: 'invalid_refresh', message: 'refresh token invalid' });
    }
    if (!payload || !token) return reply.code(401).send({ code: 'invalid_refresh', message: 'refresh token invalid' });
    const user = await repos.users.get(payload.sub);
    if (!user) return reply.code(401).send({ code: 'unknown_user', message: 'user not found' });
    if (await repos.users.isBanned(user.id, now())) {
      return reply.code(403).send({ code: 'account_banned', message: 'account is restricted' });
    }
    // Refresh rotation: 성공한 토큰은 즉시 한 번만 사용할 수 있게 폐기한다.
    // 새 토큰 발급과 같은 요청에서 수행하므로 탈취된 이전 토큰의 재사용을 막는다.
    await repos.tokenRevocations.revoke(tokenFingerprint(token), payload.exp);
    return sendSession(reply, user.id, 200);
  });

  app.post('/v1/auth/revoke', async (req, reply) => {
    const accessToken = bearerOf(req);
    const userId = await authenticate(req);
    if (!userId || !accessToken) {
      return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    }
    const accessPayload = verifyToken(accessToken, secret, 'access', now());
    if (!accessPayload) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const bodyRefreshToken = (req.body as { refreshToken?: unknown } | null)?.refreshToken;
    const refreshToken = typeof bodyRefreshToken === 'string' ? bodyRefreshToken : cookieOf(req, 'serpent_refresh');
    let refreshPayload: ReturnType<typeof verifyToken> = null;
    if (typeof refreshToken === 'string') {
      refreshPayload = verifyToken(refreshToken, secret, 'refresh', now());
      if (!refreshPayload || refreshPayload.sub !== userId) {
        return reply.code(400).send({ code: 'invalid_refresh', message: 'refresh token must belong to current user' });
      }
    }
    // 입력 전체를 먼저 검증한 뒤 함께 폐기하여 잘못된 refreshToken이 access만
    // 예기치 않게 무효화하는 부분 성공을 만들지 않는다.
    await repos.tokenRevocations.revoke(tokenFingerprint(accessToken), accessPayload.exp);
    if (typeof refreshToken === 'string' && refreshPayload) {
      await repos.tokenRevocations.revoke(tokenFingerprint(refreshToken), refreshPayload.exp);
    }
    if (refreshCookie) reply.header('set-cookie', 'serpent_refresh=; HttpOnly; Secure; SameSite=None; Path=/v1/auth; Max-Age=0');
    return reply.code(204).send();
  });

  // ── 게스트 계정 연결 (FR-AUTH-02) ─────────────────────────────────────
  // proof의 해석은 OAuth/email verifier 어댑터에 위임한다. API는 검증된 subject만
  // 저장하므로, 클라이언트가 임의 이메일·소셜 ID를 주장해 진행도를 탈취할 수 없다.
  app.post('/v1/auth/link', async (req, reply) => {
    if (!(await featureEnabled('accountLink'))) return reply.code(404).send({ code: 'feature_disabled', message: 'account link is disabled' });
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    if (!identityVerifier) {
      return reply.code(503).send({ code: 'identity_link_unavailable', message: 'identity verifier is not configured' });
    }
    const body = req.body as { provider?: unknown; proof?: unknown } | null;
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    const proof = typeof body?.proof === 'string' ? body.proof : '';
    if (!['email', 'google', 'apple'].includes(provider) || proof.length < 1 || proof.length > 8_192) {
      return reply.code(400).send({ code: 'invalid_identity_proof', message: 'valid provider and proof required' });
    }
    const verified = await identityVerifier.verify(provider, proof);
    if (!verified || !/^[A-Za-z0-9._:@-]{1,255}$/.test(verified.subject)) {
      return reply.code(401).send({ code: 'identity_not_verified', message: 'identity proof could not be verified' });
    }
    const result = await repos.identities.link(userId, provider, verified.subject);
    if (result === 'claimed') return reply.code(409).send({ code: 'identity_claimed', message: 'identity belongs to another account' });
    if (result === 'unknown_user') return reply.code(404).send({ code: 'not_found', message: 'user not found' });
    return reply.code(result === 'linked' ? 201 : 200).send({ linked: result === 'linked', provider });
  });

  // ── 운영 제재 (FR-SAFE-01) ────────────────────────────────────────────
  // 닉네임 제재는 사용자 ID에 귀속한다. 기간·사유를 남기며 API 토큰과 매칭을
  // 즉시 차단한다. admin secret 미설정 환경에서는 이 표면 자체를 사용할 수 없다.
  app.post('/v1/admin/users/:userId/ban', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const userId = (req.params as { userId: string }).userId;
    const body = req.body as { until?: unknown; reason?: unknown } | null;
    const until = typeof body?.until === 'string' ? Date.parse(body.until) : Number.NaN;
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!Number.isFinite(until) || until <= now() || until > now() + MAX_BAN_MS || reason.length < 2 || reason.length > 200) {
      return reply.code(400).send({ code: 'invalid_ban', message: 'future until (max 365 days) and reason required' });
    }
    if (!(await repos.users.setBan(userId, until, reason))) {
      return reply.code(404).send({ code: 'not_found', message: 'user not found' });
    }
    await audit('user.ban', userId);
    return reply.code(200).send({ userId, bannedUntil: new Date(until).toISOString() });
  });

  app.delete('/v1/admin/users/:userId/ban', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const userId = (req.params as { userId: string }).userId;
    if (!(await repos.users.clearBan(userId))) {
      return reply.code(404).send({ code: 'not_found', message: 'user not found' });
    }
    await audit('user.unban', userId);
    return reply.code(204).send();
  });

  // ── 프로필 ────────────────────────────────────────────────────────────
  app.get('/v1/me', async (req, reply) => {
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const user = await repos.users.get(userId);
    if (!user) return reply.code(404).send({ code: 'not_found', message: 'user not found' });
    const stats = await repos.matches.statsOf(userId);
    const selectedSkinId = await repos.cosmetics.selectedSkinId(userId);
    const identities = await repos.identities.identitiesOf(userId);
    return reply.send({ userId: user.id, accountType: user.type, nickname: user.nickname, selectedSkinId, identities: identities.map(({ provider }) => provider), stats });
  });

  app.patch('/v1/me', async (req, reply) => {
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const body = req.body as { nickname?: unknown } | null;
    const result = validateNickname(body?.nickname, bannedWords);
    if (!result.ok) return reply.code(400).send({ code: result.error, message: 'invalid nickname' });
    await repos.users.setNickname(userId, result.normalized);
    return reply.send({ userId, nickname: result.normalized });
  });

  // 개인정보 삭제: 계정/식별자/분석은 제거하고, 집계 무결성이 필요한 경기·신고는
  // 원래 ID와 연결할 수 없는 새 익명 ID로 치환한다.
  app.delete('/v1/me', async (req, reply) => {
    const accessToken = bearerOf(req);
    const userId = await authenticate(req);
    if (!userId || !accessToken) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const payload = verifyToken(accessToken, secret, 'access', now());
    if (!payload) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    await repos.privacy.eraseUser(userId);
    await repos.tokenRevocations.revoke(tokenFingerprint(accessToken), payload.exp);
    return reply.code(204).send();
  });

  // ── 친구 초대 (Phase 2) ───────────────────────────────────────────────
  // 링크에는 초대자 ID와 짧은 만료만 서명하며, 수락자는 자신의 access token으로
  // 식별한다. 이메일/전화번호 같은 추가 개인정보를 초대 URL에 넣지 않는다.
  app.get('/v1/friends', async (req, reply) => {
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    const ids = await repos.friends.userIdsOf(userId);
    const friends = await Promise.all(ids.map(async (id) => {
      const user = await repos.users.get(id);
      return user ? { userId: user.id, nickname: user.nickname } : null;
    }));
    return reply.send({ friends: friends.filter((friend): friend is { userId: string; nickname: string | null } => friend !== null) });
  });
  app.post('/v1/friends/invites', async (req, reply) => {
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    if (!(await rateLimiter.consume([{ scope: 'friend-invite', key: userId, limit: 20, windowMs: 60 * 60_000 }]))) {
      return reply.code(429).send({ code: 'invite_rate_limited', message: 'try again later' });
    }
    const expiresAt = now() + FRIEND_INVITE_TTL_MS;
    const inviteToken = createToken({ sub: userId, type: 'friend_invite', exp: expiresAt, nonce: randomUUID() }, secret);
    return reply.code(201).send({ inviteToken, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.post('/v1/friends/invites/accept', async (req, reply) => {
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    const token = (req.body as { inviteToken?: unknown } | null)?.inviteToken;
    const invite = typeof token === 'string' ? verifyToken(token, secret, 'friend_invite', now()) : null;
    if (!invite) return reply.code(400).send({ code: 'invalid_invite', message: 'valid invite token required' });
    const result = await repos.friends.add(userId, invite.sub);
    if (result === 'added') return reply.code(201).send({ accepted: true, inviterUserId: invite.sub });
    return reply.code(result === 'not_found' ? 404 : 409).send({ code: result });
  });
  app.delete('/v1/friends/:friendUserId', async (req, reply) => {
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    const removed = await repos.friends.remove(userId, (req.params as { friendUserId: string }).friendUserId);
    return removed ? reply.code(204).send() : reply.code(404).send({ code: 'not_found' });
  });

  app.get('/v1/missions', async (req, reply) => {
    if (!(await featureEnabled('missions'))) return reply.code(404).send({ code: 'feature_disabled', message: 'missions are disabled' });
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    return reply.send({ missions: await repos.missions.list(userId, now()) });
  });
  app.post('/v1/missions/:missionId/claim', async (req, reply) => {
    if (!(await featureEnabled('missions'))) return reply.code(404).send({ code: 'feature_disabled', message: 'missions are disabled' });
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    const missionId = (req.params as { missionId: string }).missionId;
    const result = await repos.missions.claim(userId, missionId, now());
    if (result === 'claimed') {
      // 보상 지급은 claim 성공(원자적 claimed 전환) 뒤에만 실행되어 재전송으로
      // 중복 해금되지 않는다. grant 자체도 멱등이다.
      const skinId = missionId === 'daily_matches_3' ? 8 : missionId === 'weekly_matches_10' ? 9 : null;
      if (skinId !== null && !(await repos.cosmetics.grantSkinId(userId, skinId))) {
        return reply.code(500).send({ code: 'reward_failed', message: 'reward could not be granted' });
      }
      return reply.code(201).send({ claimed: true, reward: skinId === null ? null : { skinId } });
    }
    return reply.code(result === 'not_found' ? 404 : 409).send({ code: result });
  });

  // ── 코스메틱 / 장착 ───────────────────────────────────────────────────
  // 기본 스킨은 무료지만, 장착한 스킨은 클라이언트가 아닌 서버의 소유 목록으로 검증한다.
  app.get('/v1/cosmetics', async (req, reply) => {
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const ownedSkinIds = await repos.cosmetics.ownedSkinIds(userId);
    const selectedSkinId = await repos.cosmetics.selectedSkinId(userId);
    return reply.send({
      skins: Array.from({ length: 13 }, (_, id) => ({ id, owned: ownedSkinIds.includes(id) })),
      selectedSkinId,
    });
  });

  app.put('/v1/me/loadout', async (req, reply) => {
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const skinId = (req.body as { skinId?: unknown } | null)?.skinId;
    if (typeof skinId !== 'number' || !Number.isInteger(skinId)) {
      return reply.code(400).send({ code: 'invalid_skin', message: 'integer skinId required' });
    }
    if (!(await repos.cosmetics.setSelectedSkinId(userId, skinId))) {
      return reply.code(403).send({ code: 'skin_not_owned', message: 'skin is not owned' });
    }
    return reply.send({ selectedSkinId: skinId });
  });

  // ── 신고 (FR-SAFE-01) ─────────────────────────────────────────────────
  // 신고는 로그인한 사용자만 제출할 수 있다. 같은 계정/IP가 반복적으로 쏘는
  // 신고 폭주를 막고, 원문은 길이를 제한해 운영 검토용으로만 보관한다.
  app.post('/v1/reports', async (req, reply) => {
    const reporterUserId = await authenticate(req);
    if (!reporterUserId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });

    const body = req.body as { targetUserId?: unknown; reason?: unknown; detail?: unknown } | null;
    const targetUserId = typeof body?.targetUserId === 'string' ? body.targetUserId.trim() : '';
    const reason = typeof body?.reason === 'string' ? body.reason : '';
    const detail = typeof body?.detail === 'string' ? body.detail.trim() : '';
    if (!REPORT_REASONS.has(reason) || detail.length > 500 || (!targetUserId && !detail)) {
      return reply.code(400).send({ code: 'invalid_report', message: 'valid reason and target or detail required' });
    }
    if (targetUserId === reporterUserId) {
      return reply.code(400).send({ code: 'self_report', message: 'cannot report yourself' });
    }

    const ip = req.ip;
    if (!(await rateLimiter.consume([
      { scope: 'report-account', key: reporterUserId, limit: REPORT_LIMIT_PER_ACCOUNT, windowMs: REPORT_WINDOW_MS },
      { scope: 'report-ip', key: ip, limit: REPORT_LIMIT_PER_IP, windowMs: REPORT_WINDOW_MS },
    ]))) {
      return reply.code(429).send({ code: 'report_rate_limited', message: 'try again later' });
    }
    const reportId = randomUUID();
    await repos.reports.save({
      id: reportId,
      reporterUserId,
      targetUserId: targetUserId || null,
      reason: reason as 'abuse' | 'cheating' | 'inappropriate_name' | 'other',
      detail: detail || null,
      ip,
      createdAt: now(),
    });
    return reply.code(201).send({ reportId });
  });

  // ── 비핵심 분석 이벤트 (PRD §11.2, §16.1) ────────────────────────────
  // 게임 판정과 분리된 best-effort 파이프다. 허용된 퍼널 이름, 작은 평면 속성,
  // 계정/IP rate limit을 강제해 클라이언트 분석 데이터가 운영 경로를 압박하지 않는다.
  app.post('/v1/telemetry/batch', async (req, reply) => {
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    const events = (req.body as { events?: unknown } | null)?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 50) {
      return reply.code(400).send({ code: 'invalid_telemetry', message: '1-50 events required' });
    }
    const normalized: { name: string; clientTime: number | null; properties: Record<string, string | number | boolean> }[] = [];
    for (const raw of events) {
      if (!raw || typeof raw !== 'object') return reply.code(400).send({ code: 'invalid_telemetry', message: 'invalid event' });
      const event = raw as { name?: unknown; clientTime?: unknown; properties?: unknown };
      if (typeof event.name !== 'string' || !TELEMETRY_EVENTS.has(event.name)) {
        return reply.code(400).send({ code: 'invalid_telemetry', message: 'unsupported event name' });
      }
      if (event.clientTime !== undefined && (typeof event.clientTime !== 'number' || !Number.isFinite(event.clientTime))) {
        return reply.code(400).send({ code: 'invalid_telemetry', message: 'invalid clientTime' });
      }
      const properties: Record<string, string | number | boolean> = {};
      if (event.properties !== undefined) {
        if (!event.properties || typeof event.properties !== 'object' || Array.isArray(event.properties)) {
          return reply.code(400).send({ code: 'invalid_telemetry', message: 'invalid properties' });
        }
        for (const [key, value] of Object.entries(event.properties as Record<string, unknown>)) {
          if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) ||
            (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') ||
            (typeof value === 'number' && !Number.isFinite(value)) ||
            (typeof value === 'string' && value.length > 128)) {
            return reply.code(400).send({ code: 'invalid_telemetry', message: 'invalid properties' });
          }
          properties[key] = value;
        }
        if (Object.keys(properties).length > 16) return reply.code(400).send({ code: 'invalid_telemetry', message: 'too many properties' });
      }
      normalized.push({ name: event.name, clientTime: typeof event.clientTime === 'number' ? event.clientTime : null, properties });
    }
    const ip = req.ip;
    if (!(await rateLimiter.consume([
      { scope: 'telemetry-account', key: userId, limit: TELEMETRY_ACCOUNT_LIMIT, windowMs: TELEMETRY_WINDOW_MS, cost: normalized.length },
      { scope: 'telemetry-ip', key: ip, limit: TELEMETRY_IP_LIMIT, windowMs: TELEMETRY_WINDOW_MS, cost: normalized.length },
    ]))) {
      return reply.code(429).send({ code: 'telemetry_rate_limited', message: 'try again later' });
    }
    const receivedAt = now();
    await repos.telemetry.saveMany(normalized.map((event) => ({ ...event, userId, ip, receivedAt })));
    return reply.code(202).send({ accepted: normalized.length });
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
    if (saved) {
      const timestamp = now();
      await Promise.all([repos.missions.recordMatch(b.userId, timestamp), repos.seasons.recordMatch(b.userId, timestamp)]);
    }
    return reply.code(saved ? 201 : 200).send({ saved });
  });

  // ── 리더보드 ──────────────────────────────────────────────────────────
  app.get('/v1/leaderboards/:scope', async (req, reply) => {
    const requestedScope = (req.params as { scope: string }).scope;
    const aliases: Record<string, LeaderboardScope> = { all: 'all', day: 'daily', daily: 'daily', week: 'weekly', weekly: 'weekly' };
    const scope = aliases[requestedScope];
    if (!scope) return reply.code(400).send({ code: 'invalid_scope', message: 'scope must be daily, weekly, or all' });
    const since = leaderboardSince(scope, now());
    const entries = await repos.leaderboard.top(100, since);
    const userId = await authenticate(req);
    const selfRank = userId ? await repos.leaderboard.rankOf(userId, since) : null;
    return reply.send({ scope, entries, selfRank });
  });

  // 운영 공지는 인증 없이 읽되, 발행/철회는 기존 관리자 비밀로만 허용한다.
  app.get('/v1/announcements/current', async (_req, reply) => reply.send({ announcement: await repos.announcements.current() }));
  app.put('/v1/admin/announcements/current', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const message = (req.body as { message?: unknown } | null)?.message;
    if (typeof message !== 'string' || message.trim().length < 1 || message.trim().length > 280) {
      return reply.code(400).send({ code: 'invalid_announcement', message: 'message must be 1-280 characters' });
    }
    const announcement = await repos.announcements.publish(message.trim(), now());
    await audit('announcement.publish', 'current');
    return reply.code(201).send({ announcement });
  });
  app.delete('/v1/admin/announcements/current', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    await repos.announcements.clear();
    await audit('announcement.clear', 'current');
    return reply.code(204).send();
  });

  // 테마 이벤트는 예약 시간에 따라 공개 조회가 자동 활성/비활성화된다. 게임 규칙을
  // 바꾸지 않는 표시 이벤트부터 운영해 코드 배포 없는 Live Ops 경로를 확보한다.
  app.get('/v1/events/active', async (req, reply) => {
    if (!(await featureEnabled('eventHud'))) return reply.send({ event: null });
    const region = typeof (req.query as { region?: unknown }).region === 'string' ? (req.query as { region: string }).region : undefined;
    if (region !== undefined && !/^[a-z0-9-]{1,32}$/i.test(region)) return reply.code(400).send({ code: 'invalid_region' });
    return reply.send({ event: await repos.liveEvents.active(now(), region) });
  });
  app.put('/v1/admin/events/:eventId', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const id = (req.params as { eventId: string }).eventId;
    const body = req.body as { title?: unknown; theme?: unknown; startsAt?: unknown; endsAt?: unknown; targetRegions?: unknown } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const theme = typeof body?.theme === 'string' ? body.theme.trim() : '';
    const startsAt = typeof body?.startsAt === 'string' ? Date.parse(body.startsAt) : Number.NaN;
    const endsAt = typeof body?.endsAt === 'string' ? Date.parse(body.endsAt) : Number.NaN;
    const rawTargetRegions = body?.targetRegions;
    const targetRegions = Array.isArray(rawTargetRegions) ? [...new Set(rawTargetRegions.map((region) => typeof region === 'string' ? region.trim() : ''))] : [];
    if (!/^[a-z0-9_-]{1,64}$/i.test(id) || !title || title.length > 80 || !theme || theme.length > 40 || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt || (rawTargetRegions !== undefined && !Array.isArray(rawTargetRegions)) || targetRegions.length > 16 || targetRegions.some((region) => !/^[a-z0-9-]{1,32}$/i.test(region))) {
      return reply.code(400).send({ code: 'invalid_event', message: 'id, title, theme and valid time range required' });
    }
    await repos.liveEvents.schedule({ id, title, theme, startsAt, endsAt, targetRegions });
    await audit('event.schedule', id);
    return reply.code(201).send({ event: { id, title, theme, startsAt, endsAt, targetRegions } });
  });
  app.delete('/v1/admin/events/:eventId', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const id = (req.params as { eventId: string }).eventId;
    if (!(await repos.liveEvents.clear(id))) return reply.code(404).send({ code: 'not_found' });
    await audit('event.clear', id);
    return reply.code(204).send();
  });

  // 시즌 무료 트랙: 경기 수로만 진행해 유료/확률 경제 없이도 반복 플레이 보상을 준다.
  app.get('/v1/seasons/current', async (_req, reply) => {
    if (!(await featureEnabled('missions'))) return reply.send({ season: null });
    return reply.send({ season: await repos.seasons.active(now()) });
  });
  app.get('/v1/seasons/current/progress', async (req, reply) => {
    if (!(await featureEnabled('missions'))) return reply.code(404).send({ code: 'feature_disabled', message: 'missions are disabled' });
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    return reply.send({ progress: await repos.seasons.progress(userId, now()), freeTrack: [{ level: 1, matches: 3, skinId: 10 }, { level: 2, matches: 10, skinId: 11 }, { level: 3, matches: 25, skinId: 12 }] });
  });
  app.post('/v1/seasons/current/claim/:level', async (req, reply) => {
    if (!(await featureEnabled('missions'))) return reply.code(404).send({ code: 'feature_disabled', message: 'missions are disabled' });
    const userId = await authenticate(req); if (!userId) return reply.code(401).send({ code: 'unauthorized' });
    const level = Number((req.params as { level: string }).level);
    if (!Number.isInteger(level)) return reply.code(400).send({ code: 'invalid_level' });
    const result = await repos.seasons.claim(userId, level, now());
    if (result === 'claimed') {
      const skinId = seasonRewardSkinId(level)!;
      if (!(await repos.cosmetics.grantSkinId(userId, skinId))) return reply.code(500).send({ code: 'reward_failed' });
      return reply.code(201).send({ claimed: true, reward: { skinId } });
    }
    return reply.code(result === 'not_found' ? 404 : 409).send({ code: result });
  });
  app.put('/v1/admin/seasons/:seasonId', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const id = (req.params as { seasonId: string }).seasonId;
    const body = req.body as { title?: unknown; startsAt?: unknown; endsAt?: unknown } | null;
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const startsAt = typeof body?.startsAt === 'string' ? Date.parse(body.startsAt) : Number.NaN;
    const endsAt = typeof body?.endsAt === 'string' ? Date.parse(body.endsAt) : Number.NaN;
    if (!/^[a-z0-9_-]{1,64}$/i.test(id) || !title || title.length > 80 || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return reply.code(400).send({ code: 'invalid_season' });
    await repos.seasons.schedule({ id, title, startsAt, endsAt });
    await audit('season.schedule', id);
    return reply.code(201).send({ season: { id, title, startsAt, endsAt } });
  });
  app.delete('/v1/admin/seasons/:seasonId', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const id = (req.params as { seasonId: string }).seasonId;
    if (!(await repos.seasons.clear(id))) return reply.code(404).send({ code: 'not_found' });
    await audit('season.clear', id);
    return reply.code(204).send();
  });

  // ── 운영 설정 (FR-OPS-01/02) ──────────────────────────────────────────
  // 방은 생성 시 configVersion을 고정한다. 이 레지스트리는 새 방/클라이언트에
  // 배포할 활성 버전을 제공하며, 기존 version으로 즉시 rollback할 수 있다.
  app.get('/v1/config/client', async (req, reply) => {
    const key = req.headers['x-serpent-rollout-key'];
    const [active, features] = await Promise.all([repos.configs.activeFor(typeof key === 'string' ? key : undefined), repos.features.active()]);
    return reply.send({
      configVersion: active.version,
      config: active.config,
      rolloutPercent: active.rolloutPercent,
      features,
    });
  });

  app.get('/v1/admin/config', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const [active, history] = await Promise.all([repos.configs.active(), repos.configs.history()]);
    return reply.send({ active, history: history.map(({ version, activatedAt, rolloutPercent }) => ({ version, activatedAt, rolloutPercent })) });
  });
  app.get('/v1/admin/features', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    return reply.send({ features: await repos.features.active() });
  });
  app.put('/v1/admin/features', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const features = (req.body as { features?: unknown } | null)?.features;
    if (!validFeatureFlags(features)) return reply.code(400).send({ code: 'invalid_features', message: 'all known boolean feature flags required' });
    const saved = await repos.features.set(features);
    await audit('features.update', Object.entries(saved).filter(([, enabled]) => enabled).map(([name]) => name).join(','));
    return reply.send({ features: saved });
  });
  app.get('/v1/admin/audit', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const requested = Number((req.query as { limit?: string }).limit ?? 50);
    const limit = Number.isInteger(requested) ? Math.min(100, Math.max(1, requested)) : 50;
    return reply.send({ entries: await repos.audit.recent(limit) });
  });
  // 정책 값은 고정 기본값을 사용하고, 실행 시점은 감사 가능하게 남긴다.
  app.post('/v1/admin/retention/run', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const timestamp = now();
    const result = await repos.retention.purge(timestamp - TELEMETRY_RETENTION_MS, timestamp - GUEST_RETENTION_MS);
    await audit('retention.purge', `telemetry=${result.telemetry},guests=${result.guests}`);
    return reply.send({ ...result, telemetryRetentionDays: 90, guestRetentionDays: 180 });
  });
  app.get('/v1/admin/api/metrics', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    return reply.send({ ...apiMetrics.snapshot(), databasePool: repos.storageMetrics.databasePool() });
  });
  app.get('/v1/admin/product/metrics', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const requested = Number((req.query as { windowHours?: string }).windowHours ?? 24);
    const windowHours = Number.isInteger(requested) ? Math.min(24 * 30, Math.max(1, requested)) : 24;
    const timestamp = now();
    const since = timestamp - windowHours * 3_600_000;
    const today = utcDayStart(timestamp);
    const [funnel, matches, d1, d7] = await Promise.all([
      repos.telemetry.summarySince(since), repos.matches.summarySince(since),
      repos.telemetry.retention(today - 24 * 3_600_000, today, today),
      repos.telemetry.retention(today - 7 * 24 * 3_600_000, today - 6 * 24 * 3_600_000, today),
    ]);
    await audit('product.metrics.view', `${windowHours}h`);
    return reply.send({ since, windowHours, funnel, matches, retention: { d1: { ...d1, rate: d1.cohort === 0 ? 0 : d1.retained / d1.cohort }, d7: { ...d7, rate: d7.cohort === 0 ? 0 : d7.retained / d7.cohort } } });
  });
  app.get('/v1/admin/reports', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const requested = Number((req.query as { limit?: string }).limit ?? 50);
    const limit = Number.isInteger(requested) ? Math.min(100, Math.max(1, requested)) : 50;
    const reports = await repos.reports.recent(limit);
    await audit('reports.view', String(reports.length));
    // IP는 제재 판단에 필요한 경우에만 별도 보안 저장소에서 조회한다. 기본 운영 큐에는 노출하지 않는다.
    return reply.send({ reports: reports.map(({ ip: _ip, ...report }) => report) });
  });
  app.get('/v1/admin/ops/metrics', async (req, reply) => {
    if (!requireAdmin(req, 'viewer')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    if (!opsEndpoint || !opsSecret) return reply.code(503).send({ code: 'ops_unavailable', message: 'game-server metrics endpoint unavailable' });
    try {
      const response = await opsFetch(`${opsEndpoint.replace(/\/$/, '')}/ops/metrics`, { headers: { 'x-admin-secret': opsSecret } });
      if (!response.ok) return reply.code(502).send({ code: 'ops_upstream_error', message: `game-server metrics failed (${response.status})` });
      await audit('ops.metrics.view', 'current');
      return reply.send(await response.json());
    } catch {
      return reply.code(502).send({ code: 'ops_upstream_error', message: 'game-server metrics unavailable' });
    }
  });
  app.post('/v1/admin/ops/drain', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    if (!opsEndpoint || !opsSecret) return reply.code(503).send({ code: 'ops_unavailable', message: 'game-server metrics endpoint unavailable' });
    try {
      const response = await opsFetch(`${opsEndpoint.replace(/\/$/, '')}/ops/drain`, { method: 'POST', headers: { 'x-admin-secret': opsSecret } });
      if (!response.ok) return reply.code(502).send({ code: 'ops_upstream_error', message: `game-server drain failed (${response.status})` });
      const result = await response.json();
      await audit('ops.drain.all', 'current');
      return reply.code(202).send(result);
    } catch {
      return reply.code(502).send({ code: 'ops_upstream_error', message: 'game-server drain unavailable' });
    }
  });
  app.post('/v1/admin/ops/rooms/:roomId/drain', async (req, reply) => {
    if (!requireAdmin(req, 'operator')) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    if (!opsEndpoint || !opsSecret) return reply.code(503).send({ code: 'ops_unavailable', message: 'game-server metrics endpoint unavailable' });
    const roomId = (req.params as { roomId?: string }).roomId;
    if (!roomId || roomId.length > 200) return reply.code(400).send({ code: 'invalid_room_id', message: 'roomId required' });
    try {
      const response = await opsFetch(`${opsEndpoint.replace(/\/$/, '')}/ops/rooms/${encodeURIComponent(roomId)}/drain`, { method: 'POST', headers: { 'x-admin-secret': opsSecret } });
      if (response.status === 404) return reply.code(404).send({ code: 'not_found', message: 'room not found' });
      if (!response.ok) return reply.code(502).send({ code: 'ops_upstream_error', message: `game-server drain failed (${response.status})` });
      const result = await response.json();
      await audit('ops.drain.room', roomId);
      return reply.code(202).send(result);
    } catch {
      return reply.code(502).send({ code: 'ops_upstream_error', message: 'game-server drain unavailable' });
    }
  });

  app.put('/v1/admin/config/activate', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const body = req.body as { config?: unknown; rolloutPercent?: unknown } | null;
    const config = body?.config;
    if (!config || typeof config !== 'object') {
      return reply.code(400).send({ code: 'invalid_config', message: 'config required' });
    }
    const validation = validateGameConfig(config as GameConfig);
    if (!validation.ok) return reply.code(400).send({ code: 'invalid_config', message: validation.error });
    const active = await repos.configs.active();
    if (active.version === (config as GameConfig).version) {
      return reply.code(409).send({ code: 'version_active', message: 'config version already active' });
    }
    const rolloutPercent = body?.rolloutPercent ?? 100;
    if (!Number.isInteger(rolloutPercent) || (rolloutPercent as number) < 1 || (rolloutPercent as number) > 100) return reply.code(400).send({ code: 'invalid_rollout', message: 'rolloutPercent must be an integer from 1 to 100' });
    const revision = await repos.configs.activate(config as GameConfig, now(), rolloutPercent as number);
    await audit('config.activate', `${revision.version}:${revision.rolloutPercent}`);
    return reply.code(201).send({ configVersion: revision.version, activatedAt: revision.activatedAt, rolloutPercent: revision.rolloutPercent });
  });

  app.post('/v1/admin/config/rollout', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const rolloutPercent = (req.body as { rolloutPercent?: unknown } | null)?.rolloutPercent;
    if (!Number.isInteger(rolloutPercent) || (rolloutPercent as number) < 1 || (rolloutPercent as number) > 100) return reply.code(400).send({ code: 'invalid_rollout', message: 'rolloutPercent must be an integer from 1 to 100' });
    const active = await repos.configs.active();
    if ((rolloutPercent as number) <= active.rolloutPercent) return reply.code(409).send({ code: 'rollout_not_advanced', message: 'rolloutPercent must increase the active revision' });
    // 운영 endpoint가 설정된 환경에서는 P1이 하나라도 열려 있으면 자동 승격을 중단한다.
    // 관측 불가도 안전하게 중단해 장애 중 1%→100% 확산을 막는다.
    if (opsEndpoint && opsSecret) {
      try {
        const response = await opsFetch(`${opsEndpoint.replace(/\/$/, '')}/ops/metrics`, { headers: { 'x-admin-secret': opsSecret } });
        if (!response.ok) return reply.code(503).send({ code: 'ops_unavailable', message: `cannot evaluate rollout guard (${response.status})` });
        const metrics = await response.json() as { alerts?: unknown };
        const p1 = Array.isArray(metrics.alerts) && metrics.alerts.some((alert) => Boolean(alert) && typeof alert === 'object' && (alert as { severity?: unknown }).severity === 'P1');
        if (p1) return reply.code(409).send({ code: 'rollout_paused', message: 'P1 game-server alert is active; resolve or rollback before rollout' });
      } catch {
        return reply.code(503).send({ code: 'ops_unavailable', message: 'cannot evaluate rollout guard' });
      }
    }
    const revision = await repos.configs.advanceRollout(rolloutPercent as number, now());
    await audit('config.rollout.advance', `${revision.version}:${revision.rolloutPercent}`);
    return reply.send({ configVersion: revision.version, activatedAt: revision.activatedAt, rolloutPercent: revision.rolloutPercent });
  });

  app.post('/v1/admin/config/rollback', async (req, reply) => {
    if (!requireAdmin(req)) return reply.code(403).send({ code: 'forbidden', message: 'admin authorization required' });
    const version = (req.body as { version?: unknown } | null)?.version;
    if (typeof version !== 'string') return reply.code(400).send({ code: 'invalid_version', message: 'version required' });
    const revision = await repos.configs.rollback(version, now());
    if (!revision) return reply.code(404).send({ code: 'not_found', message: 'config version not found' });
    await audit('config.rollback', revision.version);
    return reply.send({ configVersion: revision.version, activatedAt: revision.activatedAt });
  });

  app.get('/health', async (_req, reply) => reply.send({ ok: true }));

  const gameEndpoint = options.gameEndpoint ?? process.env.SERPENT_GAME_ENDPOINT ?? 'ws://localhost:2567';
  registerMatchmaker(app, {
    secret,
    now,
    gameEndpoint,
    isTokenRevoked: (fingerprint) => repos.tokenRevocations.isRevoked(fingerprint, now()),
    isUserBanned: (userId) => repos.users.isBanned(userId, now()),
    profileForTicket: async (userId) => {
      const [user, skinId] = await Promise.all([repos.users.get(userId), repos.cosmetics.selectedSkinId(userId)]);
      return { nickname: user?.nickname ?? null, skinId };
    },
    rateLimiter,
    targets: options.matchTargets ?? matchTargetsFromEnv(gameEndpoint),
  });

  return { app, repos, secret, internalSecret };
}
