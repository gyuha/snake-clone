import { describe, expect, it } from 'vitest';
import { ArenaState } from './ArenaRoom';

describe('ArenaState', () => {
  it('초기 상태는 tickId 0이고 configVersion은 onCreate에서 채워진다', () => {
    const state = new ArenaState();
    expect(state.tickId).toBe(0);
    expect(state.configVersion).toBe('');
  });
});
