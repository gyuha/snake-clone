/** api 게스트 세션·매치 티켓 클라이언트 (PRD §3.2 준비/매칭 단계) */

export interface GuestSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export interface MatchTicket {
  ticketId: string;
  roomName: string;
  endpoint: string;
  joinToken: string;
  expiresAt: string;
}

const STORAGE_KEY = 'serpent.guest';

export function apiBase(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('api') ?? 'http://localhost:8080';
}

/** 저장된 게스트 세션 회수 → 갱신 → 실패 시 새 게스트 생성 (FR-AUTH-01) */
export async function ensureGuestSession(base: string): Promise<GuestSession> {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const session = JSON.parse(stored) as GuestSession;
      const res = await fetch(`${base}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (res.ok) {
        const fresh = (await res.json()) as GuestSession;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        return fresh;
      }
    } catch {
      // 갱신 실패 → 새 게스트
    }
  }
  const res = await fetch(`${base}/v1/auth/guest`, { method: 'POST' });
  if (!res.ok) throw new Error(`guest creation failed (${res.status})`);
  const session = (await res.json()) as GuestSession;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export async function requestTicket(base: string, accessToken: string): Promise<MatchTicket> {
  const res = await fetch(`${base}/v1/matches/tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'classic' }),
  });
  if (!res.ok) throw new Error(`ticket failed (${res.status})`);
  return (await res.json()) as MatchTicket;
}
