import type { GameConfig } from '@serpent/config';
import {
  normalizeDirection,
  stepSnakeMovement,
  type MovementState,
  type Vec2,
} from '@serpent/game-core';
import type { PlayerSnapshot } from '@serpent/protocol';

export interface PendingInput {
  seq: number;
  dirX: number;
  dirY: number;
  boost: boolean;
}

/**
 * 내 뱀 예측기 (PRD §9.5, §9.8.4).
 * - 입력 즉시 로컬에서 이동을 적용한다 (서버와 동일한 stepSnakeMovement).
 * - snapshot 도착 시 서버 상태 위에 lastAckInputSeq 이후 미확인 입력을
 *   재적용한다 (reconciliation).
 * - 재적용으로 생긴 위치 점프는 renderOffset으로 흡수해 100~200ms 동안
 *   지수 감쇠시킨다 (급격한 순간이동 방지).
 */
export class Predictor {
  state: MovementState | null = null;
  private pending: PendingInput[] = [];
  private renderOffset: Vec2 = { x: 0, y: 0 };

  constructor(
    private readonly config: GameConfig,
    /** 보정 오프셋 반감기 (ms) — 100~200ms 완만 보정 */
    private readonly smoothingHalfLifeMs = 120,
  ) {}

  reset(server: PlayerSnapshot): void {
    this.state = toMovementState(server);
    this.pending = [];
    this.renderOffset = { x: 0, y: 0 };
  }

  /** 입력 1개 = 로컬 1틱 즉시 적용 + 보류 큐 적재 */
  applyInput(input: PendingInput): void {
    this.pending.push(input);
    if (!this.state) return;
    stepSnakeMovement(
      this.state,
      { dir: normalizeDirection({ x: input.dirX, y: input.dirY }), boost: input.boost },
      this.config,
      true,
    );
  }

  /** 서버 권위 상태 수신 → 미확인 입력 재적용 */
  reconcile(server: PlayerSnapshot, lastAckInputSeq: number): void {
    const prevRender = this.state
      ? { x: this.state.head.x + this.renderOffset.x, y: this.state.head.y + this.renderOffset.y }
      : null;

    this.pending = this.pending.filter((p) => p.seq > lastAckInputSeq);
    this.state = toMovementState(server);
    for (const p of this.pending) {
      stepSnakeMovement(
        this.state,
        { dir: normalizeDirection({ x: p.dirX, y: p.dirY }), boost: p.boost },
        this.config,
        true,
      );
    }

    // 보정 점프를 렌더 오프셋으로 흡수 (카메라/렌더 순간이동 방지)
    if (prevRender) {
      this.renderOffset = {
        x: prevRender.x - this.state.head.x,
        y: prevRender.y - this.state.head.y,
      };
      // 오차가 비정상적으로 크면(리스폰 등) 스냅
      const magnitude = Math.hypot(this.renderOffset.x, this.renderOffset.y);
      const snapThreshold = this.config.snake.baseBodyLength * 2;
      if (magnitude > snapThreshold) this.renderOffset = { x: 0, y: 0 };
    }
  }

  /** 렌더용 머리 위치 — 프레임마다 오프셋을 지수 감쇠 */
  renderHead(deltaMs: number): Vec2 | null {
    if (!this.state) return null;
    const decay = Math.pow(0.5, deltaMs / this.smoothingHalfLifeMs);
    this.renderOffset = { x: this.renderOffset.x * decay, y: this.renderOffset.y * decay };
    return {
      x: this.state.head.x + this.renderOffset.x,
      y: this.state.head.y + this.renderOffset.y,
    };
  }

  /** 현재 보정 오프셋 크기 (테스트/디버그용) */
  correctionDistance(): number {
    return Math.hypot(this.renderOffset.x, this.renderOffset.y);
  }

  pendingCount(): number {
    return this.pending.length;
  }
}

function toMovementState(server: PlayerSnapshot): MovementState {
  return {
    head: { x: server.x, y: server.y },
    angle: server.angle,
    mass: server.mass,
    boosting: server.boosting,
    path: server.path.map((p) => ({ x: p.x, y: p.y })),
  };
}
