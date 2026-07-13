import type { Vec2 } from '@serpent/game-core';

export interface DirectionKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export type InputDevice = 'pointer' | 'keys';

/** WASD/방향키 조합 → 방향 벡터 (아무 키도 없으면 null) */
export function keysToDirection(keys: DirectionKeys): Vec2 | null {
  const x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const y = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  if (x === 0 && y === 0) return null;
  return { x, y };
}

/**
 * 키보드와 포인터 동시 입력 시 마지막 활성 장치 기준으로 처리한다 (PRD §6.1).
 * 키가 눌려 있으면 키보드가 활성 장치가 되고, 키가 없으면 포인터를 따른다.
 */
export function resolveInputDirection(opts: {
  keys: DirectionKeys;
  pointerWorld: Vec2 | null;
  head: Vec2;
  lastDevice: InputDevice;
}): { dir: Vec2 | null; device: InputDevice } {
  const keyDir = keysToDirection(opts.keys);
  if (keyDir) return { dir: keyDir, device: 'keys' };

  if (opts.lastDevice === 'keys' && opts.pointerWorld === null) {
    // 키를 뗀 직후 포인터 정보가 없으면 현재 방향 유지
    return { dir: null, device: 'keys' };
  }

  if (opts.pointerWorld) {
    const dir = { x: opts.pointerWorld.x - opts.head.x, y: opts.pointerWorld.y - opts.head.y };
    if (Math.hypot(dir.x, dir.y) < 1) return { dir: null, device: 'pointer' };
    return { dir, device: 'pointer' };
  }
  return { dir: null, device: opts.lastDevice };
}
