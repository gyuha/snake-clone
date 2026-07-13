export interface ProcessMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  eventLoopLagP99Ms: number;
}

/** Node runtime 수치를 JSON 운영 endpoint용 숫자로 정규화한다. */
export function snapshotProcessMetrics(
  memory: Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal' | 'external'>,
  eventLoopLagP99Ns: number,
): ProcessMetrics {
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    eventLoopLagP99Ms: Number.isFinite(eventLoopLagP99Ns) ? Math.max(0, eventLoopLagP99Ns / 1_000_000) : 0,
  };
}
