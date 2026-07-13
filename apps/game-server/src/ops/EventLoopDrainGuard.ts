export interface EventLoopHealth {
  eventLoopLagP99Ms: number;
  draining: boolean;
  alert?: { severity: 'P1'; code: 'event_loop_lag'; message: string };
}

export interface EventLoopDrainGuardOptions {
  thresholdMs?: number;
  sustainMs?: number;
  now?: () => number;
}

/**
 * 프로세스 전체의 event-loop 지연은 특정 Room 하나만의 문제가 아니므로, 지속되면
 * 새 Room 배정을 멈추도록 별도로 판단한다. 단발성 GC spike로 드레인하지 않기 위해
 * 일정 기간 연속 초과를 요구한다.
 */
export class EventLoopDrainGuard {
  private readonly thresholdMs: number;
  private readonly sustainMs: number;
  private readonly now: () => number;
  private overThresholdSince?: number;
  private drained = false;

  constructor(options: EventLoopDrainGuardOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? 80;
    this.sustainMs = options.sustainMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  observe(eventLoopLagP99Ms: number): EventLoopHealth {
    const lag = Number.isFinite(eventLoopLagP99Ms) ? Math.max(0, eventLoopLagP99Ms) : 0;
    if (lag <= this.thresholdMs) {
      this.overThresholdSince = undefined;
      return { eventLoopLagP99Ms: lag, draining: this.drained };
    }

    this.overThresholdSince ??= this.now();
    if (this.now() - this.overThresholdSince >= this.sustainMs) this.drained = true;
    return {
      eventLoopLagP99Ms: lag,
      draining: this.drained,
      alert: {
        severity: 'P1',
        code: 'event_loop_lag',
        message: `event loop P99 ${lag.toFixed(1)}ms exceeds ${this.thresholdMs}ms${this.drained ? '; instance draining' : ''}`,
      },
    };
  }
}
