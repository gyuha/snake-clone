import type { Vec2 } from '@serpent/game-core';

/**
 * 모바일 가상 조이스틱 벡터 (PRD §7.3).
 * 중심에서 포인터까지의 방향을 반환한다. deadzone 미만은 null,
 * maxRadius 밖은 클램프(방향만 사용).
 */
export function joystickVector(
  center: Vec2,
  pointer: Vec2,
  maxRadius: number,
  deadzone = 0.15,
): { dir: Vec2; magnitude: number } | null {
  const dx = pointer.x - center.x;
  const dy = pointer.y - center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < maxRadius * deadzone) return null;
  const magnitude = Math.min(1, dist / maxRadius);
  return { dir: { x: dx / dist, y: dy / dist }, magnitude };
}

/** 터치 우선 환경인가 (조이스틱 노출 판단) */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}
