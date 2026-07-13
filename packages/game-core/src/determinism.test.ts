import { createGameConfig } from '@serpent/config';
import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import type { SimulationSnapshot } from './types';

/**
 * PRD §21.6 결정적 시뮬레이션 테스트:
 * 동일 seed + 동일 입력 로그 → 동일 tick 결과.
 */
function runSimulation(opts: { seed: number; ticks: number }): SimulationSnapshot {
  const config = createGameConfig({
    arena: { width: 3000, height: 3000, boundary: 'lethal' },
    pellets: { targetCount: 200, chunkSync: true, respawnBudgetPerTick: 10, baseValue: 1, radius: 6 },
  });
  const sim = new Simulation(config, opts.seed);
  sim.seedPellets();
  sim.addSnake('p1');
  sim.addSnake('p2');
  sim.addSnake('p3');

  for (let t = 0; t < opts.ticks; t++) {
    // 입력은 틱의 결정적 함수 (스크립트된 입력 로그와 동등)
    sim.setInput('p1', { dirX: Math.cos(t / 17), dirY: Math.sin(t / 17), boost: t % 40 < 8 });
    sim.setInput('p2', { dirX: Math.cos(-t / 23), dirY: Math.sin(-t / 23), boost: t % 60 < 5 });
    sim.setInput('p3', { dirX: Math.cos(t / 31 + 2), dirY: Math.sin(t / 31 + 2), boost: false });
    sim.step();
  }
  return sim.snapshot();
}

describe('결정성', () => {
  it('동일 seed와 입력에서 1,000틱 결과가 완전히 동일하다', () => {
    const first = runSimulation({ seed: 1234, ticks: 1000 });
    const second = runSimulation({ seed: 1234, ticks: 1000 });
    expect(second).toEqual(first);
  });

  it('다른 seed는 다른 세계를 만든다 (시드가 실제로 작동함을 확인)', () => {
    const a = runSimulation({ seed: 1, ticks: 50 });
    const b = runSimulation({ seed: 2, ticks: 50 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});
