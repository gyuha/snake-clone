import { createClient } from 'redis';
import type { MatchTarget, MatchTargetDirectory } from './matchmaker';

const KEY_PREFIX = 'serpent:room-registry:';
const RESERVATION_PREFIX = 'serpent:room-reservations:';
const RESERVE_SLOT_SCRIPT = `
local players = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local reserved = tonumber(redis.call('GET', KEYS[1]) or '0')
if players + reserved >= capacity then return 0 end
local next = redis.call('INCR', KEYS[1])
if next == 1 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

/** Redis에 TTL과 함께 게시하는 게임 서버의 현재 수용량 계약. */
export interface RoomRegistryEntry extends MatchTarget {
  instanceId: string;
  updatedAt: number;
}

export interface MatchTargetDirectoryWithClose {
  targets: MatchTargetDirectory;
  close(): Promise<void>;
}

export function parseRoomRegistryEntry(value: string): RoomRegistryEntry | null {
  try {
    const entry = JSON.parse(value) as Partial<RoomRegistryEntry>;
    if (typeof entry.instanceId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(entry.instanceId) ||
      typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt) ||
      typeof entry.region !== 'string' || entry.region.length === 0 ||
      typeof entry.endpoint !== 'string' || !/^wss?:\/\//.test(entry.endpoint) ||
      typeof entry.roomName !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(entry.roomName) ||
      typeof entry.players !== 'number' || !Number.isInteger(entry.players) || entry.players < 0 ||
      typeof entry.capacity !== 'number' || !Number.isInteger(entry.capacity) || entry.capacity <= 0 ||
      (entry.averageRttMs !== null && (typeof entry.averageRttMs !== 'number' || !Number.isFinite(entry.averageRttMs) || entry.averageRttMs < 0)) ||
      (entry.draining !== undefined && typeof entry.draining !== 'boolean') ||
      (entry.modes !== undefined && (!Array.isArray(entry.modes) || !entry.modes.every((mode) => typeof mode === 'string')))) return null;
    return entry as RoomRegistryEntry;
  } catch {
    return null;
  }
}

/**
 * 살아 있는 Redis registry만 매치 타깃으로 사용한다. Redis 연결·조회 실패는 빈 목록으로
 * 처리해 기존 Room을 건드리지 않으면서 신규 매칭만 멈춘다 (PRD §9.7).
 */
export async function createRedisMatchTargetDirectory(url: string): Promise<MatchTargetDirectoryWithClose> {
  const client = createClient({ url });
  client.on('error', (error) => console.error('[room-registry] redis error', error));
  await client.connect();
  const targets = (async () => {
      try {
        const entries: MatchTarget[] = [];
        for await (const key of client.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
          const value = await client.get(key);
          if (!value) continue;
          const entry = parseRoomRegistryEntry(value);
          if (entry) entries.push({ ...entry, targetId: entry.instanceId });
        }
        return entries;
      } catch (error) {
        console.error('[room-registry] unavailable; stopping new matching', error);
        return [];
      }
    }) as MatchTargetDirectory;
  targets.reserve = async (target, ttlMs) => {
    if (!target.targetId) return false;
    try {
      return await client.eval(RESERVE_SLOT_SCRIPT, {
        keys: [`${RESERVATION_PREFIX}${target.targetId}`],
        arguments: [String(target.players), String(target.capacity), String(ttlMs)],
      }) === 1;
    } catch (error) {
      console.error('[room-registry] reservation unavailable; stopping new matching', error);
      return false;
    }
  };
  return {
    targets,
    close: async () => { if (client.isOpen) await client.quit(); },
  };
}

export async function createMatchTargetDirectoryFromEnv(defaultEndpoint: string): Promise<MatchTargetDirectoryWithClose> {
  const url = process.env.REDIS_URL;
  if (url) return createRedisMatchTargetDirectory(url);
  const { matchTargetsFromEnv } = await import('./matchmaker');
  return { targets: matchTargetsFromEnv(defaultEndpoint), close: async () => {} };
}
