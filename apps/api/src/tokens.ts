import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC 서명 토큰 (PRD §11.1, §14.2).
 * 게스트 access/refresh와 매치 joinToken이 같은 서명 방식을 공유한다.
 * 페이로드는 자유 형식이며 exp(ms epoch)를 반드시 포함한다.
 */

export interface TokenPayload {
  /** 주체 (userId) */
  sub: string;
  /** 토큰 용도 — 검증 시 기대 타입과 일치해야 한다 */
  type: string;
  /** 만료 (ms epoch) */
  exp: number;
  [key: string]: unknown;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function createToken(payload: TokenPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body, secret)}`;
}

/**
 * 서명·만료·타입 검증. 실패 시 null (이유는 호출 측에서 구분 불필요 — 일괄 거부).
 */
export function verifyToken(
  token: string,
  secret: string,
  expectedType: string,
  now = Date.now(),
): TokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.type !== expectedType) return null;
    if (payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}
