/** Phaser의 WebGL 우선/Canvas 폴백 중 하나라도 가능한지 확인한다. */
export function supportsGameRendering(
  createCanvas: () => { getContext(kind: string): unknown },
): boolean {
  const canvas = createCanvas();
  return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('2d'));
}

export function browserSupportsGameRendering(): boolean {
  return typeof document !== 'undefined' && supportsGameRendering(() => document.createElement('canvas'));
}
