import { describe, expect, it } from 'vitest';
import { ClockSync } from './clock';

/**
 * 인공 시계: 서버 시각 = 클라이언트 시각 + TRUE_OFFSET.
 * 편도 지연을 비대칭 없이 왕복으로 나눠 시뮬레이트한다.
 */
const TRUE_OFFSET = 5_000;

function exchange(clock: ClockSync, clientNow: number, oneWayMs: number): number {
  const ping = clock.createPing(clientNow);
  const serverReceiveAt = clientNow + oneWayMs;
  const serverTime = serverReceiveAt + TRUE_OFFSET;
  const clientReceiveAt = serverReceiveAt + oneWayMs;
  clock.onPong({ nonce: ping.nonce, clientTime: ping.clientTime, serverTime }, clientReceiveAt);
  return clientReceiveAt;
}

describe('ClockSync (PRD §9.5)', () => {
  it('대칭 지연에서 offset을 정확히 추정한다', () => {
    const clock = new ClockSync();
    let now = 1_000;
    for (let i = 0; i < 5; i++) now = exchange(clock, now + 500, 50);
    expect(clock.hasEstimate()).toBe(true);
    expect(clock.offset()).toBeCloseTo(TRUE_OFFSET, 5);
    expect(clock.rtt()).toBeCloseTo(100, 5);
    expect(clock.serverNow(10_000)).toBeCloseTo(10_000 + TRUE_OFFSET, 5);
  });

  it('지터가 있어도 低 RTT 표본을 선호해 오차가 억제된다', () => {
    const clock = new ClockSync();
    let now = 1_000;
    const jitters = [50, 120, 55, 200, 48, 90, 52, 180, 51, 60];
    for (const oneWay of jitters) now = exchange(clock, now + 500, oneWay);
    // 낮은 RTT(≈50ms 편도) 표본이 선택되므로 offset 오차는 수 ms 수준
    expect(Math.abs(clock.offset() - TRUE_OFFSET)).toBeLessThan(10);
  });

  it('미지의 nonce pong은 무시한다', () => {
    const clock = new ClockSync();
    clock.onPong({ nonce: 999, clientTime: 0, serverTime: 99999 }, 100);
    expect(clock.hasEstimate()).toBe(false);
  });
});
