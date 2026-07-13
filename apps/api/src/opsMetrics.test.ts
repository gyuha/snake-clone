import { describe, expect, it } from 'vitest';
import { ApiMetrics } from './opsMetrics';

describe('ApiMetrics', () => {
  it('최근 윈도우의 RPS·지연 백분위·5xx 오류율만 집계한다', () => {
    let now = 1_000;
    const metrics = new ApiMetrics(() => now, 1_000);
    metrics.observe(10, 200); metrics.observe(30, 500); metrics.observe(20, 200);
    expect(metrics.snapshot()).toMatchObject({ requests: 3, requestsPerSecond: 3, latencyP50Ms: 20, latencyP95Ms: 30, errors5xx: 1, errorRate: 1 / 3 });
    now = 2_001;
    expect(metrics.snapshot()).toMatchObject({ requests: 0, requestsPerSecond: 0, errorRate: 0 });
  });
});
