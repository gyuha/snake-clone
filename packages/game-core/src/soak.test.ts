import { createGameConfig } from '@serpent/config';
import { describe, expect, it } from 'vitest';
import { bodyLengthForMass } from './movement';
import { Simulation } from './simulation';

/**
 * 10분 시뮬 soak (loop.md C4, PRD §21.3 M1 "10분 자동 플레이 안정" · §17.1 Soak).
 * 12,000틱(= 10분 시뮬 시간) 동안 8마리가 자동 플레이(사망 시 재스폰)하며
 * 상태 불변식을 유지하는지 검증한다. 실시간이 아니라 시뮬 시간 기준.
 */

const SNAKES = 8;
const TICKS = 12_000;

const config = createGameConfig({
  pellets: { targetCount: 500, chunkSync: true, respawnBudgetPerTick: 30, baseValue: 1, radius: 6 },
});

describe('soak — 12,000틱 자동 플레이', () => {
  it('예외/NaN 없이 완주하고 불변식을 유지한다', () => {
    const sim = new Simulation(config, 20260713);
    sim.seedPellets();
    for (let i = 0; i < SNAKES; i++) sim.addSnake(`s${i}`);

    let respawns = 0;
    let maxPellets = 0;
    let minPelletsAfterWarmup = Infinity;

    for (let t = 0; t < TICKS; t++) {
      // 스크립트 조향: 뱀마다 위상이 다른 회전 + 간헐 부스트
      for (let i = 0; i < SNAKES; i++) {
        const id = `s${i}`;
        const s = sim.snakes.get(id);
        if (!s) continue;
        sim.setInput(id, {
          dirX: Math.cos(t / (23 + i * 7) + i),
          dirY: Math.sin(t / (23 + i * 7) + i),
          boost: (t + i * 13) % 90 < 10,
        });
      }

      const events = sim.step();

      // 사망 → 즉시 재스폰 (반복 플레이)
      for (const d of events.deaths) {
        sim.removeSnake(d.snakeId);
        sim.addSnake(d.snakeId);
        respawns++;
      }

      maxPellets = Math.max(maxPellets, sim.pellets.size);
      if (t > 100) minPelletsAfterWarmup = Math.min(minPelletsAfterWarmup, sim.pellets.size);

      // 주기 불변식 점검 (매 200틱)
      if (t % 200 === 0) {
        for (const s of sim.snakes.values()) {
          // (a) NaN/Infinity 좌표 없음
          expect(Number.isFinite(s.head.x)).toBe(true);
          expect(Number.isFinite(s.head.y)).toBe(true);
          expect(Number.isFinite(s.angle)).toBe(true);
          expect(Number.isFinite(s.mass)).toBe(true);
          for (const n of s.path) {
            expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
          }
          // (c) 경로 키포인트 무한 누적 없음: trim 규칙 상한의 2배 이내
          const keep = bodyLengthForMass(config, s.mass) + config.snake.segmentSpacing * 2;
          const maxNodes = Math.ceil(keep / config.snake.pathNodeMinDistance) * 2 + 4;
          expect(s.path.length).toBeLessThanOrEqual(maxNodes);
          // (d) 인덱스 세그먼트 수는 path 세그먼트 수와 일치 (살아있는 뱀)
          if (s.alive) {
            expect(sim.bodySegmentCount(s.id)).toBe(Math.max(0, s.path.length - 1));
          } else {
            expect(sim.bodySegmentCount(s.id)).toBe(0);
          }
        }
      }
    }

    // (b) 펠릿 총량 수렴: 워밍업 후 목표의 60% 이상 유지, 폭주 없음(목표+잔해 여유 이내)
    expect(minPelletsAfterWarmup).toBeGreaterThanOrEqual(config.pellets.targetCount * 0.6);
    expect(maxPellets).toBeLessThanOrEqual(config.pellets.targetCount + 2_000);

    // 10분 동안 실제로 플레이가 순환했음 (사망/재스폰 발생)
    expect(respawns).toBeGreaterThan(0);
    expect(sim.tickId).toBe(TICKS);
    // 마지막 상태에도 8마리가 존재
    expect(sim.snakes.size).toBe(SNAKES);
  }, 120_000);
});
