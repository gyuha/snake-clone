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
  type LeaderboardMessage,
  type PelletChunkUpdate,
  type PelletSnapshot,
  type PlayerSnapshot,
  type ResultMessage,
  type SnakeDelta,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@serpent/protocol';
import { verifyToken } from '@serpent/api/tokens';
import { ClientAoi, type ObservedEntity } from '../aoi/AoiManager';
import { BotController } from '../bots/BotController';
import { Rng } from '@serpent/game-core';
import { RoomMetricsRegistry } from '../ops/RoomMetricsRegistry';
import { ResultOutbox } from '../ops/ResultOutbox';

export class ArenaState extends Schema {
  @type('number') tickId = 0;
  @type('string') configVersion = '';
}

interface CreateOptions {
  /** 서버 시작 시 검증되어 주입된 설정. 원격 클라이언트가 바꿀 수 없다. */
  runtimeConfig?: GameConfig;
  /** 프로세스 로컬 운영 메트릭 레지스트리 (클라이언트 옵션으로는 주입되지 않음). */
  metrics?: RoomMetricsRegistry;
  /** 테스트/운영 오버라이드 — SERPENT_ALLOW_ROOM_OPTIONS=1 일 때만 반영 */
  config?: Partial<GameConfig>;
  seed?: number;
  /** 테스트 전용 Room 교체 시간 오버라이드. */
  roomMaxAgeMs?: number;
}

const DEFAULT_ROOM_MAX_AGE_MS = 30 * 60_000;

/** 점수 우선, 먼저 스폰(더 긴 생존 시간) 우선, 마지막으로 ID로 안정 정렬한다. */
export function compareSnakeRank(
  a: Pick<SnakeState, 'id' | 'score' | 'spawnedAtTick' | 'spawnOrder'>,
  b: Pick<SnakeState, 'id' | 'score' | 'spawnedAtTick' | 'spawnOrder'>,
): number {
  return b.score - a.score || a.spawnedAtTick - b.spawnedAtTick || a.spawnOrder - b.spawnOrder || a.id.localeCompare(b.id);
}

/** 장시간 Room은 새 입장을 차단해 다음 Room으로 자연 교체한다 (PRD §5.6). */
export function roomMaxAgeMs(raw = process.env.SERPENT_ROOM_MAX_AGE_MS): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 60_000 ? value : DEFAULT_ROOM_MAX_AGE_MS;
}

/** PRD §5.5 단절 정책: 처음 3초는 유지, 이후 reconnect grace 끝까지 선형 감속. */
export function disconnectSpeedMultiplier(elapsedMs: number, graceMs: number): number {
  const coastMs = 3_000;
  if (elapsedMs <= coastMs) return 1;
  return Math.max(0, 1 - (elapsedMs - coastMs) / Math.max(1, graceMs - coastMs));
}

interface RateWindow {
  windowStart: number;
  count: number;
}

/** 잘못된 schema/future-seq 반복은 정상 패킷 드롭과 달리 연결 정책 대상이다. */
type ViolationWindow = RateWindow;

