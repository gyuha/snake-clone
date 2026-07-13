import type { GameConfig } from '@serpent/config';
import { bodyLengthForMass, stepSnakeMovement } from './movement';
import { Rng } from './rng';
import { BodyCollisionIndex, SpatialHashGrid, pointSegmentDistanceSq } from './spatial';
import type {
  DeathEvent,
  EatEvent,
  PelletState,
  SimulationSnapshot,
  SnakeInput,
  SnakeState,
  TickEvents,
  Vec2,
} from './types';

export { bodyLengthForMass, wrapAngle } from './movement';

/** 방향 벡터 정규화 — 영벡터/NaN/Infinity는 null 반환 (서버 입력 검증의 공용 기초) */
export function normalizeDirection(v: Vec2): Vec2 | null {
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  const len = Math.hypot(v.x, v.y);
  if (len === 0) return null;
  return { x: v.x / len, y: v.y / len };
}

/**
 * 경로 키포인트(머리 포함)를 일정 간격으로 샘플링해 몸통 점을 복원한다.
 * 렌더링과 충돌 판정이 같은 함수를 쓴다 (PRD §5.3).
 */
export function sampleBodyPoints(
  head: Vec2,
  path: readonly Vec2[],
  bodyLength: number,
  spacing: number,
): Vec2[] {
  const points: Vec2[] = [];
  let remainingToNext = spacing;
  let budget = bodyLength;
  let prev = head;
  for (const node of path) {
    if (budget <= 0) break;
    let segLen = Math.hypot(node.x - prev.x, node.y - prev.y);
    if (segLen === 0) continue;
    const dirX = (node.x - prev.x) / segLen;
    const dirY = (node.y - prev.y) / segLen;
    segLen = Math.min(segLen, budget);
    let travelled = 0;
    while (travelled + remainingToNext <= segLen) {
      travelled += remainingToNext;
      points.push({ x: prev.x + dirX * travelled, y: prev.y + dirY * travelled });
      remainingToNext = spacing;
    }
    remainingToNext -= segLen - travelled;
    budget -= segLen;
    prev = { x: prev.x + dirX * segLen, y: prev.y + dirY * segLen };
  }
  return points;
}

interface InternalInput {
  dir: Vec2 | null;
  boost: boolean;
}

/**
 * 결정적 고정 dt 시뮬레이션 (PRD §5, §21.6).
 * - 입력은 방향 벡터 + 부스트 의도만 받는다 (좌표/점수/길이 수신 금지).
 * - 동일 seed + 동일 입력 시퀀스는 동일 상태를 만든다 (Date.now/Math.random 금지).
 * - 렌더링 관심사는 포함하지 않는다 (부록 E: Phaser는 game-core 밖).
 */
export class Simulation {
  readonly config: GameConfig;
  private readonly rng: Rng;

  tickId = 0;
  readonly snakes = new Map<string, SnakeState>();
  readonly pellets = new Map<number, PelletState>();
  private nextPelletId = 1;
  private readonly inputs = new Map<string, InternalInput>();

  /** 몸통 캡슐 세그먼트 인덱스 — 증분 갱신 (PRD §9.8.7) */
  private readonly bodyIndex: BodyCollisionIndex;
  /** 정적 펠릿 인덱스 — 스폰/섭취 시에만 갱신 */
  private readonly pelletGrid: SpatialHashGrid<number>;

  constructor(config: GameConfig, seed: number) {
    this.config = config;
    this.rng = new Rng(seed);
    this.bodyIndex = new BodyCollisionIndex(
      config.interest.cellSize,
      config.snake.bodyRadius,
    );
    this.pelletGrid = new SpatialHashGrid(config.interest.cellSize);
  }

  /** 초기 펠릿을 목표 수량까지 채운다 (Room Creating 단계 / 오프라인 시작) */
  seedPellets(count = this.config.pellets.targetCount): void {
    for (let i = 0; i < count; i++) this.spawnPellet();
  }

  private spawnPellet(x?: number, y?: number, value?: number): PelletState {
    const { arena, pellets } = this.config;
    const pellet: PelletState = {
      id: this.nextPelletId++,
      x: x ?? this.rng.range(pellets.radius, arena.width - pellets.radius),
      y: y ?? this.rng.range(pellets.radius, arena.height - pellets.radius),
      value: value ?? pellets.baseValue,
    };
    this.pellets.set(pellet.id, pellet);
    this.pelletGrid.insertPoint(pellet.id, pellet.x, pellet.y);
    return pellet;
  }

