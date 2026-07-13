/** api 게스트 세션·매치 티켓 클라이언트 (PRD §3.2 준비/매칭 단계) */
import type { GameConfig } from '@serpent/config';

export interface GuestSession {
  userId: string;
  accessToken: string;
  /** 운영 cookie 모드에서는 HttpOnly cookie에만 존재한다. */
  refreshToken?: string;
}

export interface MatchTicket {
  ticketId: string;
  roomName: string;
  endpoint: string;
  region: string;
  capacity: number;
  joinToken: string;
  expiresAt: string;
}
export interface MatchRegion { region: string; players: number; capacity: number; averageRttMs: number | null; modes: string[] }

export interface PlayerProfile {
  userId: string;
  nickname: string | null;
  selectedSkinId: number;
  stats: {
    games: number;
    bestScore: number;
    bestSurvivalMs: number;
    totalKills: number;
  };
}

export interface LeaderboardEntry { userId: string; nickname: string | null; score: number }
export interface Leaderboard { scope: 'daily' | 'weekly' | 'all'; entries: LeaderboardEntry[]; selfRank: number | null }
export interface Mission { id: string; title: string; target: number; progress: number; reward: string; claimed: boolean }
export interface Announcement { message: string; updatedAt: number }
export interface Cosmetics { skins: { id: number; owned: boolean }[]; selectedSkinId: number }
export interface Friend { userId: string; nickname: string | null }
export interface LiveEvent { id: string; title: string; theme: string; startsAt: number; endsAt: number; targetRegions: string[] }
export interface SeasonProgress { season: { id: string; title: string; startsAt: number; endsAt: number }; matches: number; claimedLevels: number[] }

export type FunnelEventName =
  | 'landing_view' | 'play_click' | 'guest_created' | 'ticket_created' | 'room_joined'
  | 'first_input' | 'match_ended' | 'retry_click' | 'account_linked';

const STORAGE_KEY = 'serpent.guest';
const pendingSessions = new Map<string, Promise<GuestSession>>();

export function apiBase(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('api') ?? 'http://localhost:8080';
}

/** 저장된 게스트 세션 회수 → 갱신 → 실패 시 새 게스트 생성 (FR-AUTH-01) */
export async function ensureGuestSession(base: string): Promise<GuestSession> {
  const pending = pendingSessions.get(base);
  if (pending) return pending;
  const task = restoreGuestSession(base);
  pendingSessions.set(base, task);
  try {
    return await task;
  } finally {
    if (pendingSessions.get(base) === task) pendingSessions.delete(base);
  }
}

/** 여러 화면 effect가 동시에 실행돼도 refresh rotation은 한 번만 수행한다. */
async function restoreGuestSession(base: string): Promise<GuestSession> {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const session = JSON.parse(stored) as GuestSession;
      const res = await fetch(`${base}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: session.refreshToken ? JSON.stringify({ refreshToken: session.refreshToken }) : undefined,
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
  const res = await fetch(`${base}/v1/auth/guest`, { method: 'POST', credentials: 'include' });
  if (!res.ok) throw new Error(`guest creation failed (${res.status})`);
  const session = (await res.json()) as GuestSession;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  // 신규 익명 사용자만 퍼널 시작으로 기록한다. 복구/refresh 경로는 중복 집계를 피한다.
  void sendTelemetry(base, session.accessToken, 'guest_created').catch(() => undefined);
  return session;
}

export async function requestTicket(base: string, accessToken: string, preferredRegion = 'auto'): Promise<MatchTicket> {
  const res = await fetch(`${base}/v1/matches/tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'classic', preferredRegion }),
  });
  if (!res.ok) throw new Error(`ticket failed (${res.status})`);
  return (await res.json()) as MatchTicket;
}

export async function fetchMatchRegions(base: string): Promise<MatchRegion[]> {
  const res = await fetch(`${base}/v1/matches/regions`);
  if (!res.ok) throw new Error(`regions failed (${res.status})`);
  return ((await res.json()) as { regions: MatchRegion[] }).regions;
}

/** 로비/프로필용 낮은 빈도의 전적 조회 (S-02/S-07). */
export async function fetchProfile(base: string, accessToken: string): Promise<PlayerProfile> {
  const res = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`profile failed (${res.status})`);
  return (await res.json()) as PlayerProfile;
}

