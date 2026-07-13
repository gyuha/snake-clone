import Phaser from 'phaser';
import { createGameConfig, type GameConfig } from '@serpent/config';
import {
  Simulation,
  bodyLengthForMass,
  sampleBodyPoints,
  type Vec2,
} from '@serpent/game-core';
import { formatScore } from '../lib/formatScore';
import { resolveInputDirection, type InputDevice } from './input';

const PLAYER_ID = 'player';

/**
 * 오프라인 아레나 (M1). game-core 시뮬레이션을 로컬에서 고정 틱으로 구동하고
 * Phaser는 렌더링/입력/카메라만 담당한다 (PRD §10.1 경계).
 */
export class ArenaScene extends Phaser.Scene {
  private config!: GameConfig;
  private sim!: Simulation;
  private accumulatorMs = 0;
  private lastDevice: InputDevice = 'pointer';

  private worldGfx!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private hudTimerMs = 0;
  private deathOverlay?: Phaser.GameObjects.Container;

  private keys!: {
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    space: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super('arena');
  }

  create() {
    this.config = createGameConfig();
    // 오프라인 플레이 seed — game-core 밖이므로 비결정 소스 허용
    this.sim = new Simulation(this.config, (Date.now() & 0xffffffff) >>> 0);
    this.sim.seedPellets();
    this.sim.addSnake(PLAYER_ID);
    this.accumulatorMs = 0;
    this.lastDevice = 'pointer';
    this.deathOverlay = undefined;

    const kb = this.input.keyboard!;
    this.keys = {
      w: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      a: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      s: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      d: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      space: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };

    this.worldGfx = this.add.graphics();
    this.hudText = this.add
      .text(12, 10, '', { fontFamily: 'monospace', fontSize: '16px', color: '#d8e6dd' })
      .setScrollFactor(0)
      .setDepth(10);

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.config.arena.width, this.config.arena.height);
    const player = this.sim.snakes.get(PLAYER_ID)!;
    cam.centerOn(player.head.x, player.head.y);
  }

  update(_time: number, deltaMs: number) {
    const player = this.sim.snakes.get(PLAYER_ID);
    if (!player) return;

    // 고정 틱 시뮬레이션 (렌더 프레임과 분리 — PRD §8.3 Fixed timestep)
    this.accumulatorMs += Math.min(deltaMs, 250);
    const stepMs = this.config.simulation.fixedDeltaMs;
    while (this.accumulatorMs >= stepMs) {
      this.accumulatorMs -= stepMs;
      if (player.alive) {
        this.applyInput(player.head);
        const events = this.sim.step();
        if (events.deaths.some((d) => d.snakeId === PLAYER_ID)) {
          this.showDeathOverlay();
        }
      }
    }

    this.followCamera(player.head);
    this.render();

    // HUD는 4Hz 이하 갱신 (PRD §7.2)
    this.hudTimerMs += deltaMs;
    if (this.hudTimerMs >= 250) {
      this.hudTimerMs = 0;
      const length = Math.round(bodyLengthForMass(this.config, player.mass));
      this.hudText.setText(
        `score ${formatScore(player.score)}   length ${length}   ${player.boosting ? 'BOOST' : ''}`,
      );
    }
  }

  private applyInput(head: Vec2) {
    const pointer = this.input.activePointer;
    const pointerWorld = pointer
      ? this.cameras.main.getWorldPoint(pointer.x, pointer.y)
      : null;
    const resolved = resolveInputDirection({
      keys: {
        up: this.keys.w.isDown || this.keys.up.isDown,
        down: this.keys.s.isDown || this.keys.down.isDown,
        left: this.keys.a.isDown || this.keys.left.isDown,
        right: this.keys.d.isDown || this.keys.right.isDown,
      },
      pointerWorld: pointerWorld ? { x: pointerWorld.x, y: pointerWorld.y } : null,
      head,
      lastDevice: this.lastDevice,
    });
    this.lastDevice = resolved.device;
    const boost = this.keys.space.isDown || this.input.activePointer.isDown;
    if (resolved.dir) {
      this.sim.setInput(PLAYER_ID, { dirX: resolved.dir.x, dirY: resolved.dir.y, boost });
    } else {
      const player = this.sim.snakes.get(PLAYER_ID)!;
      this.sim.setInput(PLAYER_ID, {
        dirX: Math.cos(player.angle),
        dirY: Math.sin(player.angle),
        boost,
      });
    }
  }

  private followCamera(head: Vec2) {
    const cam = this.cameras.main;
    const target = cam.getScroll(head.x, head.y);
    cam.setScroll(
      Phaser.Math.Linear(cam.scrollX, target.x, 0.12),
      Phaser.Math.Linear(cam.scrollY, target.y, 0.12),
    );
  }

  private render() {
    const g = this.worldGfx;
    const cam = this.cameras.main;
    const view = cam.worldView;
    const pad = 60;
    g.clear();

    // 아레나 경계
    g.lineStyle(4, 0xe05555, 1);
    g.strokeRect(0, 0, this.config.arena.width, this.config.arena.height);

    // 화면 안 펠릿만 렌더 (PRD §10.2)
    g.fillStyle(0xf2c14e, 1);
    for (const p of this.sim.pellets.values()) {
      if (
        p.x < view.x - pad || p.x > view.right + pad ||
        p.y < view.y - pad || p.y > view.bottom + pad
      ) continue;
      g.fillCircle(p.x, p.y, this.config.pellets.radius);
    }

    // 스네이크 렌더
    for (const s of this.sim.snakes.values()) {
      if (!s.alive) continue;
      const points = sampleBodyPoints(
        s.head,
        s.path,
        bodyLengthForMass(this.config, s.mass),
        this.config.snake.segmentSpacing,
      );
      const isPlayer = s.id === PLAYER_ID;
      g.fillStyle(isPlayer ? 0x4ea56f : 0x5a7fd6, 1);
      for (let i = points.length - 1; i >= 0; i--) {
        const p = points[i]!;
        g.fillCircle(p.x, p.y, this.config.snake.bodyRadius);
      }
      // 머리 (부스트 시 강조)
      g.fillStyle(s.boosting ? 0x9be27f : isPlayer ? 0x6fd79a : 0x7fa2e8, 1);
      g.fillCircle(s.head.x, s.head.y, this.config.snake.headRadius);
    }
  }

  private showDeathOverlay() {
    const player = this.sim.snakes.get(PLAYER_ID)!;
    const { width, height } = this.scale;
    const bg = this.add.rectangle(0, 0, width * 2, height * 2, 0x000000, 0.6);
    const text = this.add
      .text(
        0,
        0,
        `사망!\n점수 ${formatScore(player.score)}\n\n클릭 또는 R 키로 다시 시작`,
        { fontFamily: 'monospace', fontSize: '24px', color: '#ffffff', align: 'center' },
      )
      .setOrigin(0.5);
    this.deathOverlay = this.add
      .container(width / 2, height / 2, [bg, text])
      .setScrollFactor(0)
      .setDepth(20);

    this.input.once('pointerdown', () => this.scene.restart());
    this.input.keyboard!.once('keydown-R', () => this.scene.restart());
  }
}
