import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from './reconnect';

describe('reconnect delay', () => {
  it('starts quickly and is capped so attempts fit the server grace window', () => {
    expect(reconnectDelayMs(0)).toBe(250);
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(3)).toBe(2_000);
    expect(reconnectDelayMs(99)).toBe(2_000);
  });
});
