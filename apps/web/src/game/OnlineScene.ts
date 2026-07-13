import Phaser from 'phaser';
import { Client, type Room } from 'colyseus.js';
import type { GameConfig } from '@serpent/config';
import { bodyLengthForMass, sampleBodyPoints, type Vec2 } from '@serpent/game-core';
import {
  MSG,
  type EventMessage,
  type LeaderboardMessage,
  type ResultMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@serpent/protocol';
import { skinOf } from '../skins';
import { cameraZoomForLength } from './camera';
import { ClockSync } from '../net/clock';
import { snapshotIsStale } from '../net/connection';
import { RemoteInterpolator } from '../net/interpolation';
import { Predictor } from '../net/prediction';
import { reconnectDelayMs } from '../net/reconnect';
import { applySnapshot, createWorldFromWelcome, type NetWorldState } from '../net/state';
import type { GameBridge } from './bridge';
import { isTouchDevice, joystickVector } from './joystick';
import { gamepadInput, resolveInputDirection, type InputDevice } from './input';
import { SoundFeedback } from './sound';

export interface OnlineStartData {
  endpoint: string;
  roomName: string;
  joinToken?: string;
  nickname: string;
  skinId: number;
  /** API가 매칭 직전에 제공한 활성 설정. 서버 welcome version과 반드시 일치해야 한다. */
  config: GameConfig;
  quality: 'high' | 'low';
  reduceMotion: boolean;
  highContrast: boolean;
  volume: number;
  oneHanded: boolean;
  bridge: GameBridge;
}

/**
 * 온라인 아레나 (제품 플로우).
 * Phaser는 렌더/입력/예측/보간만, 리더보드·결과·HUD 표시는 브리지로 React에 넘긴다 (PRD §10.1).
 */
export class OnlineScene extends Phaser.Scene {
  private data_!: OnlineStartData;
  private config!: GameConfig;
  private client?: Client;
  private room?: Room;
  private world?: NetWorldState;
  private predictor!: Predictor;
  private interpolators = new Map<string, RemoteInterpolator>();
  private latestServerTime = 0;
  private latestServerTimeAt = 0;
  private clockSync = new ClockSync();
  private pingTimerMs = 0;
  private lastSnapshotTickId = 0;
  private lastResyncAt = 0;
  private snapshotStep = 2;
  private joinedReported = false;
  private firstInputReported = false;
  private intentionalLeave = false;
  private reconnecting = false;

  private seq = 0;
  private inputAccumulatorMs = 0;
  private lastDevice: InputDevice = 'pointer';
  private meAlive = false;
  private kills = 0;
  private hudTimerMs = 0;
  private renderAccumulatorMs = 0;
  private soundFeedback!: SoundFeedback;

  private worldGfx!: Phaser.GameObjects.Graphics;
  private uiGfx!: Phaser.GameObjects.Graphics;

  // 모바일 가상 조이스틱 (PRD §7.3)
  private readonly touchMode = isTouchDevice();
  private joyPointerId: number | null = null;
  private joyCenter: Vec2 | null = null;
  private joyDir: Vec2 | null = null;
  private boostPointerId: number | null = null;

  private keys!: Record<
    'w' | 'a' | 's' | 'd' | 'up' | 'down' | 'left' | 'right' | 'space',
    Phaser.Input.Keyboard.Key
  >;

  constructor() {
    super('online');
  }

  init(data: OnlineStartData) {
    this.data_ = data;
  }

  create() {
    this.config = this.data_.config;
    this.predictor = new Predictor(this.config);
    this.soundFeedback = new SoundFeedback(this.data_.volume);
    this.worldGfx = this.add.graphics();
    this.uiGfx = this.add.graphics().setScrollFactor(0).setDepth(15);

    const kb = this.input.keyboard!;
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      w: kb.addKey(K.W), a: kb.addKey(K.A), s: kb.addKey(K.S), d: kb.addKey(K.D),
      up: kb.addKey(K.UP), down: kb.addKey(K.DOWN), left: kb.addKey(K.LEFT), right: kb.addKey(K.RIGHT),
      space: kb.addKey(K.SPACE),
    };

    if (this.touchMode) {
      this.input.addPointer(2);
      this.setupTouchControls();
    }
    this.input.on('pointerdown', () => this.soundFeedback.unlock());
    this.input.keyboard?.on('keydown', () => this.soundFeedback.unlock());

    this.data_.bridge.requestRespawn = () => {
      this.room?.send(MSG.respawn, {});
      this.data_.bridge.onResult(null);
    };
    this.data_.bridge.leaveGame = () => {
      this.intentionalLeave = true;
      void this.room?.leave();
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.intentionalLeave = true;
    });

    void this.connect();
  }

  private async connect() {
    const bridge = this.data_.bridge;
    bridge.onStatus('서버 접속 중...');
    try {
      this.client = new Client(this.data_.endpoint);
      // API가 선택한 타깃의 논리 방 이름으로만 매칭한다. Colyseus는 해당 서버 안에서
      // 가용 수용량의 실제 Room을 고르므로, 클라이언트가 임의 roomId를 고를 수 없다.
      const room = await this.client.joinOrCreate(this.data_.roomName, {
        joinToken: this.data_.joinToken,
        protocolVersion: 1,
        nickname: this.data_.nickname,
        skinId: this.data_.skinId,
      });
      this.attachRoom(room);
    } catch (err) {
      bridge.onStatus(`접속 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private attachRoom(room: Room) {
    const bridge = this.data_.bridge;
    this.room = room;
    this.reconnecting = false;

    room.onMessage(MSG.welcome, (welcome: WelcomeMessage) => {
        if (welcome.configVersion !== this.config.version) {
          bridge.onStatus(`설정 버전 불일치 (server ${welcome.configVersion}) — 새로고침 필요`);
          bridge.onConfigMismatch?.(welcome.configVersion);
          this.intentionalLeave = true;
          void room.leave();
          return; // §6.1: 버전이 다른 Room의 simulation/input 경로를 절대 시작하지 않는다.
        }
        this.world = createWorldFromWelcome(welcome, this.config);
        this.interpolators.clear();
        this.latestServerTime = welcome.serverTime;
        this.latestServerTimeAt = performance.now();
        this.lastSnapshotTickId = welcome.tickId;
        this.snapshotStep = Math.max(1, Math.round(welcome.tickRate / welcome.snapshotRate));
        bridge.onStatus('');
        if (!this.joinedReported) {
          this.joinedReported = true;
          bridge.onRoomJoined?.();
        }

        const me = this.world.snakes.get(this.world.playerId);
        if (me) {
          this.meAlive = me.alive;
          this.kills = 0;
          this.predictor.reset(me, welcome.tickId);
          const cam = this.cameras.main;
          cam.setBounds(0, 0, welcome.arena.width, welcome.arena.height);
          cam.centerOn(me.x, me.y);
        }
    });

    room.onMessage(MSG.snapshot, (snap: SnapshotMessage) => this.onSnapshot(snap));

    room.onMessage(MSG.pong, (pong: { nonce: number; clientTime: number; serverTime: number }) => {
      this.clockSync.onPong(pong, performance.now());
    });

    room.onMessage(MSG.leaderboard, (lb: LeaderboardMessage) => {
      bridge.onLeaderboard(lb);
    });

    room.onMessage(MSG.event, (event: EventMessage) => {
      if (event.type === 'notice') {
        bridge.onStatus(event.message);
        return;
      }
      if (event.type === 'kill') {
        if (event.killerId === this.world?.playerId) {
          this.kills++;
          this.soundFeedback.play('kill');
        }
        return;
      }
      if (event.type !== 'death') return;
      if (event.snakeId === this.world?.playerId) {
        this.meAlive = false;
        this.soundFeedback.play('death');
      }
    });

    room.onMessage(MSG.result, (result: ResultMessage) => {
      bridge.onResult(result);
    });

    room.onLeave(() => {
      if (this.room !== room || this.intentionalLeave) return;
      this.room = undefined;
      void this.reconnect(room.reconnectionToken);
    });
  }

  private async reconnect(reconnectionToken: string) {
    if (this.reconnecting || !this.client || this.intentionalLeave) return;
    this.reconnecting = true;
    const deadline = performance.now() + this.config.reconnect.graceMs;
    let attempt = 0;

    while (!this.intentionalLeave && performance.now() < deadline) {
      const remainingSeconds = Math.max(1, Math.ceil((deadline - performance.now()) / 1_000));
      this.data_.bridge.onStatus(`연결이 끊겼습니다 — ${remainingSeconds}초 안에 재접속을 시도합니다`);
      await new Promise<void>((resolve) => setTimeout(resolve, reconnectDelayMs(attempt++)));
      if (this.intentionalLeave) break;
      try {
        const room = await this.client.reconnect(reconnectionToken);
        if (this.intentionalLeave) {
          void room.leave();
          break;
        }
        this.attachRoom(room);
        return;
      } catch {
        // grace window가 닫히기 전까지 같은 reconnection token으로 다시 시도한다.
      }
    }

    this.reconnecting = false;
    if (!this.intentionalLeave) this.data_.bridge.onStatus('재접속 시간이 만료되었습니다 — 새로고침 후 다시 입장해 주세요');
  }

  private onSnapshot(snap: SnapshotMessage) {
    if (!this.world) return;
    if (snap.tickId < this.world.tickId) return;

    if (
      this.lastSnapshotTickId > 0 &&
      snap.tickId - this.lastSnapshotTickId > this.snapshotStep * 3 &&
      performance.now() - this.lastResyncAt > 2_000
    ) {
      this.lastResyncAt = performance.now();
      this.room?.send(MSG.resync, { lastGoodTickId: this.lastSnapshotTickId, reason: 'snapshot-gap' });
    }
    this.lastSnapshotTickId = snap.tickId;

    applySnapshot(this.world, snap, this.config);
    this.latestServerTime = snap.serverTime;
    this.latestServerTimeAt = performance.now();

    const me = this.world.snakes.get(this.world.playerId);
    if (me) {
      this.meAlive = me.alive;
      if (me.alive) this.predictor.reconcile(me, snap.tickId);
    }

    for (const [id, s] of this.world.snakes) {
      if (id === this.world.playerId) continue;
      let interp = this.interpolators.get(id);
      if (!interp) {
        interp = new RemoteInterpolator(this.config.network.maxExtrapolationMs);
        this.interpolators.set(id, interp);
      }
      interp.push({
        time: snap.serverTime,
        x: s.x, y: s.y, angle: s.angle, mass: s.mass,
        boosting: s.boosting, alive: s.alive, path: [],
      });
    }
    for (const id of this.interpolators.keys()) {
      if (!this.world.snakes.has(id)) this.interpolators.delete(id);
    }
  }

  update(_time: number, deltaMs: number) {
    if (!this.world || !this.room) return;

    this.pingTimerMs += deltaMs;
    if (this.pingTimerMs >= 1_000) {
      this.pingTimerMs = 0;
      this.room.send(MSG.ping, {
        ...this.clockSync.createPing(performance.now()),
        ...(this.clockSync.hasEstimate() ? { rttMs: Math.round(this.clockSync.rtt()) } : {}),
      });
    }

    const stepMs = this.config.simulation.fixedDeltaMs;
    this.inputAccumulatorMs += Math.min(deltaMs, 250);
    while (this.inputAccumulatorMs >= stepMs) {
      this.inputAccumulatorMs -= stepMs;
      if (this.meAlive && this.predictor.state) this.inputTick();
    }

    const renderHead = this.predictor.renderHead(deltaMs);
    if (renderHead && this.meAlive) {
      const cam = this.cameras.main;
      const target = cam.getScroll(renderHead.x, renderHead.y);
      const smoothing = this.data_.reduceMotion ? 1 : 0.15;
      cam.setScroll(Phaser.Math.Linear(cam.scrollX, target.x, smoothing), Phaser.Math.Linear(cam.scrollY, target.y, smoothing));
      const length = bodyLengthForMass(this.config, this.predictor.state!.mass);
      cam.setZoom(Phaser.Math.Linear(cam.zoom, cameraZoomForLength(length), smoothing));
    }

    this.renderAccumulatorMs += deltaMs;
    const shouldRender = this.data_.quality === 'high' || this.renderAccumulatorMs >= 1000 / 30;
    if (shouldRender) { this.renderAccumulatorMs = 0; this.render(renderHead); }
    this.renderTouchControls();

    this.hudTimerMs += deltaMs;
    if (this.hudTimerMs >= 250) {
      this.hudTimerMs = 0;
      const me = this.world.snakes.get(this.world.playerId);
      if (me) {
        this.data_.bridge.onHud({
          score: me.score,
          length: Math.round(bodyLengthForMass(this.config, me.mass)),
          kills: this.kills,
          rttMs: this.clockSync.hasEstimate() ? Math.round(this.clockSync.rtt()) : null,
          snapshotStale: snapshotIsStale(this.latestServerTimeAt, performance.now()),
        });
      }
    }
  }

  private inputTick() {
    const state = this.predictor.state!;
    let dir: Vec2 | null = null;
    let boost = false;

    if (this.touchMode) {
      dir = this.joyDir;
      boost = this.boostPointerId !== null;
    } else {
      const gamepad = gamepadInput(navigator.getGamepads());
      if (gamepad.dir || gamepad.boost) {
        dir = gamepad.dir;
        boost = gamepad.boost;
        this.lastDevice = 'gamepad';
      } else {
        const pointer = this.input.activePointer;
        const pointerWorld = pointer ? this.cameras.main.getWorldPoint(pointer.x, pointer.y) : null;
        const resolved = resolveInputDirection({
          keys: {
            up: this.keys.w.isDown || this.keys.up.isDown,
            down: this.keys.s.isDown || this.keys.down.isDown,
            left: this.keys.a.isDown || this.keys.left.isDown,
            right: this.keys.d.isDown || this.keys.right.isDown,
          },
          pointerWorld: pointerWorld ? { x: pointerWorld.x, y: pointerWorld.y } : null,
          head: state.head,
          lastDevice: this.lastDevice,
        });
        this.lastDevice = resolved.device;
        dir = resolved.dir;
        boost = this.keys.space.isDown || this.input.activePointer.isDown;
      }
    }

    const finalDir = dir ?? { x: Math.cos(state.angle), y: Math.sin(state.angle) };
    const input = { seq: ++this.seq, clientTime: Date.now(), dirX: finalDir.x, dirY: finalDir.y, boost };
    this.room!.send(MSG.input, input);
    if (!this.firstInputReported) {
      this.firstInputReported = true;
      this.data_.bridge.onFirstInput?.();
    }
    this.predictor.applyInput(input);
  }

  // ── 모바일 가상 조이스틱 (PRD §7.3: 왼쪽 조이스틱 + 오른쪽 부스트) ──────
  private setupTouchControls() {
    const boostZone = () => ({
      x: this.scale.width - 90,
      y: this.data_.oneHanded ? this.scale.height - 220 : this.scale.height - 90,
      r: 52, // ≥ 44 CSS px (§7.4)
    });

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const b = boostZone();
      if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r) {
        this.boostPointerId = p.id;
        return;
      }
      const joystickSide = this.data_.oneHanded ? p.x >= this.scale.width / 2 : p.x < this.scale.width / 2;
      if (joystickSide && this.joyPointerId === null) {
        this.joyPointerId = p.id;
        this.joyCenter = { x: p.x, y: p.y };
        this.joyDir = null;
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p.id === this.joyPointerId && this.joyCenter) {
        const r = joystickVector(this.joyCenter, { x: p.x, y: p.y }, 70);
        if (r) this.joyDir = r.dir;
      }
    });
    const release = (p: Phaser.Input.Pointer) => {
      if (p.id === this.joyPointerId) {
        this.joyPointerId = null;
        this.joyCenter = null;
        // 방향은 유지 (마지막 조향 지속)
      }
      if (p.id === this.boostPointerId) this.boostPointerId = null;
    };
    this.input.on('pointerup', release);
    this.input.on('pointerupoutside', release);
  }

  private renderTouchControls() {
    const g = this.uiGfx;
    g.clear();
    if (!this.touchMode) {
      this.renderMiniMap(g);
      return;
    }
    // 부스트 버튼
    const bx = this.scale.width - 90;
    const by = this.data_.oneHanded ? this.scale.height - 220 : this.scale.height - 90;
    g.fillStyle(this.boostPointerId !== null ? 0x9be27f : 0x2a3a44, 0.7);
    g.fillCircle(bx, by, 52);
    // 조이스틱
    if (this.joyCenter) {
      g.lineStyle(2, 0x8aa0b8, 0.6);
      g.strokeCircle(this.joyCenter.x, this.joyCenter.y, 70);
      if (this.joyDir) {
        g.fillStyle(0x8aa0b8, 0.8);
        g.fillCircle(this.joyCenter.x + this.joyDir.x * 45, this.joyCenter.y + this.joyDir.y * 45, 22);
      }
    }
  }

  /** S-04 미니 상태: AOI 밖 상세 데이터는 쓰지 않고 현재 수신한 플레이어만 표시한다. */
  private renderMiniMap(g: Phaser.GameObjects.Graphics) {
    if (!this.world) return;
    const width = 128;
    const height = 88;
    const x = this.scale.width - width - 14;
    const y = this.scale.height - height - 14;
    const arena = this.world.arena;
    g.fillStyle(0x101418, 0.75);
    g.fillRoundedRect(x, y, width, height, 6);
    g.lineStyle(1, 0x4a5a68, 0.9);
    g.strokeRoundedRect(x, y, width, height, 6);
    for (const snake of this.world.snakes.values()) {
      if (!snake.alive) continue;
      const px = x + 3 + (snake.x / arena.width) * (width - 6);
      const py = y + 3 + (snake.y / arena.height) * (height - 6);
      const isMe = snake.id === this.world.playerId;
      g.fillStyle(isMe ? 0xffffff : skinOf(snake.skinId).body, isMe ? 1 : 0.8);
      g.fillCircle(px, py, isMe ? 3 : 2);
    }
  }

  private render(myRenderHead: Vec2 | null) {
    if (!this.world) return;
    const g = this.worldGfx;
    const view = this.cameras.main.worldView;
    const pad = 60;
    g.clear();

    g.lineStyle(4, 0xe05555, 1);
    g.strokeRect(0, 0, this.world.arena.width, this.world.arena.height);

    g.fillStyle(0xf2c14e, 1);
    for (const p of this.world.pellets.values()) {
      if (p.x < view.x - pad || p.x > view.right + pad || p.y < view.y - pad || p.y > view.bottom + pad)
        continue;
      g.fillCircle(p.x, p.y, this.config.pellets.radius);
    }

    const renderTime = this.clockSync.hasEstimate()
      ? this.clockSync.serverNow(performance.now()) - this.config.network.interpolationDelayMs
      : this.latestServerTime +
        (performance.now() - this.latestServerTimeAt) -
        this.config.network.interpolationDelayMs;
    for (const [id, interp] of this.interpolators) {
      if (id === this.world.playerId) continue;
      const snake = this.world.snakes.get(id);
      if (!snake) continue;
      const s = interp.sample(renderTime);
      if (!s || !s.alive) continue;
      this.drawSnake({ x: s.x, y: s.y }, snake.path, s.mass, s.boosting, snake.skinId, false);
    }

    const my = this.predictor.state;
    const myWorld = this.world.snakes.get(this.world.playerId);
    if (my && this.meAlive && myRenderHead && myWorld) {
      this.drawSnake(myRenderHead, my.path, my.mass, my.boosting, myWorld.skinId, true);
    }
  }

  private drawSnake(
    head: Vec2,
    path: { x: number; y: number }[],
    mass: number,
    boosting: boolean,
    skinId: number,
    isMe: boolean,
  ) {
    const g = this.worldGfx;
    const skin = skinOf(skinId);
    const points = sampleBodyPoints(
      head,
      path,
      bodyLengthForMass(this.config, mass),
      this.config.snake.segmentSpacing,
    );
    g.fillStyle(skin.body, 1);
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i]!;
      g.fillCircle(p.x, p.y, this.config.snake.bodyRadius);
    }
    if (this.data_.highContrast) {
      g.lineStyle(2, 0x111111, 1);
      for (let i = points.length - 1; i >= 0; i--) g.strokeCircle(points[i]!.x, points[i]!.y, this.config.snake.bodyRadius);
    }
    g.fillStyle(boosting ? skin.boost : skin.head, 1);
    g.fillCircle(head.x, head.y, this.config.snake.headRadius);
    if (isMe || this.data_.highContrast) {
      g.lineStyle(2, 0xffffff, 0.8);
      g.strokeCircle(head.x, head.y, this.config.snake.headRadius + 2);
    }
  }
}
