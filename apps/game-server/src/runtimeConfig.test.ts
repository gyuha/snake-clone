import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameConfig, defaultGameConfig } from '@serpent/config';
import { configFromPayload, loadRuntimeConfig } from './runtimeConfig';

afterEach(() => vi.unstubAllGlobals());

describe('runtime config', () => {
  it('검증된 API 설정만 새 Room 런타임 설정으로 수용한다', () => {
    const config = createGameConfig({ version: '2026-07-14.1' });
    expect(configFromPayload({ config })).toEqual(config);
    expect(configFromPayload({ config: { ...defaultGameConfig, simulation: { ...defaultGameConfig.simulation, fixedDeltaMs: 1 } } })).toBeNull();
    expect(configFromPayload({})).toBeNull();
  });

  it('단계 배포 키를 설정 조회 헤더로 전달한다', async () => {
    const config = createGameConfig({ version: 'canary' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadRuntimeConfig('https://config.test/v1/config/client', 'instance-a')).resolves.toEqual(config);
    expect(fetchMock).toHaveBeenCalledWith('https://config.test/v1/config/client', { headers: { 'x-serpent-rollout-key': 'instance-a' } });
  });
});
