import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createToken, verifyToken } from './tokens';

/** joinToken 수명 — 발급 직후 접속 전제 (PRD §11.3: 짧은 TTL) */
const JOIN_TOKEN_TTL_MS = 15_000;

export interface MatchmakerOptions {
  secret: string;
  /** game-server WS 엔드포인트 (단일 로컬 리전) */
  gameEndpoint: string;
  now: () => number;
}

/**
 * 매치메이커 (PRD §11.3, FR-MATCH-01/02 — 단일 리전 MVP).
 * 티켓 발급: roomId/endpoint + 만료·1회용 joinToken(roomName·userId·nonce 바인딩).
 * 토큰 검증과 1회 사용 강제는 game-server 측(onAuth)에서 수행된다.
 */
export function registerMatchmaker(app: FastifyInstance, opts: MatchmakerOptions): void {
  const authenticate = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return null;
    const payload = verifyToken(h.slice(7), opts.secret, 'access', opts.now());
    return payload?.sub ?? null;
  };

  app.post('/v1/matches/tickets', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'access token required' });

    const body = (req.body ?? {}) as { mode?: unknown };
    const mode = typeof body.mode === 'string' ? body.mode : 'classic';
    const expiresAtMs = opts.now() + JOIN_TOKEN_TTL_MS;
    const joinToken = createToken(
      {
        sub: userId,
        type: 'join',
        exp: expiresAtMs,
        roomName: 'arena',
        nonce: randomUUID(),
      },
      opts.secret,
    );

    return reply.code(201).send({
      ticketId: randomUUID(),
      mode,
      roomName: 'arena',
      endpoint: opts.gameEndpoint,
      joinToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  });
}
