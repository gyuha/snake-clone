import Phaser from 'phaser';
import { Client, type Room } from 'colyseus.js';
import { createGameConfig, type GameConfig } from '@serpent/config';
import { bodyLengthForMass, sampleBodyPoints, type Vec2 } from '@serpent/game-core';
import {
  MSG,
  type EventMessage,
  type ResultMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from '@serpent/protocol';
import { formatScore } from '../lib/formatScore';
import { RemoteInterpolator } from '../net/interpolation';
import { Predictor } from '../net/prediction';
import { applySnapshot, createWorldFromWelcome, type NetWorldState } from '../net/state';
import { resolveInputDirection, type InputDevice } from './input';

/**
 * 온라인 아레나 (M3).
 * - 내 뱀: 입력 즉시 로컬 예측 + 서버 ack 후 reconciliation (Predictor)
 * - 다른 뱀: interpolationDelayMs(100ms) 버퍼에서 스냅샷 보간, 누락 시 200ms 외삽 (RemoteInterpolator)
 * - 카메라: 예측 위치 감쇠 추적 (보정 시 순간이동 없음)
 */
export class OnlineScene extends Phaser.Scene {
  private config!: GameConfig;
  private room?: Room;
  private world?: NetWorldState;
  private predictor!: Predictor;
  private interpolators = new Map<string, RemoteInterpolator>();
  private latestServerTime = 0;
  private latestServerTimeAt = 0; // 수신 시각 (performance.now 기준)

  private seq = 0;
  private inputAccumulatorMs = 0;
  private lastDevice: InputDevice = 'pointer';
  private meAlive = false;

  private worldGfx!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private hudTimerMs = 0;
  private deathOverlay?: Phaser.GameObjects.Container;

  private keys!: Record<
    'w' | 'a' | 's' | 'd' | 'up' | 'down' | 'left' | 'right' | 'space',
    Phaser.Input.Keyboard.Key
  >;

  constructor() {
    super('online');
  }

  create() {
    this.config = createGameConfig();
    this.predictor = new Predictor(this.config);
    this.worldGfx = this.add.graphics();
    this.hudText = this.add
      .text(12, 10, '', { fontFamily: 'monospace', fontSize: '16px', color: '#d8e6dd' })
      .setScrollFactor(0)
      .setDepth(10);
    this.statusText = this.add
      .text(12, 34, '서버 접속 중...', { fontFamily: 'monospace', fontSize: '14px', color: '#8aa0b8' })
      .setScrollFactor(0)
      .setDepth(10);

    const kb = this.input.keyboard!;
    const K = Phaser.Input.Keyboard.KeyCodes;
    this.keys = {
      w: kb.addKey(K.W), a: kb.addKey(K.A), s: kb.addKey(K.S), d: kb.addKey(K.D),
      up: kb.addKey(K.UP), down: kb.addKey(K.DOWN), left: kb.addKey(K.LEFT), right: kb.addKey(K.RIGHT),
      space: kb.addKey(K.SPACE),
    };

    void this.connect();
  }

  private async connect() {
    const params = new URLSearchParams(window.location.search);
    const endpoint = params.get('server') ?? 'ws://localhost:2567';
    try {
      const client = new Client(endpoint);
      const room = await client.joinOrCreate('arena');
      this.room = room;

      room.onMessage(MSG.welcome, (welcome: WelcomeMessage) => {
        if (welcome.configVersion !== this.config.version) {
          this.statusText.setText(`설정 버전 불일치 (server ${welcome.configVersion}) — 새로고침 필요`);
          return; // §6.1: configVersion 불일치 시 입장 차단
        }
        this.world = createWorldFromWelcome(welcome, this.config);
        this.interpolators.clear();
        this.latestServerTime = welcome.serverTime;
        this.latestServerTimeAt = performance.now();
        this.statusText.setText(`room ${welcome.roomId}`);
        this.clearDeathOverlay();

        const me = this.world.snakes.get(this.world.playerId);
        if (me) {
          this.meAlive = me.alive;
          this.predictor.reset(me);
          const cam = this.cameras.main;
          cam.setBounds(0, 0, welcome.arena.width, welcome.arena.height);
          cam.centerOn(me.x, me.y);
        }
      });

      room.onMessage(MSG.snapshot, (snap: SnapshotMessage) => this.onSnapshot(snap));

      room.onMessage(MSG.event, (event: EventMessage) => {
        if (event.type === 'death' && event.snakeId === this.world?.playerId) {
          this.meAlive = false;
          this.showDeathOverlay(null);
        }
      });

      room.onMessage(MSG.result, (result: ResultMessage) => {
        this.showDeathOverlay(result);
      });

      room.onLeave(() => {
        this.statusText.setText('연결 종료 — 새로고침으로 재접속');
      });
    } catch (err) {
      this.statusText.setText(`접속 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onSnapshot(snap: SnapshotMessage) {
    if (!this.world) return;
    if (snap.tickId < this.world.tickId) return;
    applySnapshot(this.world, snap, this.config);
    this.latestServerTime = snap.serverTime;
    this.latestServerTimeAt = performance.now();

    const me = this.world.snakes.get(this.world.playerId);
    if (me) {
      this.meAlive = me.alive;
      if (me.alive) this.predictor.reconcile(me, snap.lastAckInputSeq);
    }

    // 원격 뱀 보간 버퍼 갱신 (몸통 경로는 world의 델타 누적본을 사용)
    for (const [id, s] of this.world.snakes) {
      if (id === this.world.playerId) continue;
      let interp = this.interpolators.get(id);
      if (!interp) {
        interp = new RemoteInterpolator(this.config.network.maxExtrapolationMs);
        this.interpolators.set(id, interp);
      }
      interp.push({
        time: snap.serverTime,
        x: s.x,
        y: s.y,
        angle: s.angle,
        mass: s.mass,
        boosting: s.boosting,
        alive: s.alive,
        path: [],
      });
    }
    for (const id of this.interpolators.keys()) {
      if (!this.world.snakes.has(id)) this.interpolators.delete(id); // aoi_leave
    }
  }

  update(_time: number, deltaMs: number) {
    if (!this.world || !this.room) return;

    // 입력은 고정 20Hz 틱으로 전송 + 같은 값으로 즉시 로컬 예측 (PRD §9.8.4)
    const stepMs = this.config.simulation.fixedDeltaMs;
    this.inputAccumulatorMs += Math.min(deltaMs, 250);
    while (this.inputAccumulatorMs >= stepMs) {
      this.inputAccumulatorMs -= stepMs;
      if (this.meAlive && this.predictor.state) this.inputTick();
    }

    // 카메라: 예측 렌더 위치 추적
    const renderHead = this.predictor.renderHead(deltaMs);
    if (renderHead && this.meAlive) {
      const cam = this.cameras.main;
      const target = cam.getScroll(renderHead.x, renderHead.y);
      cam.setScroll(
        Phaser.Math.Linear(cam.scrollX, target.x, 0.15),
        Phaser.Math.Linear(cam.scrollY, target.y, 0.15),
      );
    }

    this.render(renderHead);

    this.hudTimerMs += deltaMs;
    if (this.hudTimerMs >= 250) {
      this.hudTimerMs = 0;
      const me = this.world.snakes.get(this.world.playerId);
      if (me) {
        const length = Math.round(bodyLengthForMass(this.config, me.mass));
        this.hudText.setText(
          `score ${formatScore(me.score)}   length ${length}   tick ${this.world.tickId}`,
        );
      }
    }
  }

  private inputTick() {
    const state = this.predictor.state!;
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
    const dir = resolved.dir ?? { x: Math.cos(state.angle), y: Math.sin(state.angle) };
    const boost = this.keys.space.isDown || this.input.activePointer.isDown;

    const input = { seq: ++this.seq, dirX: dir.x, dirY: dir.y, boost };
    this.room!.send(MSG.input, input);
    this.predictor.applyInput(input); // 즉시 로컬 반영
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

    // 원격 뱀: 보간 버퍼에서 renderTime 상태를 샘플 (약 100ms 과거 — PRD §9.8.4)
    const sinceLast = performance.now() - this.latestServerTimeAt;
    const renderTime = this.latestServerTime + sinceLast - this.config.network.interpolationDelayMs;
    for (const [id, interp] of this.interpolators) {
      if (id === this.world.playerId) continue;
      const snake = this.world.snakes.get(id);
      if (!snake) continue;
      const s = interp.sample(renderTime);
      if (!s || !s.alive) continue;
      this.drawSnake({ x: s.x, y: s.y }, snake.path, snake.mass, s.boosting, false);
    }

    // 내 뱀: 예측 상태 (renderHead는 보정 오프셋 적용됨)
    const my = this.predictor.state;
    if (my && this.meAlive && myRenderHead) {
      this.drawSnake(myRenderHead, my.path, my.mass, my.boosting, true);
    }
  }

  private drawSnake(head: Vec2, path: { x: number; y: number }[], mass: number, boosting: boolean, isMe: boolean) {
    const g = this.worldGfx;
    const points = sampleBodyPoints(
      head,
      path,
      bodyLengthForMass(this.config, mass),
      this.config.snake.segmentSpacing,
    );
    g.fillStyle(isMe ? 0x4ea56f : 0x5a7fd6, 1);
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i]!;
      g.fillCircle(p.x, p.y, this.config.snake.bodyRadius);
    }
    g.fillStyle(boosting ? 0x9be27f : isMe ? 0x6fd79a : 0x7fa2e8, 1);
    g.fillCircle(head.x, head.y, this.config.snake.headRadius);
  }

  private showDeathOverlay(result: ResultMessage | null) {
    if (this.deathOverlay) return;
    const { width, height } = this.scale;
    const bg = this.add.rectangle(0, 0, width * 2, height * 2, 0x000000, 0.6);
    const lines = result
      ? `사망! (${result.reason})\n순위 ${result.rank} · 점수 ${formatScore(result.score)} · 킬 ${result.kills}\n\n클릭으로 리스폰`
      : '사망!\n\n클릭으로 리스폰';
    const text = this.add
      .text(0, 0, lines, { fontFamily: 'monospace', fontSize: '24px', color: '#ffffff', align: 'center' })
      .setOrigin(0.5);
    this.deathOverlay = this.add.container(width / 2, height / 2, [bg, text]).setScrollFactor(0).setDepth(20);
    this.input.once('pointerdown', () => {
      this.room?.send(MSG.respawn, {});
      this.clearDeathOverlay();
    });
  }

  private clearDeathOverlay() {
    this.deathOverlay?.destroy();
    this.deathOverlay = undefined;
  }
}