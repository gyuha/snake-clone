/** 몸통이 길어질수록 조금 넓게 보되, 플레이 감각이 흔들리지 않는 범위로 제한한다. */
export function cameraZoomForLength(length: number): number {
  return Math.max(0.72, Math.min(1.15, 1.15 - Math.max(0, length) / 1_800));
}
