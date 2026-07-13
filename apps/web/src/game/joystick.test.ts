import { describe, expect, it } from 'vitest';
import { joystickVector } from './joystick';

const center = { x: 100, y: 100 };

describe('joystickVector (PRD §7.3)', () => {
  it('중심→포인터 방향의 단위 벡터를 반환한다', () => {
    const r = joystickVector(center, { x: 160, y: 100 }, 60);
    expect(r).not.toBeNull();
    expect(r!.dir).toEqual({ x: 1, y: 0 });
    expect(r!.magnitude).toBe(1);
  });

  it('deadzone 안은 null (흔들림 방지)', () => {
    expect(joystickVector(center, { x: 103, y: 100 }, 60)).toBeNull();
  });

  it('반경 밖은 magnitude 1로 클램프하고 방향은 유지한다', () => {
    const r = joystickVector(center, { x: 100, y: 400 }, 60)!;
    expect(r.dir.y).toBeCloseTo(1);
    expect(r.magnitude).toBe(1);
  });
});
