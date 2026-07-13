import { Room } from 'colyseus';
import type { Client } from 'colyseus';
import { Schema, type } from '@colyseus/schema';
import { createGameConfig, type GameConfig } from '@serpent/config';
import {
  Simulation,
  bodyLengthForMass,
  chunkKeyForPosition,
  type SnakeState,
  type Vec2,
} from '@serpent/game-core';
import {
  MSG,
  PROTOCOL_VERSION,
  validateInputMessage,
  type AoiEnter,
  type AoiLeave,
  type EventMessage,
  type PelletChunkUpdate,
  type PelletSnapshot,
  type PlayerSnapshot,
  type ResultMessage,
  type SnakeDelta,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@serpent/protocol';
import { ClientAoi, type ObservedEntity } from '../aoi/AoiManager';

export class ArenaState extends Schema {
  @type('number') tickId = 0;
  @type('string') configVersion = '';
}

interface CreateOptions {
  /** 테스트/운영 오버라이드 — SERPENT_ALLOW_ROOM_OPTIONS=1 일 때만 반영 */
  config?: Partial<GameConfig>;
  seed?: number;
}

interface RateWindow {
  windowStart: number;
  count: number;
}

/** snapshot 창(window) 동안 누적되는 뱀 경로 신규 키포인트 */
interface PathWindow {
  lastFront: Vec2 | undefined;
  newNodes: Vec2[];
}

/**
 * 권위형 아레나 룸 (M4: AOI + 델타).
 * - 시뮬레이션은 game-core (spatial hash 충돌 포함).
 * - 전송은 클라이언트별 관심 영역으로 필터: AOI 밖 엔터티는 보내지 않는다 (PRD §9.8.3).
 * - 뱀 몸통은 신규 경로 키포인트만 델타로, 펠릿은 청크 단위 배치로 동기화 (PRD §9.8.5~6).
 */
export class ArenaRoom extends Room<ArenaState> {
  private sim!: Simulation;
  private config!: GameConfig;
  private ticksPerSnapshot = 2;

  private lastAck = new Map<string, number>();
  private rateWindows = new Map<string, RateWindow>();
  private spawnTimes = new Map<string, number>();
  private kills = new Map<string, number>();

  /** 클라이언트별 AOI 구독 상태 (뱀/펠릿청크 분리) */
  private snakeAoi = new Map<string, ClientAoi>();
  private chunkAoi = new Map<string, ClientAoi>();

  /** 청크 → 펠릿 id 인덱스 (스폰/섭취 시에만 갱신) */
  private chunkPellets = new Map<string, Set<number>>();
  /** 펠릿 id → 청크 (제거 시 역참조) */
  private pelletChunkOf = new Map<number, string>();
  /** snapshot 창 동안의 청크별 펠릿 증분 */
  private chunkCreated = new Map<string, PelletSnapshot[]>();
  private chunkRemoved = new Map<string, number[]>();
  /** 아레나 전 청크의 중심 좌표 (AOI 판정용) */
  private chunkCenters: { id: string; x: number; y: number }[] = [];

  /** snapshot 창 동안의 뱀별 신규 경로 키포인트 */
  private pathWindows = new Map<string, PathWindow>();

  onCreate(options?: CreateOptions) {
    const allowOverrides = process.env.SERPENT_ALLOW_ROOM_OPTIONS === '1';
    this.config = createGameConfig(allowOverrides ? options?.config : undefined);
    this.maxClients = this.config.room.maxPlayers;
    this.ticksPerSnapshot = Math.max(
      1,
      Math.round(this.config.simulation.tickRate / this.config.simulation.snapshotRate),
    );

    const state = new ArenaState();
    state.configVersion = this.config.version;
    this.setState(state);

    this.sim = new Simulation(
      this.config,
      (allowOverrides ? options?.seed : undefined) ?? (Date.now() & 0xffffffff) >>> 0,
    );
    this.sim.seedPellets();

    // 청크 인덱스 초기화
    const cell = this.config.interest.cellSize;
    for (let cx = 0; cx * cell < this.config.arena.width; cx++) {
      for (let cy = 0; cy * cell < this.config.arena.height; cy++) {
        const id = `${cx}:${cy}`;
        this.chunkCenters.push({ id, x: (cx + 0.5) * cell, y: (cy + 0.5) * cell });
        this.chunkPellets.set(id, new Set());
      }
    }
    for (const p of this.sim.pellets.values()) {
      const chunkId = chunkKeyForPosition(p.x, p.y, cell);
      this.chunkPellets.get(chunkId)?.add(p.id);
      this.pelletChunkOf.set(p.id, chunkId);
    }

    this.onMessage(MSG.input, (client, raw: unknown) => this.handleInput(client, raw));
    this.onMessage(MSG.respawn, (client) => this.handleRespawn(client));

    this.setSimulationInterval(() => this.tick(), this.config.simulation.fixedDeltaMs);
  }

  onJoin(client: Client) {
    const snake = this.sim.addSnake(client.sessionId);
    this.lastAck.set(client.sessionId, 0);
    this.spawnTimes.set(client.sessionId, Date.now());
    this.kills.set(client.sessionId, 0);
    this.pathWindows.set(client.sessionId, { lastFront: snake.path[0], newNodes: [] });

    const { radius, despawnRadius } = this.config.interest;
    const snakeAoi = new ClientAoi({ radius, despawnRadius });
    const chunkAoi = new ClientAoi({ radius: this.chunkRadius(radius), despawnRadius: this.chunkRadius(despawnRadius) });
    this.snakeAoi.set(client.sessionId, snakeAoi);
    this.chunkAoi.set(client.sessionId, chunkAoi);

    // welcome baseline = 스폰 지점 AOI 내 엔터티만 (그 외는 이후 aoi_enter로)
    snakeAoi.update(snake.head, this.observedSnakes(), client.sessionId);
    chunkAoi.update(snake.head, this.observedChunks());
    client.send(MSG.welcome, this.buildWelcome(client.sessionId, snakeAoi, chunkAoi));

    const spawnEvent: EventMessage = {
      type: 'spawn',
      tickId: this.sim.tickId,
      snakeId: client.sessionId,
      x: snake.head.x,
      y: snake.head.y,
    };
    this.broadcast(MSG.event, spawnEvent, { except: client });
  }

  onLeave(client: Client) {
    this.sim.removeSnake(client.sessionId);
    this.lastAck.delete(client.sessionId);
    this.rateWindows.delete(client.sessionId);
    this.spawnTimes.delete(client.sessionId);
    this.kills.delete(client.sessionId);
    this.snakeAoi.delete(client.sessionId);
    this.chunkAoi.delete(client.sessionId);
    this.pathWindows.delete(client.sessionId);
  }

  private handleInput(client: Client, raw: unknown) {
    const msg = validateInputMessage(raw);
    if (!msg) return;

    const cap = Math.ceil(this.config.network.inputRate * 1.5);
    const now = Date.now();
    const w = this.rateWindows.get(client.sessionId);
    if (!w || now - w.windowStart >= 1000) {
      this.rateWindows.set(client.sessionId, { windowStart: now, count: 1 });
    } else {
      if (w.count >= cap) return;
      w.count++;
    }

    const last = this.lastAck.get(client.sessionId) ?? 0;
    if (msg.seq <= last) return;
    this.lastAck.set(client.sessionId, msg.seq);

    this.sim.setInput(client.sessionId, { dirX: msg.dirX, dirY: msg.dirY, boost: msg.boost });
  }

  private handleRespawn(client: Client) {
    const snake = this.sim.snakes.get(client.sessionId);
    if (!snake || snake.alive) return;
    this.sim.removeSnake(client.sessionId);
    const fresh = this.sim.addSnake(client.sessionId);
    this.spawnTimes.set(client.sessionId, Date.now());
    this.kills.set(client.sessionId, 0);
    this.pathWindows.set(client.sessionId, { lastFront: fresh.path[0], newNodes: [] });

    // 모든 구독자에게 새 baseline이 가도록 기존 구독을 리셋 (다음 경계에 재-enter)
    for (const [sessionId, aoi] of this.snakeAoi) {
      if (sessionId !== client.sessionId) aoi.forget(client.sessionId);
    }

    const snakeAoi = this.snakeAoi.get(client.sessionId)!;
    const chunkAoi = this.chunkAoi.get(client.sessionId)!;
    snakeAoi.update(fresh.head, this.observedSnakes(), client.sessionId);
    chunkAoi.update(fresh.head, this.observedChunks());
    client.send(MSG.welcome, this.buildWelcome(client.sessionId, snakeAoi, chunkAoi));

    const spawnEvent: EventMessage = {
      type: 'spawn',
      tickId: this.sim.tickId,
      snakeId: client.sessionId,
      x: fresh.head.x,
      y: fresh.head.y,
    };
    this.broadcast(MSG.event, spawnEvent, { except: client });
  }

  private tick() {
    const before = new Set(this.sim.pellets.keys());
    const events = this.sim.step();
    this.state.tickId = this.sim.tickId;

    const cell = this.config.interest.cellSize;

    // 펠릿 증분 → 청크 인덱스/창 반영
    for (const id of before) {
      if (!this.sim.pellets.has(id)) {
        const chunkId = this.pelletChunkOf.get(id);
        if (!chunkId) continue;
        this.pelletChunkOf.delete(id);
        this.chunkPellets.get(chunkId)?.delete(id);
        let arr = this.chunkRemoved.get(chunkId);
        if (!arr) this.chunkRemoved.set(chunkId, (arr = []));
        arr.push(id);
      }
    }
    for (const [id, p] of this.sim.pellets) {
      if (!before.has(id)) {
        const chunkId = chunkKeyForPosition(p.x, p.y, cell);
        this.chunkPellets.get(chunkId)?.add(id);
        this.pelletChunkOf.set(id, chunkId);
        let arr = this.chunkCreated.get(chunkId);
        if (!arr) this.chunkCreated.set(chunkId, (arr = []));
        arr.push({ id, x: p.x, y: p.y, value: p.value });
      }
    }

    // 뱀별 신규 경로 키포인트 수집 (틱당 최대 1개 unshift)
    for (const s of this.sim.snakes.values()) {
      if (!s.alive) continue;
      const window = this.pathWindows.get(s.id);
      if (!window) continue;
      const front = s.path[0];
      if (front && front !== window.lastFront) {
        window.newNodes.unshift({ x: front.x, y: front.y });
        window.lastFront = front;
      }
    }

    // 사망 이벤트
    for (const d of events.deaths) {
      const deathEvent: EventMessage = {
        type: 'death',
        tickId: d.tickId,
        snakeId: d.snakeId,
        cause: d.cause,
        ...(d.killerId ? { killerId: d.killerId } : {}),
      };
      this.broadcast(MSG.event, deathEvent);

      if (d.killerId) {
        this.kills.set(d.killerId, (this.kills.get(d.killerId) ?? 0) + 1);
      }

      const victim = this.clients.find((c) => c.sessionId === d.snakeId);
      const snake = this.sim.snakes.get(d.snakeId);
      if (victim && snake) {
        const result: ResultMessage = {
          rank: this.rankOf(d.snakeId),
          score: snake.score,
          length: Math.round(bodyLengthForMass(this.config, snake.mass)),
          survivalMs: Date.now() - (this.spawnTimes.get(d.snakeId) ?? Date.now()),
          kills: this.kills.get(d.snakeId) ?? 0,
          reason: d.cause,
        };
        victim.send(MSG.result, result);
      }
    }

    if (this.sim.tickId % this.ticksPerSnapshot === 0) {
      this.sendSnapshots();
    }
  }

  /** 청크 AOI는 중심 거리 기준이므로 셀 반대각 절반만큼 반경을 보정 */
  private chunkRadius(r: number): number {
    return r + (this.config.interest.cellSize * Math.SQRT2) / 2;
  }

  private observedSnakes(): ObservedEntity[] {
    return [...this.sim.snakes.values()].map((s) => ({
      id: s.id,
      x: s.head.x,
      y: s.head.y,
      present: s.alive,
    }));
  }

  private observedChunks(): ObservedEntity[] {
    return this.chunkCenters.map((c) => ({ id: c.id, x: c.x, y: c.y, present: true }));
  }

  private sendSnapshots() {
    const serverTime = Date.now();
    const observedSnakes = this.observedSnakes();
    const observedChunks = this.observedChunks();

    for (const client of this.clients) {
      const me = this.sim.snakes.get(client.sessionId);
      const snakeAoi = this.snakeAoi.get(client.sessionId);
      const chunkAoi = this.chunkAoi.get(client.sessionId);
      if (!me || !snakeAoi || !chunkAoi) continue;

      const snakeDiff = snakeAoi.update(me.head, observedSnakes, client.sessionId);
      const chunkDiff = chunkAoi.update(me.head, observedChunks);

      const enters: AoiEnter[] = [];
      for (const id of snakeDiff.enters) {
        const s = this.sim.snakes.get(id);
        if (s) enters.push({ type: 'snake', snake: this.toPlayerSnapshot(s) });
      }
      for (const chunkId of chunkDiff.enters) {
        enters.push({ type: 'pelletChunk', chunkId, pellets: this.chunkBaseline(chunkId) });
      }

      const leaves: AoiLeave[] = [
        ...snakeDiff.leaves.map((id): AoiLeave => ({ type: 'snake', id })),
        ...chunkDiff.leaves.map((chunkId): AoiLeave => ({ type: 'pelletChunk', chunkId })),
      ];

      // 델타: 구독 중이면서 이번 경계에 enter되지 않은 뱀만 (enter는 baseline을 가짐)
      const enteredNow = new Set(snakeDiff.enters);
      const snakes: SnakeDelta[] = [];
      for (const id of snakeAoi.knownIds()) {
        if (enteredNow.has(id)) continue;
        const s = this.sim.snakes.get(id);
        if (!s) continue;
        snakes.push(this.toDelta(s));
      }

      // 펠릿 청크 증분: 구독 중이면서 이번 경계에 enter되지 않은 청크만
      const enteredChunks = new Set(chunkDiff.enters);
      const pelletChunks: PelletChunkUpdate[] = [];
      for (const chunkId of chunkAoi.knownIds()) {
        if (enteredChunks.has(chunkId)) continue;
        const created = this.chunkCreated.get(chunkId);
        const removed = this.chunkRemoved.get(chunkId);
        if (created?.length || removed?.length) {
          pelletChunks.push({ chunkId, created: created ?? [], removed: removed ?? [] });
        }
      }

      const snapshot: SnapshotMessage = {
        tickId: this.sim.tickId,
        serverTime,
        lastAckInputSeq: this.lastAck.get(client.sessionId) ?? 0,
        snakes,
        enters,
        leaves,
        pelletChunks,
      };
      client.send(MSG.snapshot, snapshot);
    }

    // 창 초기화 (모든 클라이언트가 같은 경계를 공유)
    this.chunkCreated.clear();
    this.chunkRemoved.clear();
    for (const window of this.pathWindows.values()) window.newNodes = [];
  }

  private chunkBaseline(chunkId: string): PelletSnapshot[] {
    const ids = this.chunkPellets.get(chunkId);
    if (!ids) return [];
    const out: PelletSnapshot[] = [];
    for (const id of ids) {
      const p = this.sim.pellets.get(id);
      if (p) out.push({ id: p.id, x: p.x, y: p.y, value: p.value });
    }
    return out;
  }

  private toDelta(s: SnakeState): SnakeDelta {
    const window = this.pathWindows.get(s.id);
    return {
      id: s.id,
      alive: s.alive,
      x: s.head.x,
      y: s.head.y,
      angle: s.angle,
      mass: s.mass,
      score: s.score,
      boosting: s.boosting,
      newPathNodes: window ? window.newNodes.map((n) => ({ x: n.x, y: n.y })) : [],
    };
  }

  private toPlayerSnapshot(s: SnakeState): PlayerSnapshot {
    return {
      id: s.id,
      alive: s.alive,
      x: s.head.x,
      y: s.head.y,
      angle: s.angle,
      mass: s.mass,
      score: s.score,
      boosting: s.boosting,
      path: s.path.map((p) => ({ x: p.x, y: p.y })),
    };
  }

  private buildWelcome(sessionId: string, snakeAoi: ClientAoi, chunkAoi: ClientAoi): WelcomeMessage {
    const players: PlayerSnapshot[] = [];
    for (const id of snakeAoi.knownIds()) {
      const s = this.sim.snakes.get(id);
      if (s) players.push(this.toPlayerSnapshot(s));
    }
    const pellets: PelletSnapshot[] = [];
    for (const chunkId of chunkAoi.knownIds()) {
      pellets.push(...this.chunkBaseline(chunkId));
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      playerId: sessionId,
      roomId: this.roomId,
      configVersion: this.config.version,
      tickRate: this.config.simulation.tickRate,
      snapshotRate: this.config.simulation.snapshotRate,
      serverTime: Date.now(),
      tickId: this.sim.tickId,
      arena: { width: this.config.arena.width, height: this.config.arena.height },
      players,
      pellets,
    };
  }

  private rankOf(snakeId: string): number {
    const sorted = [...this.sim.snakes.values()].sort((a, b) => b.score - a.score);
    return sorted.findIndex((s) => s.id === snakeId) + 1;
  }
}
