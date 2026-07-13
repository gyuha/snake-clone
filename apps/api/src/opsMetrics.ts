export interface ApiMetricsSnapshot {
  windowMs: number;
  requests: number;
  requestsPerSecond: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  errors5xx: number;
  errorRate: number;
}

interface Sample { at: number; durationMs: number; statusCode: number }

/** 최근 요청의 숫자 표본만 제한적으로 보관하는 API 운영 메트릭. */
export class ApiMetrics {
  private samples: Sample[] = [];
  constructor(private readonly now: () => number = Date.now, private readonly windowMs = 60_000, private readonly maxSamples = 5_000) {}

  observe(durationMs: number, statusCode: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isInteger(statusCode)) return;
    this.samples.push({ at: this.now(), durationMs, statusCode });
    this.prune(this.now());
  }

  snapshot(): ApiMetricsSnapshot {
    const now = this.now();
    this.prune(now);
    const durations = this.samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const errors5xx = this.samples.filter((sample) => sample.statusCode >= 500).length;
    return {
      windowMs: this.windowMs,
      requests: this.samples.length,
      requestsPerSecond: this.samples.length / (this.windowMs / 1000),
      latencyP50Ms: percentile(durations, 0.5),
      latencyP95Ms: percentile(durations, 0.95),
      errors5xx,
      errorRate: this.samples.length === 0 ? 0 : errors5xx / this.samples.length,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0]!.at < cutoff || this.samples.length > this.maxSamples)) this.samples.shift();
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]!;
}
