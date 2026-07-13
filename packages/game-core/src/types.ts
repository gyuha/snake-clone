export interface Vec2 {
  x: number;
  y: number;
}

/** 플레이어가 서버(또는 오프라인 시뮬)에 보내는 입력 — 좌표가 아니라 의도만 (PRD §5.3) */
export interface SnakeInput {
  /** 목표 방향 벡터 (정규화 전 허용, NaN/영벡터는 무시) */
  dirX: number;
  dirY: number;
  boost: boolean;
}

export type DeathCause = 'boundary' | 'body' | 'head' | 'disconnect';

export interface SnakeState {
  id: string;
  alive: boolean;
  head: Vec2;
  /** 진행 방향 (radians) */
  angle: number;
  mass: number;
  score: number;
  /** 생존 점수의 소수 누적분. 점수는 정수만 외부에 노출한다. */
  survivalScoreCarry: number;
  /** 이미 반영한 생존 시간 점수. 펠릿/킬 점수와 분리해 cap을 적용한다. */
  survivalScoreEarned: number;
  boosting: boolean;
  /** 서버가 단절 grace 동안 적용하는 감속 계수 (기본 1). */
  speedMultiplier: number;
  /** 머리 뒤로 이어지는 경로 키포인트 (index 0이 머리에 가장 가까움) */
  path: Vec2[];
  spawnedAtTick: number;
  /** 같은 tick에 여러 스폰이 발생해도 생존 시간 타이브레이크를 안정화하는 순번. */
  spawnOrder: number;
  /** 스폰 보호 종료 틱 (이 틱 전에는 충돌 사망 없음, 부스트 불가) */
  protectedUntilTick: number;
}

export interface PelletState {
  id: number;
  x: number;
  y: number;
  value: number;
}

export interface DeathEvent {
  tickId: number;
  snakeId: string;
  cause: DeathCause;
  /** head-vs-body 사망 시 몸통 주인 */
  killerId?: string;
}

export interface EatEvent {
  tickId: number;
  snakeId: string;
  pelletId: number;
  value: number;
}

export interface TickEvents {
  deaths: DeathEvent[];
  eats: EatEvent[];
}

/** 결정성 비교용 직렬화 스냅샷 */
export interface SimulationSnapshot {
  tickId: number;
  snakes: SnakeState[];
  pellets: PelletState[];
}
