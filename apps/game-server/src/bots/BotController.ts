import {
  Rng,
  Simulation,
  bodyLengthForMass,
  pointSegmentDistanceSq,
  sampleBodyPoints,
  wrapAngle,
  type Vec2,
} from '@serpent/game-core';

/**
 * 서버 봇 (PRD §5.7).
 * - 제한된 가상 시야(viewRadius) 안의 펠릿/몸통만 본다 — 전체 상태 무제한 활용 금지.
 * - 진행 방향 전방의 충돌 예상(TTC 창)과 경계 근접으로 위험을 감지해 회피한다.
 * - 판단은 5~10Hz(호출 측 스케줄), 행동은 Simulation.setInput으로만 —
 *   이동/충돌 규칙은 인간 플레이어와 동일하게 서버 권위 시뮬레이션이 적용한다.
 */
export interface BotParams {
  /** 가상 시야 반경 (world units) */
  viewRadius: number;
  /** 전방 충돌 예상 창 (ms) — lookahead = speed × ttcWindow */
  ttcWindowMs: number;
  /** 경계 안전 여유 */
  boundaryMargin: number;
  /** 안전한 추적 중 부스트 확률 (판단 1회당) */
  boostChance: number;
  /** 회전 오차 (radians, ±) — 난이도 조절 */
  turnNoise: number;
}

export const defaultBotParams: BotParams = {
  viewRadius: 900,
  ttcWindowMs: 700,
  boundaryMargin: 80,
  boostChance: 0.08,
  turnNoise: 0.08,
};

/** 회피 후보 각도 오프셋 — 직진 선호, 점점 크게 꺾는다 */
const STEER_OFFSETS = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4, Math.PI];

export class BotController {
  constructor(
    private readonly sim: Simulation,
    readonly botId: string,
    private readonly rng: Rng,
    private readonly params: BotParams = defaultBotParams,
  ) {}

  /** 판단 1회 (5~10Hz로 호출) */
  decide(): void {
    const me = this.sim.snakes.get(this.botId);
    if (!me || !me.alive) return;

    // 시야 내 위험 지오메트리 수집: 다른 뱀의 머리/몸통 샘플
    const hazards = this.collectHazards(me.head);

    // 목표: 시야 내 최근접 펠릿 (없으면 현재 방향 유지)
    const target = this.nearestPellet(me.head);
    const desiredAngle = target
      ? Math.atan2(target.y - me.head.y, target.x - me.head.x)
      : me.angle;

    // 위험 회피: desired에서 시작해 안전한 최소 꺾임 방향 탐색
    const speed = this.sim.config.snake.baseSpeed;
    const lookahead = (speed * this.params.ttcWindowMs) / 1000;
    let chosen: number | null = null;
    for (const offset of STEER_OFFSETS) {
      const angle = wrapAngle(desiredAngle + offset);
      if (this.isDirectionSafe(me.head, angle, lookahead, hazards)) {
        chosen = angle;
        break;
      }
    }
    // 모든 방향이 위험하면 현재 각도의 반대편으로 최후 회피
    const finalAngle = chosen ?? wrapAngle(me.angle + Math.PI / 2);

    const noisy = finalAngle + this.rng.range(-this.params.turnNoise, this.params.turnNoise);
    const chasingSafely = chosen !== null && chosen === desiredAngle && target !== null;
    const boost =
      chasingSafely &&
      me.mass > this.sim.config.snake.minBoostMass * 2 &&
      this.rng.next() < this.params.boostChance;

    this.sim.setInput(this.botId, { dirX: Math.cos(noisy), dirY: Math.sin(noisy), boost });
  }

  /** 시야 내 다른 뱀의 몸통 샘플 + 머리 (제한 시야 — 밖은 보지 못한다) */
  private collectHazards(head: Vec2): Vec2[] {
    const out: Vec2[] = [];
    const view = this.params.viewRadius;
    for (const other of this.sim.snakes.values()) {
      if (other.id === this.botId || !other.alive) continue;
      if (Math.hypot(other.head.x - head.x, other.head.y - head.y) > view + 500) continue;
      out.push(other.head);
      const points = sampleBodyPoints(
        other.head,
        other.path,
        bodyLengthForMass(this.sim.config, other.mass),
        this.sim.config.snake.segmentSpacing,
      );
      for (const p of points) {
        if (Math.hypot(p.x - head.x, p.y - head.y) <= view) out.push(p);
      }
    }
    return out;
  }

  private nearestPellet(head: Vec2): Vec2 | null {
    let best: Vec2 | null = null;
    let bestDist = this.params.viewRadius;
    for (const p of this.sim.pellets.values()) {
      const d = Math.hypot(p.x - head.x, p.y - head.y);
      if (d < bestDist) {
        bestDist = d;
        best = { x: p.x, y: p.y };
      }
    }
    return best;
  }

  /** head→probe 선분이 경계 여유와 위험 지점들로부터 안전한가 (broad TTC 근사) */
  private isDirectionSafe(head: Vec2, angle: number, lookahead: number, hazards: Vec2[]): boolean {
    const { arena, snake } = this.sim.config;
    const probe: Vec2 = {
      x: head.x + Math.cos(angle) * lookahead,
      y: head.y + Math.sin(angle) * lookahead,
    };
    const m = this.params.boundaryMargin;
    if (probe.x < m || probe.y < m || probe.x > arena.width - m || probe.y > arena.height - m) {
      return false;
    }
    const clearance = snake.headRadius + snake.bodyRadius + 14;
    const clearanceSq = clearance * clearance;
    for (const h of hazards) {
      if (pointSegmentDistanceSq(h, head, probe) <= clearanceSq) return false;
    }
    return true;
  }
}
