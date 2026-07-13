import { defaultGameConfig, type GameConfig, validateGameConfig } from '@serpent/config';

/** API의 공개 설정 응답을 게임 서버가 수용할 수 있는지 검증한다. */
export function configFromPayload(payload: unknown): GameConfig | null {
  if (!payload || typeof payload !== 'object') return null;
  const config = (payload as { config?: unknown }).config;
  if (!config || typeof config !== 'object') return null;
  const validation = validateGameConfig(config as GameConfig);
  return validation.ok ? (config as GameConfig) : null;
}

/**
 * 새 게임 서버 프로세스는 활성 configVersion을 한 번 로드한 후 새 Room에만 쓴다.
 * 기존 Room은 자신의 configVersion을 계속 유지하므로 drain/restart와 결합한다.
 */
export async function loadRuntimeConfig(configUrl = process.env.SERPENT_CONFIG_URL, rolloutKey = process.env.SERPENT_CONFIG_ROLLOUT_KEY): Promise<GameConfig> {
  if (!configUrl) return defaultGameConfig;
  const response = await fetch(configUrl, { headers: rolloutKey ? { 'x-serpent-rollout-key': rolloutKey } : undefined });
  if (!response.ok) throw new Error(`config fetch failed: ${response.status}`);
  const config = configFromPayload(await response.json());
  if (!config) throw new Error('config payload failed validation');
  return config;
}
