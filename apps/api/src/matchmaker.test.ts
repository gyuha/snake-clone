import { describe, expect, it } from 'vitest';
import { buildApi } from './server';
import { selectMatchTarget, type MatchTarget } from './matchmaker';
import { createToken } from './tokens';

const targets: MatchTarget[] = [
  { region: 'kr-seoul', endpoint: 'wss://seoul.example/room', roomName: 'arena', players: 45, capacity: 60, averageRttMs: 35, modes: ['classic'] },
  { region: 'jp-tokyo', endpoint: 'wss://tokyo.example/room', roomName: 'arena', players: 2, capacity: 60, averageRttMs: 8, modes: ['classic'] },
  { region: 'kr-draining', endpoint: 'wss://draining.example/room', roomName: 'arena', players: 1, capacity: 60, averageRttMs: 1, draining: true },
];

describe('match target selection (FR-MATCH-01)', () => {
  it('명시 리전을 우선하고, auto에서는 RTT와 수용량으로 선택한다', () => {
    expect(selectMatchTarget(targets, 'classic', 'kr-seoul')?.region).toBe('kr-seoul');
    expect(selectMatchTarget(targets, 'classic', 'auto')?.region).toBe('jp-tokyo');
    expect(selectMatchTarget(targets, 'ranked', 'auto')).toBeNull();
  });

  it('티켓은 선택한 target의 endpoint·region·roomName만 발급한다', async () => {
    const api = buildApi({ secret: 'target-secret', matchTargets: async () => targets });
    const guest = (await api.app.inject({ method: 'POST', url: '/v1/auth/guest' })).json() as { accessToken: string };
    const response = await api.app.inject({
      method: 'POST', url: '/v1/matches/tickets', headers: { authorization: `Bearer ${guest.accessToken}` },
      payload: { mode: 'classic', preferredRegion: 'kr-seoul' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ region: 'kr-seoul', endpoint: 'wss://seoul.example/room', roomName: 'arena', capacity: 60 });
  });

  it('로비 리전 목록에는 내부 endpoint와 drain 대상이 노출되지 않는다', async () => {
    const api = buildApi({ secret: 'target-secret', matchTargets: async () => targets });
    const response = await api.app.inject({ method: 'GET', url: '/v1/matches/regions' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ regions: [
      { region: 'kr-seoul', players: 45, capacity: 60, averageRttMs: 35, modes: ['classic'] },
      { region: 'jp-tokyo', players: 2, capacity: 60, averageRttMs: 8, modes: ['classic'] },
    ] });
  });

  it('1,000명 동시 Play burst에서도 TTL 예약 용량을 초과 발급하지 않는다 (PRD §17.2 L-05)', async () => {
    const capacity = 600;
    let reserved = 0;
    const directory = Object.assign(
      async () => [{ region: 'kr-seoul', endpoint: 'wss://seoul.example/room', roomName: 'arena', players: 0, capacity, averageRttMs: 12, targetId: 'kr-1' }],
      { reserve: async () => {
        if (reserved >= capacity) return false;
        reserved++;
        return true;
      } },
    );
    const secret = 'burst-secret';
    const api = buildApi({ secret, matchTargets: directory });
    const expires = Date.now() + 60_000;
    const responses = await Promise.all(Array.from({ length: 1_000 }, (_, index) => api.app.inject({
      method: 'POST', url: '/v1/matches/tickets',
      headers: { authorization: `Bearer ${createToken({ sub: `burst-${index}`, type: 'access', exp: expires }, secret)}` },
      payload: { mode: 'classic', preferredRegion: 'kr-seoul' },
    })));
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(capacity);
    expect(responses.filter((response) => response.statusCode === 503)).toHaveLength(400);
    expect(reserved).toBe(capacity);
    await api.app.close();
  }, 30_000);
});
