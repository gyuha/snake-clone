import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createToken, tokenFingerprint, verifyToken } from './tokens';
import type { RateLimiter } from './rateLimit';

/** joinToken 수명 — 발급 직후 접속 전제 (PRD §11.3: 짧은 TTL) */
const JOIN_TOKEN_TTL_MS = 15_000;

export interface MatchTarget {
  /** API가 공개하는 논리적 리전 식별자 (예: kr-seoul). */
  region: string;
  endpoint: string;
  roomName: string;
  /** 현재 프로세스/registry가 보고한 실제 인간 수와 정원. */
  players: number;
  capacity: number;
  /** 서버가 관측한 평균 RTT. 미관측 타깃은 같은 리전의 관측 타깃보다 후순위다. */
  averageRttMs: number | null;
  draining?: boolean;
  modes?: string[];
  /** registry 내부 식별자. 클라이언트나 ticket에는 노출하지 않는다. */
  targetId?: string;
}

export type MatchTargetDirectory = (() => Promise<MatchTarget[]>) & {
  /** join token 유효 시간 동안 수용량 슬롯을 원자적으로 예약한다. */
  reserve?: (target: MatchTarget, ttlMs: number) => Promise<boolean>;
};

/**
 * 환경 기반 고정 디렉터리는 단일 서버 개발용 폴백이다. 운영에서는 registry/heartbeat
 * 어댑터를 주입해 같은 계약으로 실시간 수용량을 공급한다.
 */
