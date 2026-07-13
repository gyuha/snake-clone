import { describe, expect, it } from 'vitest';
import { SNAPSHOT_WARNING_AFTER_MS, snapshotIsStale } from './connection';

describe('snapshot connection health', () => {
  it('250ms 보간 한계 전에는 경고하지 않고, 초과하면 경고한다', () => {
    expect(snapshotIsStale(1_000, 1_000 + SNAPSHOT_WARNING_AFTER_MS)).toBe(false);
    expect(snapshotIsStale(1_000, 1_000 + SNAPSHOT_WARNING_AFTER_MS + 1)).toBe(true);
  });

  it('아직 수신한 snapshot이 없으면 경고하지 않는다', () => {
    expect(snapshotIsStale(0, 10_000)).toBe(false);
  });
});