  private removePellet(id: number): void {
    this.pellets.delete(id);
    this.pelletGrid.remove(id);
  }

  /** 지정 위치에 펠릿 배치 (테스트/운영 도구용 — 인덱스 일관성 보장) */
  addPellet(x: number, y: number, value?: number): PelletState {
    return this.spawnPellet(x, y, value);
  }

  /** 충돌 인덱스에 등록된 몸통 세그먼트 수 (진단/soak 불변식용) */
  bodySegmentCount(id: string): number {
    return this.bodyIndex.segmentCount(id);
  }

  /** 안전 지점 탐색 후 스폰 (PRD §5.6 — 다른 머리/몸통/경계에서 최소 거리) */
  addSnake(id: string): SnakeState {
    const { arena, snake } = this.config;
    const margin = Math.min(arena.width, arena.height) * 0.1;
    const safeDistance = snake.baseBodyLength * 2;
    let pos: Vec2 = { x: arena.width / 2, y: arena.height / 2 };
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate: Vec2 = {
        x: this.rng.range(margin, arena.width - margin),
        y: this.rng.range(margin, arena.height - margin),
      };
      let safe = true;
      for (const other of this.snakes.values()) {
        if (!other.alive) continue;
        if (Math.hypot(other.head.x - candidate.x, other.head.y - candidate.y) < safeDistance) {
          safe = false;
          break;
        }
      }
      if (safe) {
        pos = candidate;
        break;
      }
    }
    const angle = this.rng.range(-Math.PI, Math.PI);
    const protectionTicks = Math.ceil(snake.spawnProtectionMs / this.config.simulation.fixedDeltaMs);
    const state: SnakeState = {
      id,
      alive: true,
      head: pos,
      angle,
      mass: snake.initialMass,
      score: 0,
      boosting: false,
      path: [{ x: pos.x - Math.cos(angle), y: pos.y - Math.sin(angle) }],
      spawnedAtTick: this.tickId,
      protectedUntilTick: this.tickId + protectionTicks,
    };
    this.snakes.set(id, state);
    return state;
  }

  removeSnake(id: string): void {
    this.snakes.delete(id);
    this.inputs.delete(id);
    this.bodyIndex.removeSnake(id);
  }

  /** 입력 적용 — 최신 입력 우선 (PRD §9.8.2). 비정상 방향은 무시하고 이전 방향 유지. */
  setInput(id: string, input: SnakeInput): void {
    const dir = normalizeDirection({ x: input.dirX, y: input.dirY });
    const prev = this.inputs.get(id);
    this.inputs.set(id, { dir: dir ?? prev?.dir ?? null, boost: input.boost === true });
  }

  /** 한 틱 진행 — 서버 틱 순서 준수 (PRD §9.2: 이동 → 섭취 → 충돌 → 사망/잔해) */
  step(): TickEvents {
    this.tickId++;
    const events: TickEvents = { deaths: [], eats: [] };
    const { snake: snakeCfg, arena } = this.config;

    // 1) 이동 적분 — 클라이언트 예측과 공유하는 단일 구현 (movement.ts)
    //    + 몸통 인덱스 증분 동기화 (새 키포인트 추가 / trim 제거만)
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const protectedNow = this.tickId < s.protectedUntilTick;
      stepSnakeMovement(s, this.inputs.get(s.id), this.config, !protectedNow);
      this.bodyIndex.syncSnake(s.id, s.path);
    }

    // 2) 섭취를 먼저 계산 (PRD §9.2) — 펠릿 그리드 broad phase
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const pickupRadius = snakeCfg.headRadius + this.config.pellets.radius;
      for (const pelletId of this.pelletGrid.queryCircle(s.head.x, s.head.y, pickupRadius)) {
        const pellet = this.pellets.get(pelletId);
        if (!pellet) continue;
        if (Math.hypot(pellet.x - s.head.x, pellet.y - s.head.y) <= pickupRadius) {
          this.removePellet(pellet.id);
          s.mass += pellet.value;
          s.score += pellet.value * 10;
          events.eats.push({ tickId: this.tickId, snakeId: s.id, pelletId: pellet.id, value: pellet.value });
        }
      }
    }

    // 3) 충돌 판정 — broad phase는 spatial hash, 결과는 틱 끝에 일괄 반영 (PRD §9.8.7)
    const doomed = new Map<string, DeathEvent>();
    const alive = [...this.snakes.values()].filter((s) => s.alive);
    const hitDist = snakeCfg.headRadius + snakeCfg.bodyRadius;
    for (const s of alive) {
      const protectedNow = this.tickId < s.protectedUntilTick;

      // 경계 즉사 (lethal boundary)
      if (
        arena.boundary === 'lethal' &&
        (s.head.x < snakeCfg.headRadius ||
          s.head.y < snakeCfg.headRadius ||
          s.head.x > arena.width - snakeCfg.headRadius ||
          s.head.y > arena.height - snakeCfg.headRadius)
      ) {
        doomed.set(s.id, { tickId: this.tickId, snakeId: s.id, cause: 'boundary' });
        continue;
      }
      if (protectedNow) continue;

      // 머리-머리: 동일 틱 양쪽 사망 (PRD §5.5) — 머리 수는 적으므로 직접 비교
      for (const other of alive) {
        if (other.id === s.id) continue;
        const headDist = Math.hypot(other.head.x - s.head.x, other.head.y - s.head.y);
        if (headDist <= snakeCfg.headRadius * 2 && this.tickId >= other.protectedUntilTick) {
          doomed.set(s.id, { tickId: this.tickId, snakeId: s.id, cause: 'head', killerId: other.id });
          break;
        }
      }
      if (doomed.has(s.id)) continue;

      // 머리 vs 상대 몸통: 인덱스 세그먼트 + 목(head→path[0]) 세그먼트
      const bodyOwner = this.bodyIndex.hitsOtherBody(s.head, s.id, hitDist);
      if (bodyOwner && this.snakes.get(bodyOwner)?.alive) {
        doomed.set(s.id, { tickId: this.tickId, snakeId: s.id, cause: 'body', killerId: bodyOwner });
        continue;
      }
      const hitSq = hitDist * hitDist;
      for (const other of alive) {
        if (other.id === s.id) continue;
        const neck = other.path[0];
        if (neck && pointSegmentDistanceSq(s.head, other.head, neck) <= hitSq) {
          doomed.set(s.id, { tickId: this.tickId, snakeId: s.id, cause: 'body', killerId: other.id });
          break;
        }
      }
    }

    // 4) 사망 반영: 잔해 전환 + 킬 보너스 (PRD §5.4, §5.5)
    for (const death of doomed.values()) {
      const s = this.snakes.get(death.snakeId);
      if (!s) continue;
      s.alive = false;
      s.boosting = false;
      this.bodyIndex.removeSnake(s.id);
      this.scatterRemains(s);
      if (death.killerId) {
        const killer = this.snakes.get(death.killerId);
        if (killer?.alive) killer.score += Math.floor(s.mass) * 5;
      }
      events.deaths.push(death);
    }

    // 5) 펠릿 보충 — 틱당 예산 제한 (PRD §5.6)
    const deficit = this.config.pellets.targetCount - this.pellets.size;
    const budget = Math.min(deficit, this.config.pellets.respawnBudgetPerTick);
    for (let i = 0; i < budget; i++) this.spawnPellet();

    return events;
  }

  /** 사망 질량 일부를 몸통 경로를 따라 펠릿으로 전환 (PRD §5.5 Death conversion) */
  private scatterRemains(s: SnakeState): void {
    const convertible = s.mass * this.config.snake.deathMassConversionRatio;
    const pelletValue = this.config.pellets.baseValue * 2;
    const count = Math.max(1, Math.floor(convertible / pelletValue));
    const points = sampleBodyPoints(
      s.head,
      s.path,
      bodyLengthForMass(this.config, s.mass),
      this.config.snake.segmentSpacing,
    );
    const spots = [s.head, ...points];
    for (let i = 0; i < count; i++) {
      const spot = spots[i % spots.length]!;
      const jitter = this.config.snake.bodyRadius;
      this.spawnPellet(
        Math.min(this.config.arena.width, Math.max(0, spot.x + this.rng.range(-jitter, jitter))),
        Math.min(this.config.arena.height, Math.max(0, spot.y + this.rng.range(-jitter, jitter))),
        pelletValue,
      );
    }
  }

  /** 결정성 비교/전송용 순수 데이터 스냅샷 */
  snapshot(): SimulationSnapshot {
    return {
      tickId: this.tickId,
      snakes: [...this.snakes.values()].map((s) => ({
        ...s,
        head: { ...s.head },
        path: s.path.map((p) => ({ ...p })),
      })),
      pellets: [...this.pellets.values()].map((p) => ({ ...p })),
    };
  }
}

export type { EatEvent };
