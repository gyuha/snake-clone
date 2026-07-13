export interface RoomMetrics {
  roomId: string;
  configVersion: string;
  humans: number;
  bots: number;
  tickLastMs: number;
  tickP95Ms: number;
  tickP99Ms: number;
  averageRttMs: number | null;
  rttP95Ms: number | null;
  /** 최근 snapshot의 JSON payload 크기. wire framing/compression 전의 보수적 기준값. */
  snapshotP95Bytes: number;
  /** 사용자별 관심 영역에 실제 포함된 snake + pellet 수의 P95. */
  aoiEntitiesP95: number;
  /** 최근 1초간 Room에서 전송한 snapshot payload 합계. */
  outboundBytesPerSecond: number;
  errorCount: number;
  errorRate: number;
  draining: boolean;
}

/** 운영자가 즉시 조치할 수 있는, 현재 활성화된 경보만 노출한다. */
export interface OpsAlert {
  severity: 'P1' | 'P2' | 'P3';
  code: 'tick_budget_exceeded' | 'high_rtt' | 'snapshot_budget_exceeded' | 'high_error_rate' | 'result_backlog';
  roomId?: string;
  message: string;
}

interface Sample {
  configVersion: string;
  ticks: number[];
  rtts: Map<string, number>;
  snapshotBytes: number[];
  aoiEntities: number[];
  outbound: { at: number; bytes: number }[];
  humans: number;
  bots: number;
  errorCount: number;
  tickCount: number;
  draining: boolean;
  drain?: () => Promise<void>;
  overTickBudgetSince?: number;
  tickAlertSince?: number;
}

export interface RoomMetricsOptions {
  tickDrainP99Ms?: number;
  tickDrainSustainMs?: number;
  now?: () => number;
  tickAlertP99Ms?: number;
  tickAlertSustainMs?: number;
  rttAlertP95Ms?: number;
  errorRateAlert?: number;
  snapshotAlertP95Bytes?: number;
  resultBacklog?: () => number;
  resultBacklogAlert?: number;
}

/** Room별 관측 데이터. 최근 표본만 보존해 운영 조회가 게임 메모리를 잠식하지 않는다. */
export class RoomMetricsRegistry {
  private readonly rooms = new Map<string, Sample>();
  private readonly tickDrainP99Ms: number;
  private readonly tickDrainSustainMs: number;
  private readonly now: () => number;
  private readonly tickAlertP99Ms: number;
  private readonly tickAlertSustainMs: number;
  private readonly rttAlertP95Ms: number;
  private readonly errorRateAlert: number;
  private readonly snapshotAlertP95Bytes: number;
  private readonly resultBacklog?: () => number;
  private readonly resultBacklogAlert: number;

  constructor(options: RoomMetricsOptions = {}) {
    this.tickDrainP99Ms = options.tickDrainP99Ms ?? 80;
    this.tickDrainSustainMs = options.tickDrainSustainMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.tickAlertP99Ms = options.tickAlertP99Ms ?? 45;
    this.tickAlertSustainMs = options.tickAlertSustainMs ?? 5 * 60_000;
    this.rttAlertP95Ms = options.rttAlertP95Ms ?? 200;
    this.errorRateAlert = options.errorRateAlert ?? 0.05;
    this.snapshotAlertP95Bytes = options.snapshotAlertP95Bytes ?? 4 * 1024;
    this.resultBacklog = options.resultBacklog;
    this.resultBacklogAlert = options.resultBacklogAlert ?? 100;
  }

  register(roomId: string, configVersion: string, drain?: () => Promise<void>): void {
    this.rooms.set(roomId, {
      configVersion, ticks: [], rtts: new Map(), snapshotBytes: [], aoiEntities: [], outbound: [],
      humans: 0, bots: 0, errorCount: 0, tickCount: 0,
      draining: false, drain,
    });
  }

  unregister(roomId: string): void {
    this.rooms.delete(roomId);
  }

  observeTick(roomId: string, durationMs: number, humans: number, bots: number): void {
    const sample = this.rooms.get(roomId);
    if (!sample || !Number.isFinite(durationMs)) return;
    sample.ticks.push(durationMs);
    sample.tickCount++;
    if (sample.ticks.length > 240) sample.ticks.shift();
    sample.humans = humans;
    sample.bots = bots;
    const p99 = percentile(sample.ticks, 0.99);
    if (p99 > this.tickDrainP99Ms) {
      sample.overTickBudgetSince ??= this.now();
      if (this.now() - sample.overTickBudgetSince >= this.tickDrainSustainMs) void this.drain(roomId);
    } else {
      sample.overTickBudgetSince = undefined;
    }
    if (p99 > this.tickAlertP99Ms) sample.tickAlertSince ??= this.now();
    else sample.tickAlertSince = undefined;
  }

  reportRtt(roomId: string, sessionId: string, rttMs: number): void {
    const sample = this.rooms.get(roomId);
    if (!sample || !Number.isFinite(rttMs) || rttMs < 0 || rttMs > 10_000) return;
    sample.rtts.set(sessionId, rttMs);
  }

