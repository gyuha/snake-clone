import { describe, expect, it, vi } from 'vitest';
import { fullscreenSupported, toggleFullscreen } from './fullscreen';

describe('fullscreen', () => {
  it('지원 여부를 확인하고 진입/종료를 토글한다', async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const exitFullscreen = vi.fn(async () => undefined);
    expect(fullscreenSupported({ fullscreenEnabled: true })).toBe(true);
    expect(await toggleFullscreen({ requestFullscreen } as never, { fullscreenEnabled: true, fullscreenElement: null })).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(await toggleFullscreen({} as never, { fullscreenEnabled: true, fullscreenElement: {} as Element, exitFullscreen })).toBe(true);
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it('지원하지 않거나 브라우저가 거절하면 false를 반환한다', async () => {
    expect(fullscreenSupported({ fullscreenEnabled: false })).toBe(false);
    expect(await toggleFullscreen({ requestFullscreen: async () => { throw new Error('blocked'); } } as never, { fullscreenEnabled: true })).toBe(false);
  });
});
