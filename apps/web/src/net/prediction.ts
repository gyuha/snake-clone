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
  /** 입력 이력 — 각 입력이 적용된 로컬 틱 번호와 함께 보관 */
  private history: { input: PendingInput; localTick: number }[] = [];
  /** 클라이언트 예측 틱 카운터 — welcome.tickId에서 시작, 입력 1개 = 1틱 */
  private localTick = 0;
  private renderOffset: Vec2 = { x: 0, y: 0 };
  /** 직전 틱의 머리 위치 — 서브틱 렌더 보간 기준 (틱 사이 머리 튐 방지) */
  private prevHead: Vec2 = { x: 0, y: 0 };
  /** 마지막 reconcile의 틱 드리프트 (localTick − serverTick) — 씬의 페이스 보정용 */
  lastDriftTicks = 0;

  constructor(
    private readonly config: GameConfig,
    /** 보정 오프셋 반감기 (ms) — 100~200ms 완만 보정 */
    private readonly smoothingHalfLifeMs = 120,
  ) {}

  reset(server: PlayerSnapshot, serverTickId = 0): void {
    this.state = toMovementState(server);
    this.history = [];
    this.localTick = serverTickId;
    this.renderOffset = { x: 0, y: 0 };
    this.prevHead = { ...this.state.head };
  }

  /** 입력 1개 = 로컬 1틱 즉시 적용 + 이력 적재 */
  applyInput(input: PendingInput): void {
    this.localTick++;
    this.history.push({ input, localTick: this.localTick });
    if (this.history.length > 256) this.history.shift();
    if (!this.state) return;
    this.prevHead = { ...this.state.head };
    stepSnakeMovement(
      this.state,
      { dir: normalizeDirection({ x: input.dirX, y: input.dirY }), boost: input.boost },
      this.config,
      true,
    );
  }

  /**
   * 서버 권위 상태 수신 → 틱 정렬 재적용 (reconciliation).
   * 서버는 벽시계 틱마다 항상 전진하므로, "보류 입력 개수"가 아니라
   * 스냅샷의 serverTickId와 로컬 틱 카운터의 차이만큼 재적용해야
   * 틱 수가 항상 일치한다 (지터/손실은 방향 오차만 남긴다).
   */
  reconcile(server: PlayerSnapshot, serverTickId: number): void {
    const prevRender = this.state
      ? { x: this.state.head.x + this.renderOffset.x, y: this.state.head.y + this.renderOffset.y }
      : null;

    // 서버 틱에 이미 반영된(그 이전의) 입력 이력 폐기
    this.history = this.history.filter((h) => h.localTick > serverTickId);

    // 틱 드리프트 방어: 이력과 틱 차이가 크게 어긋나면 재정렬
    const needed = this.localTick - serverTickId;
    this.lastDriftTicks = needed;
    if (needed < 0 || needed - this.history.length > 8) {
      this.localTick = serverTickId + this.history.length;
    }

    this.state = toMovementState(server);
    let replayPrev = { ...this.state.head };
    for (const h of this.history) {
      replayPrev = { ...this.state.head };
      stepSnakeMovement(
        this.state,
        { dir: normalizeDirection({ x: h.input.dirX, y: h.input.dirY }), boost: h.input.boost },
        this.config,
        true,
      );
    }
    // 보간 기준을 재적용 경로의 마지막 직전 위치로 갱신 (렌더 연속성 유지)
    this.prevHead = this.history.length > 0 ? replayPrev : { ...this.state.head };

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

  /**
   * 렌더용 머리 위치.
   * - alpha(0~1) = 다음 입력 틱까지의 진행률 — prevHead→head를 서브틱 보간해
   *   20Hz 틱 스텝핑이 프레임 단위 점프로 보이지 않게 한다.
   * - 보정 오프셋은 프레임마다 지수 감쇠.
   */
  renderHead(deltaMs: number, alpha = 1): Vec2 | null {
    if (!this.state) return null;
    const decay = Math.pow(0.5, deltaMs / this.smoothingHalfLifeMs);
    this.renderOffset = { x: this.renderOffset.x * decay, y: this.renderOffset.y * decay };
    const t = Math.max(0, Math.min(1, alpha));
    return {
      x: this.prevHead.x + (this.state.head.x - this.prevHead.x) * t + this.renderOffset.x,
      y: this.prevHead.y + (this.state.head.y - this.prevHead.y) * t + this.renderOffset.y,
    };
  }

  /** 현재 보정 오프셋 크기 (테스트/디버그용) */
  correctionDistance(): number {
    return Math.hypot(this.renderOffset.x, this.renderOffset.y);
  }

  pendingCount(): number {
    return this.history.length;
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
