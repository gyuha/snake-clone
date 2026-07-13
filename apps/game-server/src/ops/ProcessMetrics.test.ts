import { describe, expect, it } from 'vitest';
import { snapshotProcessMetrics } from './ProcessMetrics';

describe('ProcessMetrics', () => {
  it('Node 메모리와 event-loop 나노초 지연을 운영용 ms 수치로 정규화한다', () => {
    expect(snapshotProcessMetrics({ rss: 100, heapUsed: 40, heapTotal: 80, external: 5 }, 2_500_000)).toEqual({
      rssBytes: 100, heapUsedBytes: 40, heapTotalBytes: 80, externalBytes: 5, eventLoopLagP99Ms: 2.5,
    });
    expect(snapshotProcessMetrics({ rss: 1, heapUsed: 1, heapTotal: 1, external: 1 }, Number.NaN).eventLoopLagP99Ms).toBe(0);
  });
});
