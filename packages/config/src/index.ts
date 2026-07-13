/**
 * GameConfig — PRD 부록 B 기준 초기값.
 * 밸런스 값은 코드 상수가 아니라 이 버전된 설정으로 관리한다 (PRD §5.2).
 */

export interface ArenaConfig {
  width: number;
  height: number;
  boundary: 'lethal' | 'soft';
}

export interface RoomConfig {
  maxPlayers: number;
  minHumans: number;
  maxBots: number;
}

export interface SimulationConfig {
  tickRate: number;
  snapshotRate: number;
  fixedDeltaMs: number;
}

export interface NetworkConfig {
  inputRate: number;
  interpolationDelayMs: number;
  maxExtrapolationMs: number;
  binaryProtocol: boolean;
  targetBytesPerSecond: number;
}

export interface InterestConfig {
  cellSize: number;
  radius: number;
  despawnRadius: number;
  targetNearbySnakes: number;
}

export interface SnakeConfig {
  baseSpeed: number;
  boostSpeed: number;
  maxTurnRate: number;
  pathNodeMinDistance: number;
  pathNodeMinAngle: number;
  spawnProtectionMs: number;
  /** 초당 현재 질량 대비 부스트 소모 비율 (PRD §5.2: 0.8%/s) */
  boostMassCostPerSecond: number;
  /** 부스트 사용 가능 최소 질량 */
  minBoostMass: number;
  /** 스폰 시 초기 질량 */
  initialMass: number;
  /** 사망 시 펠릿으로 전환되는 질량 비율 (PRD §5.5 Death conversion) */
  deathMassConversionRatio: number;
  /** 머리 충돌 원 반경 (world units) */
  headRadius: number;
  /** 몸통 세그먼트 충돌 반경 (world units) */
  bodyRadius: number;
  /** 몸통 렌더/충돌 샘플 간격 (world units) */
  segmentSpacing: number;
  /** 질량 0일 때의 기본 몸통 길이 (world units) */
  baseBodyLength: number;
  /** 질량 1당 몸통 길이 증가량 (world units) */
  lengthPerMass: number;
}

export interface PelletsConfig {
  targetCount: number;
  /** interest grid 셀마다 유지할 최소 일반 펠릿 수 (PRD §5.6) */
  minPerCell?: number;
  chunkSync: boolean;
  respawnBudgetPerTick: number;
  /** 일반 펠릿 1개의 질량 값 */
  baseValue: number;
  /** 펠릿 반경 (world units) — 획득 판정은 headRadius + radius */
  radius: number;
}

export interface ScoringConfig {
  /** 생존 1초당 획득하는 정수 점수 (PRD §5.4 시간 점수) */
  survivalScorePerSecond: number;
  /** 잠수 플레이가 우세해지지 않도록 생존 점수에 적용하는 경기당 상한 */
  survivalScoreCap: number;
}

export interface GameConfig {
  version: string;
  mode: string;
  arena: ArenaConfig;
  room: RoomConfig;
  simulation: SimulationConfig;
  network: NetworkConfig;
  interest: InterestConfig;
  snake: SnakeConfig;
  pellets: PelletsConfig;
  scoring: ScoringConfig;
  reconnect: { graceMs: number };
  leaderboard: { size: number; updateHz: number };
}

