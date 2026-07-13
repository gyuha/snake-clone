import { describe, expect, it } from 'vitest';
import { createGameConfig, defaultGameConfig, validateGameConfig } from './index';

describe('GameConfig', () => {
  it('기본값이 PRD 초기값과 일치한다', () => {
    expect(defaultGameConfig.simulation.tickRate).toBe(20);
    expect(defaultGameConfig.simulation.fixedDeltaMs).toBe(1000 / defaultGameConfig.simulation.tickRate);
    expect(defaultGameConfig.snake.baseSpeed).toBe(180);
    expect(defaultGameConfig.snake.boostSpeed).toBe(270);
    expect(defaultGameConfig.interest.despawnRadius).toBeGreaterThan(defaultGameConfig.interest.radius);
  });

  it('섹션 단위 오버라이드가 병합된다', () => {
    const cfg = createGameConfig({ arena: { width: 20000, height: 20000, boundary: 'lethal' } });
    expect(cfg.arena.width).toBe(20000);
    expect(cfg.snake.baseSpeed).toBe(defaultGameConfig.snake.baseSpeed);
  });

  it('운영 활성화 전 위험한 설정 조합을 거부한다', () => {
    expect(validateGameConfig(defaultGameConfig)).toEqual({ ok: true });
    expect(validateGameConfig(createGameConfig({
      simulation: { ...defaultGameConfig.simulation, fixedDeltaMs: 40 },
    }))).toEqual({ ok: false, error: 'invalid simulation rates' });
    expect(validateGameConfig(createGameConfig({
      interest: { ...defaultGameConfig.interest, despawnRadius: 100 },
    }))).toEqual({ ok: false, error: 'invalid interest range' });
  });
});
