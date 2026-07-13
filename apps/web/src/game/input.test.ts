import { describe, expect, it } from 'vitest';
import { gamepadInput, keysToDirection, resolveInputDirection } from './input';

const noKeys = { up: false, down: false, left: false, right: false };

describe('keysToDirection', () => {
  it('단일/대각 키 조합을 방향 벡터로 변환한다', () => {
    expect(keysToDirection({ ...noKeys, right: true })).toEqual({ x: 1, y: 0 });
    expect(keysToDirection({ ...noKeys, up: true, left: true })).toEqual({ x: -1, y: -1 });
  });

  it('키가 없으면 null', () => {
    expect(keysToDirection(noKeys)).toBeNull();
  });

  it('상충 키는 상쇄된다', () => {
    expect(keysToDirection({ up: true, down: true, left: false, right: false })).toBeNull();
  });
});

describe('resolveInputDirection — 마지막 활성 장치 규칙 (PRD §6.1)', () => {
  const head = { x: 100, y: 100 };

  it('키가 눌려 있으면 포인터보다 키보드가 우선한다', () => {
    const r = resolveInputDirection({
      keys: { ...noKeys, right: true },
      pointerWorld: { x: 0, y: 0 },
      head,
      lastDevice: 'pointer',
    });
    expect(r.device).toBe('keys');
    expect(r.dir).toEqual({ x: 1, y: 0 });
  });

  it('키가 없으면 포인터 방향(머리→포인터)을 따른다', () => {
    const r = resolveInputDirection({
      keys: noKeys,
      pointerWorld: { x: 200, y: 100 },
      head,
      lastDevice: 'pointer',
    });
    expect(r.device).toBe('pointer');
    expect(r.dir).toEqual({ x: 100, y: 0 });
  });

  it('머리에 너무 가까운 포인터는 방향을 만들지 않는다 (흔들림 방지)', () => {
    const r = resolveInputDirection({
      keys: noKeys,
      pointerWorld: { x: 100.2, y: 100 },
      head,
      lastDevice: 'pointer',
    });
    expect(r.dir).toBeNull();
  });
});

describe('gamepadInput (PRD §7.3 Could)', () => {
  const pad = (axes: number[], pressed: number[] = []) => ({
    connected: true, axes, buttons: Array.from({ length: 8 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })),
  }) as unknown as Gamepad;

  it('왼쪽 스틱 데드존을 적용하고 A/RT를 부스트로 매핑한다', () => {
    expect(gamepadInput([pad([0.1, 0.1])])).toEqual({ dir: null, boost: false });
    expect(gamepadInput([pad([0.7, -0.4], [0])])).toEqual({ dir: { x: 0.7, y: -0.4 }, boost: true });
    expect(gamepadInput([pad([-1, 0], [7])]).boost).toBe(true);
  });
});