export const defaultGameConfig: GameConfig = {
  version: '2026-07-13.2',
  mode: 'classic',
  arena: {
    width: 6000,
    height: 6000,
    boundary: 'lethal',
  },
  room: {
    maxPlayers: 60,
    minHumans: 4,
    maxBots: 20,
  },
  simulation: {
    tickRate: 20,
    snapshotRate: 10,
    fixedDeltaMs: 50,
  },
  network: {
    inputRate: 20,
    interpolationDelayMs: 100,
    maxExtrapolationMs: 200,
    binaryProtocol: false,
    targetBytesPerSecond: 40000,
  },
  interest: {
    cellSize: 500,
    radius: 1500,
    despawnRadius: 1800,
    targetNearbySnakes: 30,
  },
  snake: {
    baseSpeed: 180,
    boostSpeed: 270,
    maxTurnRate: 3.2,
    pathNodeMinDistance: 12,
    pathNodeMinAngle: 0.08,
    spawnProtectionMs: 1500,
    boostMassCostPerSecond: 0.008,
    minBoostMass: 12,
    initialMass: 10,
    deathMassConversionRatio: 0.6,
    headRadius: 12,
    bodyRadius: 10,
    segmentSpacing: 16,
    baseBodyLength: 120,
    lengthPerMass: 6,
  },
  pellets: {
    targetCount: 1200,
    minPerCell: 2,
    chunkSync: true,
    respawnBudgetPerTick: 30,
    baseValue: 1,
    radius: 6,
  },
  scoring: {
    survivalScorePerSecond: 1,
    survivalScoreCap: 300,
  },
  reconnect: {
    graceMs: 10000,
  },
  leaderboard: {
    size: 10,
    updateHz: 4,
  },
};

/** 부분 오버라이드를 허용하는 GameConfig 생성기 (얕은 섹션 단위 병합) */
export function createGameConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    ...defaultGameConfig,
    ...overrides,
    arena: { ...defaultGameConfig.arena, ...overrides.arena },
    room: { ...defaultGameConfig.room, ...overrides.room },
    simulation: { ...defaultGameConfig.simulation, ...overrides.simulation },
    network: { ...defaultGameConfig.network, ...overrides.network },
    interest: { ...defaultGameConfig.interest, ...overrides.interest },
    snake: { ...defaultGameConfig.snake, ...overrides.snake },
    pellets: { ...defaultGameConfig.pellets, ...overrides.pellets },
    scoring: { ...defaultGameConfig.scoring, ...overrides.scoring },
    reconnect: { ...defaultGameConfig.reconnect, ...overrides.reconnect },
    leaderboard: { ...defaultGameConfig.leaderboard, ...overrides.leaderboard },
  };
}

/**
 * 운영 설정을 활성화하기 전의 최소 안전성 검사. 게임 루프 안에서는 호출하지 않고
 * API/배포 단계에서만 사용한다. 잘못된 tick·AOI·속도 조합의 배포를 막는다.
 */
export function validateGameConfig(config: GameConfig): { ok: true } | { ok: false; error: string } {
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.version)) return { ok: false, error: 'invalid version' };
  if (!positive(config.arena.width) || !positive(config.arena.height)) return { ok: false, error: 'invalid arena' };
  if (!Number.isInteger(config.room.maxPlayers) || config.room.maxPlayers < 1 || config.room.maxBots < 0) {
    return { ok: false, error: 'invalid room capacity' };
  }
  if (!positive(config.simulation.tickRate) || !positive(config.simulation.snapshotRate) ||
    config.simulation.snapshotRate > config.simulation.tickRate ||
    Math.abs(config.simulation.fixedDeltaMs - 1000 / config.simulation.tickRate) > 0.001) {
    return { ok: false, error: 'invalid simulation rates' };
  }
  if (!positive(config.interest.cellSize) || !positive(config.interest.radius) ||
    config.interest.despawnRadius < config.interest.radius) {
    return { ok: false, error: 'invalid interest range' };
  }
  if (!positive(config.snake.baseSpeed) || config.snake.boostSpeed < config.snake.baseSpeed ||
    !positive(config.snake.maxTurnRate) || config.snake.boostMassCostPerSecond < 0) {
    return { ok: false, error: 'invalid snake balance' };
  }
  if (!positive(config.pellets.targetCount) || !Number.isInteger(config.pellets.minPerCell ?? 0) || (config.pellets.minPerCell ?? 0) < 0 || !positive(config.pellets.respawnBudgetPerTick) ||
    !positive(config.pellets.baseValue) || !positive(config.pellets.radius)) {
    return { ok: false, error: 'invalid pellets' };
  }
  if (!Number.isFinite(config.scoring.survivalScorePerSecond) || config.scoring.survivalScorePerSecond < 0 ||
    !Number.isInteger(config.scoring.survivalScoreCap) || config.scoring.survivalScoreCap < 0) {
    return { ok: false, error: 'invalid scoring' };
  }
  return { ok: true };
}
