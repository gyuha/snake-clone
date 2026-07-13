import { describe, expect, it } from 'vitest';
import { EventLoopDrainGuard } from './EventLoopDrainGuard';

describe('EventLoopDrainGuard', () => {
  it('지속된 event-loop lag에만 인스턴스 드레인을 요청하고 회복 시 경보를 해제한다', () => {
    let time = 0;
    const guard = new EventLoopDrainGuard({ thresholdMs: 80, sustainMs: 1_000, now: () => time });

    expect(guard.observe(81)).toMatchObject({ draining: false, alert: { code: 'event_loop_lag' } });
    time = 999;
    expect(guard.observe(100).draining).toBe(false);
    time = 1_000;
    expect(guard.observe(100)).toMatchObject({ draining: true, alert: { message: expect.stringContaining('instance draining') } });
    expect(guard.observe(10)).toEqual({ eventLoopLagP99Ms: 10, draining: true });
  });
});
