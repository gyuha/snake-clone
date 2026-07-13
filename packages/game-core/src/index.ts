/**
 * game-core — 결정적 시뮬레이션 패키지.
 * 이동/부스트/펠릿/성장/충돌/사망을 서버와 오프라인 클라이언트가 공유한다.
 * Phaser/렌더링 코드는 이 패키지에 두지 않는다 (부록 E Architecture 규칙).
 */

export const GAME_CORE_VERSION = '0.1.0';

export { Rng } from './rng';
export {
  Simulation,
  normalizeDirection,
  wrapAngle,
  bodyLengthForMass,
  sampleBodyPoints,
} from './simulation';
export { stepSnakeMovement, updateSnakePath } from './movement';
export type { MovementState, MovementInput } from './movement';
export {
  SpatialHashGrid,
  BodyCollisionIndex,
  pointSegmentDistanceSq,
  cellOf,
  cellKey,
  chunkKeyForPosition,
} from './spatial';
export type { BodySegment } from './spatial';
export type {
  Vec2,
  SnakeInput,
  SnakeState,
  PelletState,
  DeathCause,
  DeathEvent,
  EatEvent,
  TickEvents,
  SimulationSnapshot,
} from './types';