export const INVALID_INPUT_WINDOW_MS = 10_000;
export const INVALID_INPUT_DISCONNECT_AFTER = 10;

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
  private invalidInputWindows = new Map<string, ViolationWindow>();
  /** 비의도 단절 시작 시각. grace 전반은 마지막 입력 유지, 3초 후 감속한다. */
  private disconnectedAt = new Map<string, number>();
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

  /** 서버 봇 (PRD §5.7 / FR-MATCH-03) */
  private bots = new Map<string, BotController>();
  private botRng!: Rng;
  private nextBotNo = 1;
  private metrics?: RoomMetricsRegistry;
  private draining = false;

  /** 1회용 joinToken nonce 기록 (프로세스 범위 — PRD §14.2 1회 사용) */
  private static usedJoinNonces = new Set<string>();
  /** sessionId → 인증된 userId (joinToken sub) */
  private userIds = new Map<string, string>();
  /** sessionId → 표시 이름/스킨 (코스메틱 — FR-COS-01) */
  private displayNames = new Map<string, string>();
  private skins = new Map<string, number>();
  /** 프로세스 범위 결과 outbox — 선택적으로 디스크에도 write-ahead 저장한다. */
  private static resultOutbox = new ResultOutbox();
  private static flushingResults = false;

  static resultBacklogSize(): number { return ArenaRoom.resultOutbox.length; }

  onCreate(options?: CreateOptions) {
    const allowOverrides = process.env.SERPENT_ALLOW_ROOM_OPTIONS === '1';
    this.config = options?.runtimeConfig ?? createGameConfig(allowOverrides ? options?.config : undefined);
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
    this.metrics = options?.metrics;
    void ArenaRoom.resultOutbox.load();
    this.metrics?.register(this.roomId, this.config.version, () => this.drain());
    const maxAgeMs = allowOverrides && options?.roomMaxAgeMs !== undefined
      ? Math.max(1, options.roomMaxAgeMs)
      : roomMaxAgeMs();
    this.clock.setTimeout(() => void this.drain(), maxAgeMs);

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
    this.onMessage(MSG.ping, (client, raw: unknown) => this.handlePing(client, raw));
    this.onMessage(MSG.resync, (client) => this.handleResync(client));

    this.setSimulationInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.metrics?.recordError(this.roomId);
        throw error;
      }
    }, this.config.simulation.fixedDeltaMs);

    // 봇 판단 8Hz — 이동은 서버 틱에서 처리 (PRD §5.7 성능)
    this.botRng = new Rng(((Date.now() ^ 0xb07) & 0xffffffff) >>> 0);
    this.clock.setInterval(() => {
      for (const bot of this.bots.values()) bot.decide();
    }, 125);

    // 결과 저장 파이프 — 틱 밖 주기 플러시 (SERPENT_API_URL 설정 시에만)
    if (process.env.SERPENT_API_URL) {
      this.clock.setInterval(() => void this.flushResults(), 500);
    }

    // 방 내 리더보드 — 4Hz (PRD §5.2 Leaderboard, FR-RANK-01)
    this.clock.setInterval(
      () => this.broadcastLeaderboard(),
      1000 / this.config.leaderboard.updateHz,
    );
  }

  /** Top N + 본인 순위 — 점수 우선, 생존 시간(이른 스폰 틱) 타이브레이크 */
  private broadcastLeaderboard(): void {
    const sorted = [...this.sim.snakes.values()]
      .filter((s) => s.alive)
      .sort(compareSnakeRank);
    const entries = sorted.slice(0, this.config.leaderboard.size).map((s) => ({
      id: s.id,
      name: this.displayNames.get(s.id) ?? s.id.slice(0, 6),
      score: s.score,
    }));
    for (const client of this.clients) {
      const selfRank = sorted.findIndex((s) => s.id === client.sessionId) + 1;
      const message: LeaderboardMessage = { entries, selfRank, totalPlayers: sorted.length };
      client.send(MSG.leaderboard, message);
    }
  }

  /**
   * joinToken 검증 (PRD §11.3/§14.2 — roomName·userId·expiry·nonce 바인딩, 1회 사용).
   * SERPENT_REQUIRE_JOIN_TOKEN=1 일 때만 강제 — 개발/오프라인 경로는 통과.
   */
  async onAuth(client: Client, options?: { joinToken?: string; protocolVersion?: number }) {
    if (options?.protocolVersion !== undefined && options.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`protocol_version_mismatch:${PROTOCOL_VERSION}`);
    }
    if (process.env.SERPENT_REQUIRE_JOIN_TOKEN !== '1') {
      if (this.draining) throw new Error('room is draining');
      return true;
    }
    const secret = process.env.SERPENT_TOKEN_SECRET ?? 'dev-secret-change-me';
    const token = options?.joinToken;
    const payload = typeof token === 'string' ? verifyToken(token, secret, 'join') : null;
    if (!payload || payload.roomName !== 'arena') {
      throw new Error('invalid join token');
    }
    const nonce = String(payload.nonce ?? '');
    if (!nonce || ArenaRoom.usedJoinNonces.has(nonce)) {
      throw new Error('join token already used');
    }
    // Drain 중에는 이미 이 Room에 있던 사용자의 재연결만 허용한다 (§9.6).
    if (this.draining && ![...this.userIds.values()].includes(payload.sub)) {
      throw new Error('room is draining');
    }
    ArenaRoom.usedJoinNonces.add(nonce);
    if (ArenaRoom.usedJoinNonces.size > 10_000) ArenaRoom.usedJoinNonces.clear();
    return {
      userId: payload.sub,
      // API가 저장·검증한 프로필을 HMAC 토큰에 담는다. 클라이언트 join options는
      // 토큰 강제 환경에서 표시 코스메틱의 출처가 될 수 없다.
      nickname: typeof payload.nickname === 'string' ? payload.nickname : null,
      skinId: typeof payload.skinId === 'number' ? payload.skinId : 0,
    };
  }

  /** 운영 drain: matchmaker를 잠그되 현재 게임 틱과 재연결 grace는 유지한다. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    await this.lock();
    this.broadcast(MSG.event, {
      type: 'notice',
      tickId: this.sim.tickId,
      level: 'warning',
      message: '서버 교체를 준비 중입니다. 현재 경기는 계속 진행되며, 종료 후 새 Room으로 연결됩니다.',
    } satisfies EventMessage);
  }

  isDraining(): boolean {
    return this.draining;
  }

  onJoin(
    client: Client,
    options?: { nickname?: unknown; skinId?: unknown },
    auth?: { userId?: string; nickname?: string | null; skinId?: number } | boolean,
  ) {
    const snake = this.sim.addSnake(client.sessionId);
    this.lastAck.set(client.sessionId, 0);
    this.spawnTimes.set(client.sessionId, Date.now());
    this.kills.set(client.sessionId, 0);
    this.pathWindows.set(client.sessionId, { lastFront: snake.path[0], newNodes: [] });
    const userId = typeof auth === 'object' && auth?.userId ? auth.userId : client.sessionId;
    this.userIds.set(client.sessionId, userId);

    // joinToken 경로는 API가 서명한 프로필만 사용한다. 비강제 로컬 개발만
    // 기존 options 기반 코스메틱을 허용한다.
    const signedProfile = typeof auth === 'object' && auth !== null;
    const rawName = signedProfile
      ? (auth.nickname ?? '')
      : (typeof options?.nickname === 'string' ? options.nickname.trim() : '');
    this.displayNames.set(client.sessionId, rawName.slice(0, 16) || `guest-${client.sessionId.slice(0, 4)}`);
    const rawSkin = signedProfile ? auth.skinId : options?.skinId;
    const skinId =
      typeof rawSkin === 'number' && Number.isInteger(rawSkin) && rawSkin >= 0 && rawSkin <= 12
        ? rawSkin
        : 0;
    this.skins.set(client.sessionId, skinId);

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
    this.adjustBots();
  }

  async onLeave(client: Client, consented?: boolean) {
    const id = client.sessionId;
    const snake = this.sim.snakes.get(id);

    // 비의도 절단 + 생존 중 → 재연결 grace (PRD §5.5 / FR-GAME-04).
    // 절단 동안 뱀은 마지막 입력을 유지한 채 계속 시뮬레이션된다.
    if (!consented && snake?.alive) {
      this.disconnectedAt.set(id, Date.now());
      try {
        const reconnected = await this.allowReconnection(client, this.config.reconnect.graceMs / 1000);
        // 재접속 성공: 동일 playerId·상태 회수, 새 연결로 baseline 전송
        this.disconnectedAt.delete(id);
        const restored = this.sim.snakes.get(id);
        if (restored) restored.speedMultiplier = 1;
        this.handleResync(reconnected ?? client);
        return;
      } catch {
        // grace 초과 → 일반 충돌과 같은 사망/잔해/결과 파이프를 남긴 뒤 정리
        const death = this.sim.forceDeath(id, 'disconnect');
        if (death?.cause === 'disconnect') this.publishDisconnectedDeath(death.tickId, death.snakeId);
      }
    }

    this.sim.removeSnake(id);
    this.lastAck.delete(id);
    this.rateWindows.delete(id);
    this.invalidInputWindows.delete(id);
    this.disconnectedAt.delete(id);
    this.spawnTimes.delete(id);
    this.kills.delete(id);
    this.snakeAoi.delete(id);
    this.chunkAoi.delete(id);
    this.pathWindows.delete(id);
    this.userIds.delete(id);
    this.displayNames.delete(id);
    this.skins.delete(id);
    this.adjustBots();
    this.metrics?.removeClient(this.roomId, id);
  }

  /** 테스트/진단: 해당 뱀이 시뮬레이션에 존재하는가 */
  hasSnake(id: string): boolean {
    return this.sim.snakes.has(id);
  }

  /** 이미 떠난 클라이언트의 grace 만료 사망도 관전자와 결과 저장에 남긴다. */
  private publishDisconnectedDeath(tickId: number, snakeId: string): void {
    this.broadcast(MSG.event, {
      type: 'death', tickId, snakeId, cause: 'disconnect',
    });
    const snake = this.sim.snakes.get(snakeId);
    if (!snake) return;
    const matchId = this.matchIdFor(snakeId);
    const result: ResultMessage = {
      matchId,
      rank: this.rankOf(snakeId),
      score: snake.score,
      length: Math.round(bodyLengthForMass(this.config, snake.mass)),
      survivalMs: Date.now() - (this.spawnTimes.get(snakeId) ?? Date.now()),
      kills: this.kills.get(snakeId) ?? 0,
      reason: 'disconnect',
    };
    ArenaRoom.resultOutbox.enqueue({
      matchId,
      userId: this.userIds.get(snakeId) ?? snakeId,
      body: result,
    });
  }

  /** 결과 큐 플러시 — 틱 루프 밖에서 실행, 실패 시 재시도(선두 유지) */
  private async flushResults(): Promise<void> {
    const base = process.env.SERPENT_API_URL;
    if (!base) return;
    const secret = process.env.SERPENT_INTERNAL_SECRET ?? 'dev-internal-secret';
    if (ArenaRoom.flushingResults) return;
    ArenaRoom.flushingResults = true;
    try {
    while (ArenaRoom.resultOutbox.length > 0) {
      const item = ArenaRoom.resultOutbox.peek()!;
      try {
        const res = await fetch(`${base}/v1/internal/results`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
          body: JSON.stringify({
            matchId: item.matchId,
            userId: item.userId,
            score: item.body.score,
            rank: item.body.rank,
            lengthAtDeath: item.body.length,
            survivalMs: item.body.survivalMs,
            kills: item.body.kills,
            reason: item.body.reason,
          }),
        });
        if (!res.ok && res.status !== 200) throw new Error(`status ${res.status}`);
        ArenaRoom.resultOutbox.shift();
      } catch {
        break; // 다음 주기에 재시도 (matchId 멱등이므로 중복 안전)
      }
    }
    } finally { ArenaRoom.flushingResults = false; }
  }

  /** 봇 수를 목표 최소 인원에 맞춘다: bots = clamp(minHumans − humans, 0, maxBots) */
  private adjustBots(): void {
    const humans = this.clients.length;
    const target = Math.min(
      this.config.room.maxBots,
      Math.max(0, this.config.room.minHumans - humans),
    );
    while (this.bots.size < target) {
      const id = `bot-${this.nextBotNo++}`;
      const snake = this.sim.addSnake(id);
      this.pathWindows.set(id, { lastFront: snake.path[0], newNodes: [] });
      this.bots.set(id, new BotController(this.sim, id, this.botRng));
      this.displayNames.set(id, `Serpent-${this.nextBotNo - 1}`);
      this.skins.set(id, Math.floor(this.botRng.range(0, 8)));
    }
    while (this.bots.size > target) {
      const id = [...this.bots.keys()].pop()!;
      this.bots.delete(id);
      this.sim.removeSnake(id);
      this.pathWindows.delete(id);
      this.displayNames.delete(id);
      this.skins.delete(id);
    }
  }

  /** 테스트/운영 진단용 인구 조회 */
  getPopulation(): { humans: number; bots: number } {
    return { humans: this.clients.length, bots: this.bots.size };
  }

  private handleInput(client: Client, raw: unknown) {
    const msg = validateInputMessage(raw);
    if (!msg) {
      this.recordInvalidInput(client);
      return;
    }

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
    // seq가 과도하게 앞서면 이후 정상 입력이 모두 오래된 것으로 폐기되는
    // sequence-poisoning이 가능하다. 약 2초치 입력만 앞설 수 있게 한다.
    const maxSeqLead = Math.max(32, Math.ceil(this.config.network.inputRate * 2));
    if (msg.seq > last + maxSeqLead) {
      this.recordInvalidInput(client);
      return;
    }
    this.lastAck.set(client.sessionId, msg.seq);

    this.sim.setInput(client.sessionId, { dirX: msg.dirX, dirY: msg.dirY, boost: msg.boost });
  }

  /** 반복되는 malformed/future 입력은 경기 공정성보다 먼저 연결을 차단한다 (PRD §14.2). */
  private recordInvalidInput(client: Client): void {
    this.metrics?.recordError(this.roomId);
    const now = Date.now();
    const existing = this.invalidInputWindows.get(client.sessionId);
    const window = !existing || now - existing.windowStart >= INVALID_INPUT_WINDOW_MS
      ? { windowStart: now, count: 1 }
      : { ...existing, count: existing.count + 1 };
    this.invalidInputWindows.set(client.sessionId, window);
    if (window.count >= INVALID_INPUT_DISCONNECT_AFTER) {
      client.leave(4000, 'too many invalid input messages');
    }
  }

  /** ping → pong: RTT/offset 추정 재료 (PRD §9.5) */
  private handlePing(client: Client, raw: unknown) {
    if (typeof raw !== 'object' || raw === null) return;
    const m = raw as Record<string, unknown>;
    if (typeof m.nonce !== 'number' || !Number.isFinite(m.nonce)) return;
    if (typeof m.clientTime !== 'number' || !Number.isFinite(m.clientTime)) return;
    if (typeof m.rttMs === 'number') this.metrics?.reportRtt(this.roomId, client.sessionId, m.rttMs);
    client.send(MSG.pong, { nonce: m.nonce, clientTime: m.clientTime, serverTime: Date.now() });
  }

  /** resync: 클라이언트 baseline 붕괴 시 AOI 구독을 리셋하고 full baseline 재전송 (PRD §11.4/§11.6) */
  private handleResync(client: Client) {
    const snake = this.sim.snakes.get(client.sessionId);
    if (!snake) return;
    const { radius, despawnRadius } = this.config.interest;
    const snakeAoi = new ClientAoi({ radius, despawnRadius });
    const chunkAoi = new ClientAoi({
      radius: this.chunkRadius(radius),
      despawnRadius: this.chunkRadius(despawnRadius),
    });
    this.snakeAoi.set(client.sessionId, snakeAoi);
    this.chunkAoi.set(client.sessionId, chunkAoi);
    snakeAoi.update(snake.head, this.observedSnakes(), client.sessionId);
    chunkAoi.update(snake.head, this.observedChunks());
    client.send(MSG.welcome, this.buildWelcome(client.sessionId, snakeAoi, chunkAoi));
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
    const startedAt = performance.now();
    this.applyDisconnectedDeceleration();
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
        const killEvent: EventMessage = {
          type: 'kill',
          tickId: d.tickId,
          killerId: d.killerId,
          victimId: d.snakeId,
        };
        this.broadcast(MSG.event, killEvent);
      }

      // 봇 사망 → 자동 재스폰 (컨트롤러 유지)
      if (this.bots.has(d.snakeId)) {
        this.sim.removeSnake(d.snakeId);
        const fresh = this.sim.addSnake(d.snakeId);
        this.pathWindows.set(d.snakeId, { lastFront: fresh.path[0], newNodes: [] });
        for (const [sessionId, aoi] of this.snakeAoi) {
          if (sessionId !== d.snakeId) aoi.forget(d.snakeId);
        }
        continue;
      }

      const victim = this.clients.find((c) => c.sessionId === d.snakeId);
      const snake = this.sim.snakes.get(d.snakeId);
      if (victim && snake) {
        const matchId = this.matchIdFor(d.snakeId);
        const result: ResultMessage = {
          matchId,
          rank: this.rankOf(d.snakeId),
          score: snake.score,
          length: Math.round(bodyLengthForMass(this.config, snake.mass)),
          survivalMs: Date.now() - (this.spawnTimes.get(d.snakeId) ?? Date.now()),
          kills: this.kills.get(d.snakeId) ?? 0,
          reason: d.cause,
        };
        victim.send(MSG.result, result);
        // api 결과 저장 큐 (틱 밖 플러시, matchId = 이번 생 단위)
        ArenaRoom.resultOutbox.enqueue({
          matchId,
          userId: this.userIds.get(d.snakeId) ?? d.snakeId,
          body: result,
        });
      }
    }

    if (this.sim.tickId % this.ticksPerSnapshot === 0) {
      this.sendSnapshots();
    }
    this.metrics?.observeTick(this.roomId, performance.now() - startedAt, this.clients.length, this.bots.size);
  }

  /** PRD §5.5: 3초는 마지막 입력 유지, 이후 grace 종료까지 선형 감속한다. */
  private applyDisconnectedDeceleration(): void {
    const now = Date.now();
    const graceMs = this.config.reconnect.graceMs;
    for (const [id, disconnectedAt] of this.disconnectedAt) {
      const snake = this.sim.snakes.get(id);
      if (!snake?.alive) continue;
      const elapsed = now - disconnectedAt;
      if (elapsed <= 3_000) continue;
      snake.speedMultiplier = disconnectSpeedMultiplier(elapsed, graceMs);
      // 부스트는 단절 이후 사용하지 않고, 마지막 진행 방향만 보존한다.
      this.sim.setInput(id, { dirX: Math.cos(snake.angle), dirY: Math.sin(snake.angle), boost: false });
    }
  }

  /** Room 안에서 사용자 한 번의 생명 주기를 구분하는 결과 멱등 키. */
  private matchIdFor(snakeId: string): string {
    return `${this.roomId}:${snakeId}:${this.spawnTimes.get(snakeId) ?? 0}`;
  }

  onDispose() {
    this.metrics?.unregister(this.roomId);
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
      // JSON 기준 payload 크기라 compression/wire overhead에는 독립적이다. 실제 전송량
      // 경향과 AOI 밀도를 함께 보아 40KB/s 예산과 팝인 위험을 판단한다 (PRD §9.8.8).
      const entitiesInAoi = snakeAoi.knownIds().size + [...chunkAoi.knownIds()]
        .reduce((total, chunkId) => total + (this.chunkPellets.get(chunkId)?.size ?? 0), 0);
      this.metrics?.observeSnapshot(
        this.roomId,
        Buffer.byteLength(JSON.stringify(snapshot)),
        entitiesInAoi,
      );
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
      name: this.displayNames.get(s.id) ?? s.id.slice(0, 6),
      skinId: this.skins.get(s.id) ?? 0,
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
    const sorted = [...this.sim.snakes.values()].sort(compareSnakeRank);
    return sorted.findIndex((s) => s.id === snakeId) + 1;
  }
}
