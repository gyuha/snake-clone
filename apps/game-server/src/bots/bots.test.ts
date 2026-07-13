import { createGameConfig } from '@serpent/config';
import { Rng, Simulation } from '@serpent/game-core';
import { describe, expect, it } from 'vitest';
import { BotController, defaultBotParams } from './BotController';

/**
 * 봇 판단 단위 검증 (loop.md C5, PRD §5.7).
 * 판단은 5~10Hz(여기서는 3틱=6.7Hz 간격 호출), 이동은 시뮬 틱에서 처리.
 */
const config = createGameConfig({
  arena: { width: 4000, height: 4000, boundary: 'lethal' },
  pellets: { targetCount: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
  snake: {
    ...createGameConfig().snake,
    spawnProtectionMs: 0,
  },
});

describe('BotController — 수집', () => {
  it('시야 내 펠릿으로 접근해 먹는다 (질량 증가)', () => {
    const sim = new Simulation(config, 11);
    const bot = sim.addSnake('bot');
    bot.head = { x: 2000, y: 2000 };
    bot.angle = 0;
    const startMass = bot.mass;
    // 시야(900) 안, 현재 진행 방향의 반대편에 펠릿 배치
    sim.addPellet(1600, 2300, 5);

    const controller = new BotController(sim, 'bot', new Rng(1), { ...defaultBotParams, turnNoise: 0 });
    for (let t = 0; t < 200 && sim.snakes.get('bot')!.mass === startMass; t++) {
      if (t % 3 === 0) controller.decide(); // ~6.7Hz
      sim.step();
    }
    expect(sim.snakes.get('bot')!.mass).toBeGreaterThan(startMass);
  });
});

describe('BotController — 위험 회피', () => {
  it('경계로 돌진하지 않는다: 무개입 직진은 죽고, 봇 판단은 생존한다', () => {
    // 대조군: 직진 → 경계 사망
    const straight = new Simulation(config, 22);
    const s1 = straight.addSnake('s');
    s1.head = { x: 300, y: 2000 };
    s1.angle = Math.PI; // 왼쪽 경계로
    straight.setInput('s', { dirX: -1, dirY: 0, boost: false });
    let straightDied = false;
    for (let t = 0; t < 100; t++) {
      const ev = straight.step();
      if (ev.deaths.some((d) => d.snakeId === 's')) {
        straightDied = true;
        break;
      }
    }
    expect(straightDied).toBe(true);

    // 실험군: 같은 상황에서 봇 판단 → 회피 생존
    const sim = new Simulation(config, 22);
    const bot = sim.addSnake('bot');
    bot.head = { x: 300, y: 2000 };
    bot.angle = Math.PI;
    const controller = new BotController(sim, 'bot', new Rng(2), { ...defaultBotParams, turnNoise: 0 });
    for (let t = 0; t < 400; t++) {
      if (t % 3 === 0) controller.decide();
      sim.step();
    }
    expect(sim.snakes.get('bot')!.alive).toBe(true);
  });

  it('전방의 다른 뱀 몸통을 피해 방향을 바꾼다', () => {
    const sim = new Simulation(config, 33);
    const bot = sim.addSnake('bot');
    bot.head = { x: 1500, y: 2000 };
    bot.angle = 0; // 오른쪽으로
    // 전방에 수직 몸통 벽 (다른 뱀)
    const wall = sim.addSnake('wall');
    wall.head = { x: 1800, y: 2600 };
    wall.mass = 200;
    wall.path = [
      { x: 1800, y: 2500 },
      { x: 1800, y: 1500 },
    ];
    sim.setInput('wall', { dirX: 0, dirY: 1, boost: false });

    const controller = new BotController(sim, 'bot', new Rng(3), { ...defaultBotParams, turnNoise: 0 });
    let died = false;
    for (let t = 0; t < 300; t++) {
      if (t % 3 === 0) controller.decide();
      const ev = sim.step();
      if (ev.deaths.some((d) => d.snakeId === 'bot')) {
        died = true;
        break;
      }
    }
    expect(died).toBe(false);
    expect(sim.snakes.get('bot')!.alive).toBe(true);
  });
});
