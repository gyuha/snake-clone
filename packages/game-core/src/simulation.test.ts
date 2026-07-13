import { createGameConfig, type GameConfig } from '@serpent/config';
import { describe, expect, it } from 'vitest';
import { Simulation, bodyLengthForMass, sampleBodyPoints, wrapAngle } from './simulation';

function testConfig(overrides?: Parameters<typeof createGameConfig>[0]): GameConfig {
  const base = createGameConfig({
    arena: { width: 2000, height: 2000, boundary: 'lethal' },
    pellets: { targetCount: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
    ...overrides,
  });
  return base;
}

function noProtection(cfg: GameConfig): GameConfig {
  return { ...cfg, snake: { ...cfg.snake, spawnProtectionMs: 0 } };
}

describe('이동', () => {
  it('직진 시 틱당 baseSpeed × dt 만큼 이동한다', () => {
    const cfg = testConfig();
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });
    sim.step();
    expect(s.head.x).toBeCloseTo(1000 + cfg.snake.baseSpeed * (cfg.simulation.fixedDeltaMs / 1000));
    expect(s.head.y).toBeCloseTo(1000);
  });

  it('회전은 틱당 maxTurnRate × dt 를 넘지 않는다', () => {
    const cfg = testConfig();
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    // 정반대 방향 요구
    sim.setInput('a', { dirX: -1, dirY: 0.001, boost: false });
    sim.step();
    const dt = cfg.simulation.fixedDeltaMs / 1000;
    expect(Math.abs(wrapAngle(s.angle))).toBeLessThanOrEqual(cfg.snake.maxTurnRate * dt + 1e-9);
  });

  it('NaN/영벡터 입력은 무시하고 기존 방향을 유지한다', () => {
    const cfg = testConfig();
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    sim.setInput('a', { dirX: NaN, dirY: 0, boost: false });
    sim.step();
    expect(s.angle).toBeCloseTo(0);
    expect(Number.isFinite(s.head.x)).toBe(true);
  });
});

describe('부스트', () => {
  it('부스트 중 속도가 오르고 질량이 줄어든다', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    s.mass = 100;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: true });
    sim.step();
    const dt = cfg.simulation.fixedDeltaMs / 1000;
    expect(s.boosting).toBe(true);
    expect(s.head.x).toBeCloseTo(1000 + cfg.snake.boostSpeed * dt);
    expect(s.mass).toBeLessThan(100);
  });

  it('최소 질량 이하에서는 부스트가 불가능하다', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    s.mass = cfg.snake.minBoostMass; // 초과가 아니므로 불가
    sim.setInput('a', { dirX: 1, dirY: 0, boost: true });
    sim.step();
    expect(s.boosting).toBe(false);
    expect(s.mass).toBe(cfg.snake.minBoostMass);
  });

  it('스폰 보호 중에는 부스트가 불가능하다 (PRD §5.2)', () => {
    const cfg = testConfig(); // 기본 1.5초 보호
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.mass = 100;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: true });
    sim.step();
    expect(s.boosting).toBe(false);
  });
});

describe('섭취와 성장', () => {
  it('머리 근처 펠릿을 먹으면 질량/점수가 늘고 펠릿이 제거된다', () => {
    const cfg = testConfig();
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    const startMass = s.mass;
    // 다음 틱 이동 지점 위에 펠릿 배치
    const dt = cfg.simulation.fixedDeltaMs / 1000;
    const px = 1000 + cfg.snake.baseSpeed * dt;
    const pellet = sim.addPellet(px, 1000, 3);
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });
    const events = sim.step();
    expect(s.mass).toBe(startMass + 3);
    expect(s.score).toBe(30);
    expect(sim.pellets.has(pellet.id)).toBe(false);
    expect(events.eats).toHaveLength(1);
    expect(events.eats[0]!.pelletId).toBe(pellet.id);
  });

  it('질량이 늘면 몸통 길이가 늘어난다', () => {
    const cfg = testConfig();
    expect(bodyLengthForMass(cfg, 50)).toBeGreaterThan(bodyLengthForMass(cfg, 10));
  });
});

describe('충돌과 사망', () => {
  it('경계에 닿으면 즉사한다 (lethal boundary)', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: cfg.snake.headRadius + 1, y: 1000 };
    s.angle = Math.PI; // 왼쪽 경계로
    sim.setInput('a', { dirX: -1, dirY: 0, boost: false });
    const events = sim.step();
    expect(s.alive).toBe(false);
    expect(events.deaths).toHaveLength(1);
    expect(events.deaths[0]!.cause).toBe('boundary');
  });

  it('상대 몸통에 머리가 닿으면 머리 소유자가 죽고 몸통 주인이 킬 보너스를 받는다', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const a = sim.addSnake('a');
    const b = sim.addSnake('b');
    // b: 수직 몸통 벽 구성 (a의 머리에서 멀리 떨어진 머리)
    b.head = { x: 1200, y: 1400 };
    b.angle = Math.PI / 2;
    b.mass = 100;
    b.path = [
      { x: 1200, y: 1100 },
      { x: 1200, y: 700 },
    ];
    // a: b의 몸통을 향해 한 틱이면 닿는 위치
    a.head = { x: 1200 - cfg.snake.headRadius - cfg.snake.bodyRadius - 5, y: 900 };
    a.angle = 0;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });
    sim.setInput('b', { dirX: 0, dirY: 1, boost: false });
    const before = b.score;
    const events = sim.step();
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(true);
    const death = events.deaths.find((d) => d.snakeId === 'a');
    expect(death?.cause).toBe('body');
    expect(death?.killerId).toBe('b');
    expect(b.score).toBeGreaterThan(before);
  });

  it('사망하면 질량 일부가 펠릿으로 전환된다 (잔해)', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.mass = 60;
    s.head = { x: cfg.snake.headRadius + 1, y: 1000 };
    s.angle = Math.PI;
    sim.setInput('a', { dirX: -1, dirY: 0, boost: false });
    expect(sim.pellets.size).toBe(0);
    sim.step();
    expect(s.alive).toBe(false);
    expect(sim.pellets.size).toBeGreaterThan(0);
  });

  it('스폰 보호 중에는 몸통 충돌로 죽지 않는다', () => {
    const cfg = testConfig(); // 보호 1.5초 = 30틱
    const sim = new Simulation(cfg, 1);
    const a = sim.addSnake('a');
    const b = sim.addSnake('b');
    b.head = { x: 1200, y: 1400 };
    b.mass = 100;
    b.path = [
      { x: 1200, y: 1100 },
      { x: 1200, y: 700 },
    ];
    a.head = { x: 1195, y: 900 }; // 이미 몸통 위
    a.angle = 0;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });
    const events = sim.step();
    expect(a.alive).toBe(true);
    expect(events.deaths).toHaveLength(0);
  });
});

describe('sampleBodyPoints', () => {
  it('경로를 spacing 간격으로 샘플링하고 bodyLength를 넘지 않는다', () => {
    const head = { x: 0, y: 0 };
    const path = [{ x: -1000, y: 0 }];
    const points = sampleBodyPoints(head, path, 100, 20);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ x: -20, y: 0 });
    expect(points[4]).toEqual({ x: -100, y: 0 });
  });
});
