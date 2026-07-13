/** PRD §6.1: snapshot loss is surfaced after the 250ms interpolation window. */
export const SNAPSHOT_WARNING_AFTER_MS = 250;

export function snapshotIsStale(lastReceivedAt: number, now: number): boolean {
  return lastReceivedAt > 0 && now - lastReceivedAt > SNAPSHOT_WARNING_AFTER_MS;
}