export async function deleteAccount(base: string, accessToken: string): Promise<void> {
  const res = await fetch(`${base}/v1/me`, { method: 'DELETE', headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`account deletion failed (${res.status})`);
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem('serpent.nickname');
  window.localStorage.removeItem('serpent.skin');
}

export async function fetchLeaderboard(base: string, accessToken: string, scope: Leaderboard['scope']): Promise<Leaderboard> {
  const res = await fetch(`${base}/v1/leaderboards/${scope}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`leaderboard failed (${res.status})`);
  return (await res.json()) as Leaderboard;
}

export async function fetchMissions(base: string, accessToken: string): Promise<Mission[]> {
  const res = await fetch(`${base}/v1/missions`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`missions failed (${res.status})`);
  return ((await res.json()) as { missions: Mission[] }).missions;
}

export async function fetchAnnouncement(base: string): Promise<Announcement | null> {
  const res = await fetch(`${base}/v1/announcements/current`);
  if (!res.ok) throw new Error(`announcement failed (${res.status})`);
  return ((await res.json()) as { announcement: Announcement | null }).announcement;
}

export async function fetchCosmetics(base: string, accessToken: string): Promise<Cosmetics> {
  const res = await fetch(`${base}/v1/cosmetics`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`cosmetics failed (${res.status})`);
  return res.json() as Promise<Cosmetics>;
}

export async function fetchFriends(base: string, accessToken: string): Promise<Friend[]> {
  const res = await fetch(`${base}/v1/friends`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`friends failed (${res.status})`);
  return ((await res.json()) as { friends: Friend[] }).friends;
}

export async function createFriendInvite(base: string, accessToken: string): Promise<string> {
  const res = await fetch(`${base}/v1/friends/invites`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`friend invite failed (${res.status})`);
  return (await res.json() as { inviteToken: string }).inviteToken;
}

export async function acceptFriendInvite(base: string, accessToken: string, inviteToken: string): Promise<void> {
  const res = await fetch(`${base}/v1/friends/invites/accept`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ inviteToken }) });
  if (!res.ok && res.status !== 409) throw new Error(`friend invite acceptance failed (${res.status})`);
}

export async function fetchActiveEvent(base: string, region?: string): Promise<LiveEvent | null> {
  const query = region ? `?region=${encodeURIComponent(region)}` : '';
  const res = await fetch(`${base}/v1/events/active${query}`);
  if (!res.ok) throw new Error(`event failed (${res.status})`);
  return ((await res.json()) as { event: LiveEvent | null }).event;
}

export async function fetchSeasonProgress(base: string, accessToken: string): Promise<{ progress: SeasonProgress | null; freeTrack: { level: number; matches: number; skinId: number }[] }> {
  const res = await fetch(`${base}/v1/seasons/current/progress`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`season progress failed (${res.status})`);
  return res.json() as Promise<{ progress: SeasonProgress | null; freeTrack: { level: number; matches: number; skinId: number }[] }>;
}

export async function claimSeasonLevel(base: string, accessToken: string, level: number): Promise<void> {
  const res = await fetch(`${base}/v1/seasons/current/claim/${level}`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`season claim failed (${res.status})`);
}

export async function claimMission(base: string, accessToken: string, id: string): Promise<void> {
  const res = await fetch(`${base}/v1/missions/${encodeURIComponent(id)}/claim`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`mission claim failed (${res.status})`);
}

export interface ClientFeatures { accountLink: boolean; missions: boolean; eventHud: boolean; binaryProtocol: boolean; }
export async function fetchClientConfig(base: string): Promise<{ config: GameConfig; features: ClientFeatures }> {
  const res = await fetch(`${base}/v1/config/client`);
  if (!res.ok) throw new Error(`config failed (${res.status})`);
  const body = await res.json() as { configVersion?: unknown; config?: unknown; features?: unknown };
  if (!body.config || typeof body.config !== 'object' || typeof body.configVersion !== 'string') {
    throw new Error('invalid config payload');
  }
  const config = body.config as GameConfig;
  if (config.version !== body.configVersion) throw new Error('config version mismatch');
  const features = body.features;
  if (!features || typeof features !== 'object' || Array.isArray(features) ||
    !['accountLink', 'missions', 'eventHud', 'binaryProtocol'].every((key) => typeof (features as Record<string, unknown>)[key] === 'boolean')) {
    throw new Error('invalid feature flags');
  }
  return { config, features: features as ClientFeatures };
}

/** 입장 전에 닉네임과 서버 검증된 기본 스킨 로드아웃을 함께 저장한다. */
export async function saveLoadout(base: string, accessToken: string, nickname: string, skinId: number): Promise<void> {
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const [profile, loadout] = await Promise.all([
    fetch(`${base}/v1/me`, { method: 'PATCH', headers, body: JSON.stringify({ nickname }) }),
    fetch(`${base}/v1/me/loadout`, { method: 'PUT', headers, body: JSON.stringify({ skinId }) }),
  ]);
  if (!profile.ok || !loadout.ok) throw new Error('profile save failed');
}

/** Room의 임시 세션 ID는 영속 userId로 신뢰하지 않고 운영 검토용 detail에만 남긴다. */
export async function submitReport(
  base: string,
  accessToken: string,
  report: { reason: 'abuse' | 'cheating' | 'inappropriate_name' | 'other'; detail: string },
): Promise<void> {
  const res = await fetch(`${base}/v1/reports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!res.ok) throw new Error(`report failed (${res.status})`);
}

/** 분석은 best-effort다. 실패가 매칭·렌더·재도전을 막지 않도록 호출자가 await하지 않는다. */
export async function sendTelemetry(base: string, accessToken: string, name: FunnelEventName): Promise<void> {
  await fetch(`${base}/v1/telemetry/batch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ name, clientTime: Date.now() }] }),
  });
}
