import { describe, expect, it } from 'vitest';
import { parseRoomRegistryEntry } from './roomRegistry';

describe('Redis room registry contract', () => {
  it('유효한 heartbeat만 매치 타깃으로 수용한다', () => {
    expect(parseRoomRegistryEntry(JSON.stringify({
      instanceId: 'game-kr-1', updatedAt: 1, region: 'kr-seoul', endpoint: 'wss://kr.example/ws', roomName: 'arena',
      players: 12, capacity: 60, averageRttMs: 24, modes: ['classic'], draining: false,
    }))).toMatchObject({ instanceId: 'game-kr-1', players: 12 });
    expect(parseRoomRegistryEntry('{"instanceId":"bad","players":-1}')).toBeNull();
    expect(parseRoomRegistryEntry('not-json')).toBeNull();
  });
});
