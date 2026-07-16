import Phaser from 'phaser';
import { Client, type Room } from 'colyseus.js';
import { createGameConfig, type GameConfig } from '@serpent/config';
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
import { ClockSync } from '../net/clock';
import { RemoteInterpolator } from '../net/interpolation';
import { Predictor } from '../net/prediction';
import { applySnapshot, createWorldFromWelcome, type NetWorldState } from '../net/state';
import type { GameBridge } from './bridge';
import { isTouchDevice, joystickVector } from './joystick';
import { resolveInputDirection, type InputDevice } from './input';

export interface OnlineStartData {
  endpoint: string;
  joinToken?: string;
  nickname: string;
  skinId: number;
  bridge: GameBridge;
}

/**
 * 온라인 아레나 (제품 플로우).
 * Phaser는 렌더/입력/예측/보간만, 리더보드·결과·HUD 표시는 브리지로 React에 넘긴다 (PRD §10.1).
 */
export class OnlineScene extends Phaser.Scene {
  private data_!: OnlineStartData;
  private config!: GameConfig;
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

  private seq = 0;
  private inputAccumulatorMs = 0;
  private lastDevice: InputDevice = 'pointer';
  private meAlive = false;
  private kills = 0;
  private hudTimerMs = 0;

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
    this.config = createGameConfig();
    this.predictor = new Predictor(this.config);
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

    this.data_.bridge.requestRespawn = () => {
      this.room?.send(MSG.respawn, {});
      this.data_.bridge.onResult(null);
    };
    this.data_.bridge.leaveGame = () => {
      void this.room?.leave();
    };

    void this.connect();
  }

  private async connect() {
    const bridge = this.data_.bridge;
    bridge.onStatus('서버 접속 중...');
    try {
      const client = new Client(this.data_.endpoint);
      const room = await client.joinOrCreate('arena', {
        joinToken: this.data_.joinToken,
        nickname: this.data_.nickname,
        skinId: this.data_.skinId,
      });
      this.room = room;

      room.onMessage(MSG.welcome, (welcome: WelcomeMessage) => {
        if (welcome.configVersion !== this.config.version) {
          bridge.onStatus(`설정 버전 불일치 (server ${welcome.configVersion}) — 새로고침 필요`);
          return; // §6.1: configVersion 불일치 시 입장 차단
        }
        this.world = createWorldFromWelcome(welcome, this.config);
        this.interpolators.clear();
        this.latestServerTime = welcome.serverTime;
        this.latestServerTimeAt = performance.now();
        this.lastSnapshotTickId = welcome.tickId;
        this.snapshotStep = Math.max(1, Math.round(welcome.tickRate / welcome.snapshotRate));
        bridge.onStatus('');

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
        if (event.type !== 'death') return;
        if (event.snakeId === this.world?.playerId) {
          this.meAlive = false;
        } else if (event.killerId === this.world?.playerId) {
          this.kills++;
        }
      });

      room.onMessage(MSG.result, (result: ResultMessage) => {
        bridge.onResult(result);
      });

      room.onLeave(() => {
        bridge.onStatus('연결 종료 — 재접속하려면 새로고침');
      });
    } catch (err) {
      bridge.onStatus(`접속 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      this.room.send(MSG.ping, this.clockSync.createPing(performance.now()));
    }

    const stepMs = this.config.simulation.fixedDeltaMs;
    this.inputAccumulatorMs += Math.min(deltaMs, 250);
    // 틱 드리프트 페이스 보정: 로컬 틱이 서버보다 뒤지면(≤0) 약간 서두르고,
    // 너무 앞서면(>4) 약간 늦춰 재앵커 스냅(러버밴딩)을 예방한다.
    if (this.predictor.lastDriftTicks <= 0) this.inputAccumulatorMs += deltaMs * 0.1;
    else if (this.predictor.lastDriftTicks > 4) this.inputAccumulatorMs -= deltaMs * 0.1;
    while (this.inputAccumulatorMs >= stepMs) {
      this.inputAccumulatorMs -= stepMs;
      if (this.meAlive && this.predictor.state) this.inputTick();
    }

    // 서브틱 보간: 다음 입력 틱까지의 진행률로 prevHead→head를 보간 (머리 튐 방지)
    const alpha = this.inputAccumulatorMs / stepMs;
    const renderHead = this.predictor.renderHead(deltaMs, alpha);
    if (renderHead && this.meAlive) {
      const cam = this.cameras.main;
      const target = cam.getScroll(renderHead.x, renderHead.y);
      cam.setScroll(
        Phaser.Math.Linear(cam.scrollX, target.x, 0.15),
        Phaser.Math.Linear(cam.scrollY, target.y, 0.15),
      );
    }

    this.render(renderHead);
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

    const finalDir = dir ?? { x: Math.cos(state.angle), y: Math.sin(state.angle) };
    const input = { seq: ++this.seq, dirX: finalDir.x, dirY: finalDir.y, boost };
    this.room!.send(MSG.input, input);
    this.predictor.applyInput(input);
  }

  // ── 모바일 가상 조이스틱 (PRD §7.3: 왼쪽 조이스틱 + 오른쪽 부스트) ──────
  private setupTouchControls() {
    const boostZone = () => ({
      x: this.scale.width - 90,
      y: this.scale.height - 90,
      r: 52, // ≥ 44 CSS px (§7.4)
    });

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const b = boostZone();
      if (Math.hypot(p.x - b.x, p.y - b.y) <= b.r) {
        this.boostPointerId = p.id;
        return;
      }
      if (p.x < this.scale.width / 2 && this.joyPointerId === null) {
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
    if (!this.touchMode) return;
    // 부스트 버튼
    const bx = this.scale.width - 90;
    const by = this.scale.height - 90;
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
    g.fillStyle(boosting ? skin.boost : skin.head, 1);
    g.fillCircle(head.x, head.y, this.config.snake.headRadius);
    if (isMe) {
      g.lineStyle(2, 0xffffff, 0.8);
      g.strokeCircle(head.x, head.y, this.config.snake.headRadius + 2);
    }
  }
}