  removeClient(roomId: string, sessionId: string): void {
    this.rooms.get(roomId)?.rtts.delete(sessionId);
  }

  /** AOI 전송 직전 관측. 게임 판정과 분리되어 네트워크 예산만 추적한다. */
  observeSnapshot(roomId: string, bytes: number, entitiesInAoi: number): void {
    const sample = this.rooms.get(roomId);
    if (!sample || !Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(entitiesInAoi) || entitiesInAoi < 0) return;
    const now = this.now();
    sample.snapshotBytes.push(bytes);
    sample.aoiEntities.push(entitiesInAoi);
    if (sample.snapshotBytes.length > 240) sample.snapshotBytes.shift();
    if (sample.aoiEntities.length > 240) sample.aoiEntities.shift();
    sample.outbound.push({ at: now, bytes });
    while (sample.outbound.length > 0 && sample.outbound[0]!.at < now - 10_000) sample.outbound.shift();
  }

  recordError(roomId: string): void {
    const sample = this.rooms.get(roomId);
    if (sample) sample.errorCount++;
  }

  /** 새 매치를 닫고 진행 중 사용자는 Room이 자연 종료할 때까지 유지한다. */
  async drain(roomId: string): Promise<boolean> {
    const sample = this.rooms.get(roomId);
    if (!sample) return false;
    if (!sample.draining) {
      await sample.drain?.();
      sample.draining = true;
    }
    return true;
  }

  async drainAll(): Promise<number> {
    const ids = [...this.rooms.keys()];
    await Promise.all(ids.map((roomId) => this.drain(roomId)));
    return ids.length;
  }

  snapshot(): { activeRooms: number; humans: number; bots: number; rooms: RoomMetrics[]; alerts: OpsAlert[] } {
    const now = this.now();
    const roomEntries = [...this.rooms.entries()].map(([roomId, sample]) => ({ roomId, sample, metrics: this.toMetrics(roomId, sample) }));
    const rooms = roomEntries.map((entry) => entry.metrics);
    const alerts: OpsAlert[] = [];
    for (const { roomId, sample, metrics } of roomEntries) {
      if (sample.tickAlertSince !== undefined && now - sample.tickAlertSince >= this.tickAlertSustainMs) alerts.push({ severity: 'P1', code: 'tick_budget_exceeded', roomId, message: `tick P99 ${metrics.tickP99Ms.toFixed(1)}ms exceeds ${this.tickAlertP99Ms}ms` });
      if (metrics.rttP95Ms !== null && metrics.rttP95Ms > this.rttAlertP95Ms) alerts.push({ severity: 'P2', code: 'high_rtt', roomId, message: `RTT P95 ${metrics.rttP95Ms.toFixed(0)}ms exceeds ${this.rttAlertP95Ms}ms` });
      if (metrics.snapshotP95Bytes > this.snapshotAlertP95Bytes) alerts.push({ severity: 'P2', code: 'snapshot_budget_exceeded', roomId, message: `snapshot P95 ${metrics.snapshotP95Bytes}B exceeds ${this.snapshotAlertP95Bytes}B` });
      if (sample.tickCount >= 20 && metrics.errorRate > this.errorRateAlert) alerts.push({ severity: 'P3', code: 'high_error_rate', roomId, message: `error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds ${(this.errorRateAlert * 100).toFixed(1)}%` });
    }
    const backlog = this.resultBacklog?.() ?? 0;
    if (backlog >= this.resultBacklogAlert) alerts.push({ severity: 'P2', code: 'result_backlog', message: `result outbox backlog ${backlog} exceeds ${this.resultBacklogAlert}` });
    return {
      activeRooms: rooms.length,
      humans: rooms.reduce((total, room) => total + room.humans, 0),
      bots: rooms.reduce((total, room) => total + room.bots, 0),
      rooms,
      alerts,
    };
  }

  private toMetrics(roomId: string, sample: Sample): RoomMetrics {
    const rtts = [...sample.rtts.values()];
    const now = this.now();
    const outboundBytesPerSecond = sample.outbound
      .filter((entry) => entry.at >= now - 1_000)
      .reduce((total, entry) => total + entry.bytes, 0);
    return {
      roomId,
      configVersion: sample.configVersion,
      humans: sample.humans,
      bots: sample.bots,
      tickLastMs: sample.ticks.at(-1) ?? 0,
      tickP95Ms: percentile(sample.ticks, 0.95),
      tickP99Ms: percentile(sample.ticks, 0.99),
      averageRttMs: rtts.length === 0 ? null : rtts.reduce((sum, rtt) => sum + rtt, 0) / rtts.length,
      rttP95Ms: rtts.length === 0 ? null : percentile(rtts, 0.95),
      snapshotP95Bytes: percentile(sample.snapshotBytes, 0.95),
      aoiEntitiesP95: percentile(sample.aoiEntities, 0.95),
      outboundBytesPerSecond,
      errorCount: sample.errorCount,
      errorRate: sample.tickCount === 0 ? 0 : sample.errorCount / sample.tickCount,
      draining: sample.draining,
    };
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}
