import { describe, expect, it } from 'vitest';
import { supportsGameRendering } from './renderSupport';

describe('render support', () => {
  it('WebGL 또는 Canvas 2D 중 하나만 있어도 게임을 지원한다', () => {
    expect(supportsGameRendering(() => ({ getContext: (kind) => kind === 'webgl' ? {} : null }))).toBe(true);
    expect(supportsGameRendering(() => ({ getContext: (kind) => kind === '2d' ? {} : null }))).toBe(true);
  });

  it('둘 다 없으면 지원하지 않는다', () => {
    expect(supportsGameRendering(() => ({ getContext: () => null }))).toBe(false);
  });
});
