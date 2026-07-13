import { describe, expect, it } from 'vitest';
import { RemoteInterpolator, type RemoteSample } from './interpolation';

function sample(time: number, x: number, y = 0): RemoteSample {
  return { time, x, y, angle: 0, mass: 10, boosting: false, alive: true, path: [] };
}

describe('RemoteInterpolator (PRD §9.8.4)', () => {
  it('두 스냅샷 사이 시각은 선형 보간한다', () => {
    const interp = new RemoteInterpolator(200);
    interp.push(sample(1000, 0));
    interp.push(sample(1100, 100));
    const s = interp.sample(1050)!;
    expect(s.x).toBeCloseTo(50);
  });

  it('버퍼 고갈 시 마지막 속도로 외삽하고 상한에서 중단한다', () => {
    const interp = new RemoteInterpolator(200);
    interp.push(sample(1000, 0));
    interp.push(sample(1100, 100)); // 속도 1 unit/ms
    // 150ms 외삽
    expect(interp.sample(1250)!.x).toBeCloseTo(250);
    // 200ms 상한 도달 → 그 이상은 정지 (동일 위치)
    expect(interp.sample(1300)!.x).toBeCloseTo(300);
    expect(interp.sample(1900)!.x).toBeCloseTo(300);
  });

  it('가장 오래된 샘플 이전 시각은 가장 오래된 샘플을 반환한다', () => {
    const interp = new RemoteInterpolator(200);
    interp.push(sample(1000, 0));
    interp.push(sample(1100, 100));
    expect(interp.sample(900)!.x).toBe(0);
  });

  it('시간 역행 샘플은 폐기한다', () => {
    const interp = new RemoteInterpolator(200);
    interp.push(sample(1000, 0));
    interp.push(sample(900, 999));
    expect(interp.size()).toBe(1);
  });

  it('각도는 최단 경로로 보간한다', () => {
    const interp = new RemoteInterpolator(200);
    const a = sample(1000, 0);
    a.angle = Math.PI - 0.1;
    const b = sample(1100, 0);
    b.angle = -Math.PI + 0.1;
    interp.push(a);
    interp.push(b);
    const mid = interp.sample(1050)!;
    // PI 경계를 넘어 최단으로: 중간값은 ±PI 근처여야 한다 (0 근처가 아니라)
    expect(Math.abs(mid.angle)).toBeGreaterThan(3);
  });
});
