import { describe, expect, it } from 'vitest';
import { cameraZoomForLength } from './camera';

describe('camera zoom', () => {
  it('keeps short snakes close and gradually zooms out for long snakes', () => {
    expect(cameraZoomForLength(0)).toBe(1.15);
    expect(cameraZoomForLength(450)).toBeCloseTo(0.9);
    expect(cameraZoomForLength(9_000)).toBe(0.72);
  });
});