export function matchTargetsFromEnv(defaultEndpoint: string): MatchTargetDirectory {
  const raw = process.env.SERPENT_MATCH_TARGETS;
  if (!raw) return async () => [{
    region: process.env.SERPENT_REGION ?? 'local', endpoint: defaultEndpoint, roomName: 'arena',
    players: 0, capacity: Number(process.env.SERPENT_ROOM_CAPACITY ?? 60), averageRttMs: null,
  }];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('must be an array');
    const targets = parsed.filter(isMatchTarget);
    if (targets.length === 0) throw new Error('contains no valid target');
    return async () => targets;
  } catch (error) {
    throw new Error(`invalid SERPENT_MATCH_TARGETS: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isMatchTarget(value: unknown): value is MatchTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Partial<MatchTarget>;
  return typeof target.region === 'string' && target.region.length > 0 &&
    typeof target.endpoint === 'string' && /^wss?:\/\//.test(target.endpoint) &&
    typeof target.roomName === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(target.roomName) &&
    typeof target.players === 'number' && Number.isInteger(target.players) && target.players >= 0 &&
    typeof target.capacity === 'number' && Number.isInteger(target.capacity) && target.capacity > 0 &&
    (target.averageRttMs === null || (typeof target.averageRttMs === 'number' && target.averageRttMs >= 0)) &&
    (target.draining === undefined || typeof target.draining === 'boolean') &&
    (target.modes === undefined || (Array.isArray(target.modes) && target.modes.every((mode) => typeof mode === 'string')));
}

export function selectMatchTarget(targets: MatchTarget[], mode: string, preferredRegion: string): MatchTarget | null {
  return rankedMatchTargets(targets, mode, preferredRegion)[0] ?? null;
}

/** 예약 실패 시 다음 후보로 즉시 넘어갈 수 있도록 안정적으로 순위화한다. */
export function rankedMatchTargets(targets: MatchTarget[], mode: string, preferredRegion: string): MatchTarget[] {
  return targets.filter((target) =>
    !target.draining && target.players < target.capacity && (!target.modes || target.modes.includes(mode)),
  ).sort((a, b) => {
    // 지역 우선, 그 다음 관측 RTT, 마지막으로 낮은 점유율. 안정적인 tie break를 둔다.
    const regionA = preferredRegion !== 'auto' && a.region === preferredRegion ? 0 : 1;
    const regionB = preferredRegion !== 'auto' && b.region === preferredRegion ? 0 : 1;
    const rttA = a.averageRttMs ?? Number.POSITIVE_INFINITY;
    const rttB = b.averageRttMs ?? Number.POSITIVE_INFINITY;
    return regionA - regionB || rttA - rttB || a.players / a.capacity - b.players / b.capacity || a.region.localeCompare(b.region);
  });
}

export interface MatchmakerOptions {
  secret: string;
  /** game-server WS 엔드포인트 (단일 로컬 리전) */
  gameEndpoint: string;
  now: () => number;
  isTokenRevoked: (fingerprint: string) => Promise<boolean>;
  isUserBanned: (userId: string) => Promise<boolean>;
  /** 매치 입장에 사용할 서버 권위 표시 프로필. joinToken에 서명해 game-server로 전달한다. */
  profileForTicket: (userId: string) => Promise<{ nickname: string | null; skinId: number }>;
  rateLimiter: RateLimiter;
  targets: MatchTargetDirectory;
}

/**
 * 매치메이커 (PRD §11.3, FR-MATCH-01/02 — 단일 리전 MVP).
 * 티켓 발급: roomId/endpoint + 만료·1회용 joinToken(roomName·userId·nonce 바인딩).
 * 토큰 검증과 1회 사용 강제는 game-server 측(onAuth)에서 수행된다.
 */
export function registerMatchmaker(app: FastifyInstance, opts: MatchmakerOptions): void {
  const authenticate = async (req: FastifyRequest): Promise<string | null> => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return null;
    const token = h.slice(7);
    if (await opts.isTokenRevoked(tokenFingerprint(token))) return null;
    const payload = verifyToken(token, opts.secret, 'access', opts.now());
    if (payload && (await opts.isUserBanned(payload.sub))) return null;
    return payload?.sub ?? null;
  };

  // endpoint는 티켓에만 넣고, 로비에는 지역·혼잡·관측 RTT만 제공한다.
  app.get('/v1/matches/regions', async (_req, reply) => {
    const regions = (await opts.targets())
      .filter((target) => !target.draining)
      .map(({ region, players, capacity, averageRttMs, modes }) => ({ region, players, capacity, averageRttMs, modes: modes ?? ['classic'] }));
    return reply.send({ regions });
  });

  app.post('/v1/matches/tickets', async (req, reply) => {
    const userId = await authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });
    if (!(await opts.rateLimiter.consume([{ scope: 'ticket-user', key: userId, limit: 30, windowMs: 60_000 }]))) {
      return reply.code(429).send({ code: 'ticket_rate_limited', message: 'try again later' });
    }

    const body = (req.body ?? {}) as { mode?: unknown; preferredRegion?: unknown };
    const mode = typeof body.mode === 'string' ? body.mode : 'classic';
    const preferredRegion = typeof body.preferredRegion === 'string' && /^[a-z0-9-]{1,32}$/i.test(body.preferredRegion)
      ? body.preferredRegion
      : 'auto';
    let target: MatchTarget | null = null;
    for (const candidate of rankedMatchTargets(await opts.targets(), mode, preferredRegion)) {
      if (!opts.targets.reserve || await opts.targets.reserve(candidate, JOIN_TOKEN_TTL_MS)) {
        target = candidate;
        break;
      }
    }
    if (!target) return reply.code(503).send({ code: 'no_match_capacity', message: 'no eligible match target' });
    const expiresAtMs = opts.now() + JOIN_TOKEN_TTL_MS;
    const profile = await opts.profileForTicket(userId);
    const joinToken = createToken(
      {
        sub: userId,
        type: 'join',
        exp: expiresAtMs,
        roomName: target.roomName,
        nonce: randomUUID(),
        nickname: profile.nickname,
        skinId: profile.skinId,
      },
      opts.secret,
    );

    return reply.code(201).send({
      ticketId: randomUUID(),
      mode,
      roomName: target.roomName,
      endpoint: target.endpoint,
      region: target.region,
      capacity: target.capacity,
      joinToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  });
}
