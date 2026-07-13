import { createGameConfig, type GameConfig } from '@serpent/config';
import { describe, expect, it } from 'vitest';
import { Simulation, bodyLengthForMass, sampleBodyPoints, wrapAngle } from './simulation';
import { pointSegmentDistanceSq } from './spatial';

function testConfig(overrides?: Parameters<typeof createGameConfig>[0]): GameConfig {
  const base = createGameConfig({
    arena: { width: 2000, height: 2000, boundary: 'lethal' },
    pellets: { targetCount: 0, minPerCell: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
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

  it('서버 감속 계수는 이동 속도에만 적용한다', () => {
    const cfg = testConfig();
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    s.speedMultiplier = 0.5;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });
    sim.step();
    expect(s.head.x).toBeCloseTo(1000 + cfg.snake.baseSpeed * (cfg.simulation.fixedDeltaMs / 1000) * 0.5);
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

describe('펠릿 밀도', () => {
  it('초기 배치는 설정된 셀별 최소 밀도를 먼저 채운다', () => {
    const cfg = testConfig({
      arena: { width: 1000, height: 1000, boundary: 'lethal' },
      interest: { cellSize: 500, radius: 500, despawnRadius: 600, targetNearbySnakes: 10 },
      pellets: { targetCount: 8, minPerCell: 2, chunkSync: true, respawnBudgetPerTick: 1, baseValue: 1, radius: 6 },
    });
    const sim = new Simulation(cfg, 1);
    sim.seedPellets();
    const counts = new Map<string, number>();
    for (const pellet of sim.pellets.values()) {
      const key = `${Math.floor(pellet.x / 500)}:${Math.floor(pellet.y / 500)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()]).toHaveLength(4);
    expect([...counts.values()].every((count) => count >= 2)).toBe(true);
  });
});

describe('생존 시간 점수', () => {
  it('설정된 초당 점수를 고정 dt 누적으로 정확히 반영한다', () => {
    const cfg = testConfig({ scoring: { survivalScorePerSecond: 3, survivalScoreCap: 300 } });
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });

    for (let tick = 0; tick < cfg.simulation.tickRate * 2; tick++) sim.step();

    expect(s.score).toBe(6);
    expect(s.survivalScoreCarry).toBeCloseTo(0);
  });

  it('생존 시간 점수는 설정된 cap 이후 더 이상 증가하지 않는다', () => {
    const cfg = testConfig({ scoring: { survivalScorePerSecond: 10, survivalScoreCap: 3 } });
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: 1000, y: 1000 };
    s.angle = 0;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });

    for (let tick = 0; tick < cfg.simulation.tickRate * 2; tick++) sim.step();

    expect(s.survivalScoreEarned).toBe(3);
    expect(s.score).toBe(3);
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

  it('soft boundary에서는 죽지 않고 안전 영역으로 밀려난다', () => {
    const cfg = noProtection(testConfig({ arena: { width: 2000, height: 2000, boundary: 'soft' } }));
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.head = { x: cfg.snake.headRadius + 1, y: 1000 };
    s.angle = Math.PI;
    sim.setInput('a', { dirX: -1, dirY: 0, boost: false });

    const events = sim.step();

    expect(s.alive).toBe(true);
    expect(events.deaths).toHaveLength(0);
    expect(s.head.x).toBe(cfg.snake.headRadius);
    expect(s.head.y).toBe(1000);
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

  it('동시 head-to-head에서는 양쪽이 죽고 어느 쪽도 처치 점수를 얻지 않는다', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const a = sim.addSnake('a');
    const b = sim.addSnake('b');
    const dt = cfg.simulation.fixedDeltaMs / 1000;
    const step = cfg.snake.baseSpeed * dt;

    a.head = { x: 1000, y: 1000 };
    a.angle = 0;
    b.head = { x: 1000 + cfg.snake.headRadius * 2 + step - 1, y: 1000 };
    b.angle = Math.PI;
    sim.setInput('a', { dirX: 1, dirY: 0, boost: false });
    sim.setInput('b', { dirX: -1, dirY: 0, boost: false });
    const scores = { a: a.score, b: b.score };

    const events = sim.step();

    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
    expect(events.deaths).toHaveLength(2);
    expect(events.deaths.every((death) => death.cause === 'head')).toBe(true);
    expect(events.deaths.every((death) => death.killerId === undefined)).toBe(true);
    expect(a.score).toBe(scores.a);
    expect(b.score).toBe(scores.b);
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

  it('새 스폰은 다른 뱀의 경로 세그먼트와 안전 거리 이상 떨어진다', () => {
    const cfg = testConfig({ arena: { width: 6000, height: 6000, boundary: 'lethal' } });
    const sim = new Simulation(cfg, 41);
    const existing = sim.addSnake('existing');
    existing.head = { x: 3000, y: 5000 };
    existing.path = [{ x: 3000, y: 1000 }];
    const spawned = sim.addSnake('new');
    const safeDistance = cfg.snake.baseBodyLength * 2;

    expect(pointSegmentDistanceSq(spawned.head, existing.head, existing.path[0]!)).toBeGreaterThanOrEqual(safeDistance ** 2);
  });

  it('재연결 grace가 끝나면 서버 강제 사망으로 잔해를 남긴다', () => {
    const cfg = noProtection(testConfig());
    const sim = new Simulation(cfg, 1);
    const s = sim.addSnake('a');
    s.mass = 60;
    const death = sim.forceDeath('a');

    expect(death).toMatchObject({ snakeId: 'a', cause: 'disconnect', tickId: 0 });
    expect(s.alive).toBe(false);
    expect(sim.pellets.size).toBeGreaterThan(0);
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
