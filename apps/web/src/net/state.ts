import type { GameConfig } from '@serpent/config';
import { bodyLengthForMass } from '@serpent/game-core';
import type {
  PelletSnapshot,
  PlayerSnapshot,
  SnakeDelta,
  SnapshotMessage,
  WelcomeMessage,
} from '@serpent/protocol';

/** 클라이언트가 유지하는 뱀 상태 — baseline + 델타(신규 키포인트)로 갱신 */
export interface ClientSnake {
  id: string;
  alive: boolean;
  x: number;
  y: number;
  angle: number;
  mass: number;
  score: number;
  boosting: boolean;
  path: { x: number; y: number }[];
}

/** 서버 상태의 클라이언트 측 사본 (M4: AOI 구독 엔터티만 존재) */
export interface NetWorldState {
  playerId: string;
  arena: { width: number; height: number };
  tickId: number;
  lastAckInputSeq: number;
  snakes: Map<string, ClientSnake>;
  pellets: Map<number, PelletSnapshot>;
  /** 구독 청크 → 펠릿 id (청크 leave 시 일괄 제거용) */
  chunkPellets: Map<string, Set<number>>;
}

function toClientSnake(p: PlayerSnapshot): ClientSnake {
  return {
    id: p.id,
    alive: p.alive,
    x: p.x,
    y: p.y,
    angle: p.angle,
    mass: p.mass,
    score: p.score,
    boosting: p.boosting,
    path: p.path.map((n) => ({ x: n.x, y: n.y })),
  };
}

/** 현재 길이에 필요한 범위를 넘는 오래된 키포인트 제거 (서버 trim 규칙과 동일) */
export function trimClientPath(snake: ClientSnake, config: GameConfig): void {
  const keep = bodyLengthForMass(config, snake.mass) + config.snake.segmentSpacing * 2;
  let acc = 0;
  let prev = { x: snake.x, y: snake.y };
  for (let i = 0; i < snake.path.length; i++) {
    const node = snake.path[i]!;
    acc += Math.hypot(node.x - prev.x, node.y - prev.y);
    prev = node;
    if (acc > keep) {
      snake.path.length = i + 1;
      break;
    }
  }
}

export function createWorldFromWelcome(welcome: WelcomeMessage, config: GameConfig): NetWorldState {
  const world: NetWorldState = {
    playerId: welcome.playerId,
    arena: welcome.arena,
    tickId: welcome.tickId,
    lastAckInputSeq: 0,
    snakes: new Map(welcome.players.map((p) => [p.id, toClientSnake(p)])),
    pellets: new Map(),
    chunkPellets: new Map(),
  };
  addPellets(world, welcome.pellets, config);
  return world;
}

function chunkOf(x: number, y: number, config: GameConfig): string {
  const cell = config.interest.cellSize;
  return `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
}

function addPellets(world: NetWorldState, pellets: PelletSnapshot[], config: GameConfig): void {
  for (const p of pellets) {
    world.pellets.set(p.id, p);
    const chunkId = chunkOf(p.x, p.y, config);
    let set = world.chunkPellets.get(chunkId);
    if (!set) world.chunkPellets.set(chunkId, (set = new Set()));
    set.add(p.id);
  }
}

function applyDelta(snake: ClientSnake, delta: SnakeDelta, config: GameConfig): void {
  snake.alive = delta.alive;
  snake.x = delta.x;
  snake.y = delta.y;
  snake.angle = delta.angle;
  snake.mass = delta.mass;
  snake.score = delta.score;
  snake.boosting = delta.boosting;
  if (delta.newPathNodes.length > 0) {
    snake.path = [...delta.newPathNodes.map((n) => ({ x: n.x, y: n.y })), ...snake.path];
  }
  trimClientPath(snake, config);
}

/** snapshot 적용 — leaves → enters → 델타 → 펠릿 청크 증분 순서 */
export function applySnapshot(world: NetWorldState, snap: SnapshotMessage, config: GameConfig): void {
  if (snap.tickId < world.tickId) return; // 늦게 도착한 과거 snapshot 폐기
  world.tickId = snap.tickId;
  world.lastAckInputSeq = snap.lastAckInputSeq;

  for (const leave of snap.leaves) {
    if (leave.type === 'snake') {
      world.snakes.delete(leave.id);
    } else {
      const ids = world.chunkPellets.get(leave.chunkId);
      if (ids) for (const id of ids) world.pellets.delete(id);
      world.chunkPellets.delete(leave.chunkId);
    }
  }

  for (const enter of snap.enters) {
    if (enter.type === 'snake') {
      world.snakes.set(enter.snake.id, toClientSnake(enter.snake));
    } else {
      addPellets(world, enter.pellets, config);
    }
  }

  for (const delta of snap.snakes) {
    const snake = world.snakes.get(delta.id);
    if (!snake) continue; // enter를 아직 못 받은 경우 다음 baseline까지 무시
    applyDelta(snake, delta, config);
  }

  for (const chunk of snap.pelletChunks) {
    for (const removed of chunk.removed) {
      world.pellets.delete(removed);
      world.chunkPellets.get(chunk.chunkId)?.delete(removed);
    }
    addPellets(world, chunk.created, config);
  }
}
