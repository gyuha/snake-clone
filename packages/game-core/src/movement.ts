import type { GameConfig } from '@serpent/config';
import type { Vec2 } from './types';

/** 이동 적분에 필요한 최소 상태 — 서버 Simulation과 클라이언트 예측기가 공유 */
export interface MovementState {
  head: Vec2;
  angle: number;
  mass: number;
  boosting: boolean;
  path: Vec2[];
}

export interface MovementInput {
  dir: Vec2 | null;
  boost: boolean;
}

/** 각도를 (-PI, PI]로 정규화 */
export function wrapAngle(a: number): number {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/** 질량 → 몸통 길이 (world units) */
export function bodyLengthForMass(config: GameConfig, mass: number): number {
  return config.snake.baseBodyLength + mass * config.snake.lengthPerMass;
}

/**
 * 한 틱 분량의 이동 적분: 회전 클램프 → 부스트 판정/질량 소모 → 머리 전진 → 경로 갱신.
 * 서버 권위 시뮬레이션과 클라이언트 예측(reconciliation 재적용)이 반드시
 * 이 단일 구현을 공유해야 재적용 결과가 서버와 정확히 일치한다 (PRD §9.5).
 */
export function stepSnakeMovement(
  s: MovementState,
  input: MovementInput | undefined,
  config: GameConfig,
  allowBoost: boolean,
): void {
  const snakeCfg = config.snake;
  const dt = config.simulation.fixedDeltaMs / 1000;

  // 회전: 목표 각도로 maxTurnRate 제한 회전
  if (input?.dir) {
    const target = Math.atan2(input.dir.y, input.dir.x);
    const diff = wrapAngle(target - s.angle);
    const maxDelta = snakeCfg.maxTurnRate * dt;
    s.angle = wrapAngle(s.angle + Math.max(-maxDelta, Math.min(maxDelta, diff)));
  }

  // 부스트: 허용 조건 + 최소 질량 초과일 때만, 질량 소모 (PRD §5.2)
  const wantsBoost = input?.boost === true;
  s.boosting = wantsBoost && allowBoost && s.mass > snakeCfg.minBoostMass;
  if (s.boosting) {
    s.mass = Math.max(
      snakeCfg.minBoostMass,
      s.mass - s.mass * snakeCfg.boostMassCostPerSecond * dt,
    );
  }

  const speed = s.boosting ? snakeCfg.boostSpeed : snakeCfg.baseSpeed;
  const prevHead = { ...s.head };
  s.head = {
    x: s.head.x + Math.cos(s.angle) * speed * dt,
    y: s.head.y + Math.sin(s.angle) * speed * dt,
  };
  updateSnakePath(s, prevHead, config);
}

/** 경로 키포인트 갱신: 거리 임계 초과 시 추가, 필요 길이 초과분 제거 (PRD §9.8.5) */
export function updateSnakePath(
  s: Pick<MovementState, 'head' | 'mass' | 'path'>,
  prevHead: Vec2,
  config: GameConfig,
): void {
  const { pathNodeMinDistance } = config.snake;
  const first = s.path[0];
  const distFromFirst = first ? Math.hypot(prevHead.x - first.x, prevHead.y - first.y) : Infinity;
  if (distFromFirst >= pathNodeMinDistance) {
    s.path.unshift(prevHead);
  }

  const keep = bodyLengthForMass(config, s.mass) + config.snake.segmentSpacing * 2;
  let acc = 0;
  let prev: Vec2 = s.head;
  for (let i = 0; i < s.path.length; i++) {
    const node = s.path[i]!;
    acc += Math.hypot(node.x - prev.x, node.y - prev.y);
    prev = node;
    if (acc > keep) {
      s.path.length = i + 1;
      break;
    }
  }
}
