import { performance } from 'node:perf_hooks';
import { createGameConfig } from '@serpent/config';
import { Rng, Simulation } from '@serpent/game-core';
import { describe, expect, it } from 'vitest';
import { BotController, defaultBotParams } from '../bots/BotController';

/**
 * 틱 예산 계측 (loop.md C6, PRD §21.6: 60명 P95 < 10ms · §17.2 L-01/L-02).
 * 60 스네이크(봇 AI 전원 구동) + 기본 펠릿 밀도 + 상위 5마리 긴 몸통 조건에서
 * 1,000틱의 per-tick 처리 시간(봇 판단 포함)을 계측한다.
 * 계측 하네스이므로 performance.now 사용(결정성 계약 밖).
 */

const SNAKES = 60;
const WARMUP = 200;
const MEASURE = 1_000;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

describe('tick budget — 60 snakes', () => {
  it('P95 < 10ms (봇 판단 8Hz 포함)', () => {
    const config = createGameConfig(); // 6,000² 아레나 · 펠릿 1,200
    const sim = new Simulation(config, 424242);
    sim.seedPellets();

    const rng = new Rng(7);
    const bots: BotController[] = [];
    for (let i = 0; i < SNAKES; i++) {
      const id = `b${i}`;
      const s = sim.addSnake(id);
      // 상위 5마리는 긴 몸통 worst-case 근사 (질량 대량 부여 → 세그먼트 다수)
      if (i < 5) s.mass = 800;
      bots.push(new BotController(sim, id, rng, defaultBotParams));
    }

    const respawn = (id: string) => {
      sim.removeSnake(id);
      const s = sim.addSnake(id);
      if (Number(id.slice(1)) < 5) s.mass = 800;
    };

    const durations: number[] = [];
    for (let t = 0; t < WARMUP + MEASURE; t++) {
      const start = performance.now();
      // 봇 판단 8Hz ≈ 2.5틱마다 — 실제 룸과 동일하게 틱 사이에 섞인다
      if (t % 3 === 0) {
        for (const b of bots) b.decide();
      }
      const events = sim.step();
      const elapsed = performance.now() - start;
      for (const d of events.deaths) respawn(d.snakeId);
      if (t >= WARMUP) durations.push(elapsed);
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const max = sorted[sorted.length - 1]!;
    console.log(
      `[tick-budget] snakes=${SNAKES} ticks=${MEASURE} · P50=${p50.toFixed(2)}ms P95=${p95.toFixed(2)}ms P99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );

    expect(p95).toBeLessThan(10);
    // PRD §21.6: 최대 tick < 40ms (부하 중 50ms 초과 지속 없음)
    expect(max).toBeLessThan(40);
  }, 120_000);
});
