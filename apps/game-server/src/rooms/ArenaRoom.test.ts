import { describe, expect, it } from 'vitest';
import {
  ArenaState,
  compareSnakeRank,
  disconnectSpeedMultiplier,
  INVALID_INPUT_DISCONNECT_AFTER,
  INVALID_INPUT_WINDOW_MS,
  roomMaxAgeMs,
} from './ArenaRoom';

describe('ArenaState', () => {
  it('반복 invalid 입력 차단 정책은 짧은 관찰 창과 유한 임계값을 사용한다', () => {
    expect(INVALID_INPUT_WINDOW_MS).toBe(10_000);
    expect(INVALID_INPUT_DISCONNECT_AFTER).toBeGreaterThan(1);
  });

  it('초기 상태는 tickId 0이고 configVersion은 onCreate에서 채워진다', () => {
    const state = new ArenaState();
    expect(state.tickId).toBe(0);
    expect(state.configVersion).toBe('');
  });

  it('Room 최대 수명은 기본 30분이며 너무 짧거나 잘못된 환경값은 거부한다', () => {
    expect(roomMaxAgeMs(undefined)).toBe(30 * 60_000);
    expect(roomMaxAgeMs('3600000')).toBe(3_600_000);
    expect(roomMaxAgeMs('999')).toBe(30 * 60_000);
    expect(roomMaxAgeMs('not-a-number')).toBe(30 * 60_000);
  });

  it('단절은 처음 3초간 유지한 뒤 reconnect grace 끝까지 감속한다', () => {
    expect(disconnectSpeedMultiplier(0, 10_000)).toBe(1);
    expect(disconnectSpeedMultiplier(3_000, 10_000)).toBe(1);
    expect(disconnectSpeedMultiplier(6_500, 10_000)).toBeCloseTo(0.5);
    expect(disconnectSpeedMultiplier(10_000, 10_000)).toBe(0);
  });

  it('리더보드와 결과 순위는 점수 후 생존 시간으로 같은 타이브레이크를 쓴다', () => {
    const snakes = [
      { id: 'late', score: 100, spawnedAtTick: 20, spawnOrder: 2 },
      { id: 'early', score: 100, spawnedAtTick: 10, spawnOrder: 1 },
      { id: 'higher', score: 101, spawnedAtTick: 30, spawnOrder: 3 },
    ];
    expect(snakes.sort(compareSnakeRank).map((snake) => snake.id)).toEqual(['higher', 'early', 'late']);
  });

  it('같은 tick에 스폰해도 실제 스폰 순서가 동률을 결정한다', () => {
    const snakes = [
      { id: 'second', score: 100, spawnedAtTick: 5, spawnOrder: 2 },
      { id: 'first', score: 100, spawnedAtTick: 5, spawnOrder: 1 },
    ];
    expect(snakes.sort(compareSnakeRank).map((snake) => snake.id)).toEqual(['first', 'second']);
  });
});
