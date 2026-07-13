import { performance } from 'node:perf_hooks';
import { createGameConfig } from '@serpent/config';
import { Rng, Simulation } from '@serpent/game-core';
import { describe, expect, it } from 'vitest';
import { BotController, defaultBotParams } from '../bots/BotController';

/**
 * 틱 예산 계측 (loop.md C6, PRD §21.6: 60명 P95 < 10ms · §17.2 L-01/L-02).
 * 인간 60명 + 서버 봇 20명 + 기본 펠릿 밀도 + 상위 10마리 긴 몸통 조건에서
 * 1,000틱의 per-tick 처리 시간(봇 판단 포함)을 계측한다.
 * 계측 하네스이므로 performance.now 사용(결정성 계약 밖).
 */

const WARMUP = 200;
const MEASURE = 1_000;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function measureTickBudget(humans: number, botCount: number) {
    const config = createGameConfig(); // 6,000² 아레나 · 펠릿 1,200
    const sim = new Simulation(config, 424242);
    sim.seedPellets();

    const rng = new Rng(7);
    const bots: BotController[] = [];
    for (let i = 0; i < humans; i++) {
      const id = `h${i}`;
      const s = sim.addSnake(id);
      // 상위 10마리는 긴 몸통 worst-case 근사 (질량 대량 부여 → 세그먼트 다수)
      if (i < 10) s.mass = 800;
    }
    for (let i = 0; i < botCount; i++) {
      const id = `b${i}`;
      const s = sim.addSnake(id);
      if (i < 2) s.mass = 800;
      bots.push(new BotController(sim, id, rng, defaultBotParams));
    }

    const respawn = (id: string) => {
      sim.removeSnake(id);
      const s = sim.addSnake(id);
      const number = Number(id.slice(1));
      if ((id.startsWith('h') && number < 10) || (id.startsWith('b') && number < 2)) s.mass = 800;
    };

    const durations: number[] = [];
    for (let t = 0; t < WARMUP + MEASURE; t++) {
      const start = performance.now();
      // 봇 판단 8Hz ≈ 2.5틱마다 — 실제 룸과 동일하게 틱 사이에 섞인다
      if (t % 3 === 0) {
        for (const b of bots) b.decide();
      }
      // 실제 클라이언트와 같은 입력 중심 경로를 인간 플레이어에 적용한다.
      for (let i = 0; i < humans; i++) {
        sim.setInput(`h${i}`, {
          dirX: Math.cos(t / (17 + (i % 9)) + i),
          dirY: Math.sin(t / (17 + (i % 9)) + i),
          boost: (t + i * 11) % 120 < 8,
        });
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
      `[tick-budget] humans=${humans} bots=${botCount} total=${humans + botCount} ticks=${MEASURE} · P50=${p50.toFixed(2)}ms P95=${p95.toFixed(2)}ms P99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
    );

    return { p95, max };
}

/** PRD §17.2 L-04: 한 인스턴스에서 Room 수를 단계 증가시킨 수용량 곡선. */
function measureRoomCapacity(roomCount: number) {
  const config = createGameConfig();
  const rooms = Array.from({ length: roomCount }, (_, roomIndex) => {
    const sim = new Simulation(config, 90_000 + roomIndex);
    sim.seedPellets();
    for (let player = 0; player < 60; player++) sim.addSnake(`r${roomIndex}-p${player}`);
    return sim;
  });
  const durations: number[] = [];
  const warmup = 30;
  const measure = 120;
  for (let tick = 0; tick < warmup + measure; tick++) {
    const started = performance.now();
    for (let roomIndex = 0; roomIndex < rooms.length; roomIndex++) {
      const room = rooms[roomIndex]!;
      for (let player = 0; player < 60; player++) {
        room.setInput(`r${roomIndex}-p${player}`, {
          dirX: Math.cos(tick / 19 + player), dirY: Math.sin(tick / 19 + player), boost: false,
        });
      }
      room.step();
    }
    if (tick >= warmup) durations.push(performance.now() - started);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = percentile(sorted, 0.95);
  const max = sorted.at(-1)!;
  console.log(`[room-capacity] rooms=${roomCount} humans=60/room · P95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`);
  return { p95, max };
}

describe('tick budget', () => {
  it('60 humans + 20 bots: P95 < 10ms (입력 처리·봇 판단 8Hz 포함)', () => {
    const { p95, max } = measureTickBudget(60, 20);
    expect(p95).toBeLessThan(10);
    // PRD §21.6: 최대 tick < 40ms (부하 중 50ms 초과 지속 없음)
    expect(max).toBeLessThan(40);
  }, 120_000);

  it('100 entities: P95 < 20ms', () => {
    const { p95, max } = measureTickBudget(80, 20);
    expect(p95).toBeLessThan(20);
    expect(max).toBeLessThan(40);
  }, 120_000);

  it('5→10→15 Room 수용량 곡선은 20Hz CPU 예산 안에 유지된다 (PRD §17.2 L-04)', () => {
    for (const rooms of [5, 10, 15]) {
      const { p95, max } = measureRoomCapacity(rooms);
      // 50ms tick 중 60% CPU 예산(30ms)을 목표로 하되, 공유 CI의 짧은 GC spike는
      // 45ms까지 허용한다. 이보다 지속적으로 크면 인스턴스 Room 상한을 낮춰야 한다.
      expect(p95).toBeLessThan(30);
      expect(max).toBeLessThan(45);
    }
  }, 120_000);
});
