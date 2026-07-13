/** 재접속 시도마다 짧게 시작해 서버 grace window 안에서 반복한다. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.max(0, attempt));
}
