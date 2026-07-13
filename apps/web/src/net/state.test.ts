import { createGameConfig } from '@serpent/config';
import type { PlayerSnapshot, SnapshotMessage, WelcomeMessage } from '@serpent/protocol';
import { describe, expect, it } from 'vitest';
import { applySnapshot, createWorldFromWelcome } from './state';

const config = createGameConfig();

function player(id: string, x = 0, y = 0): PlayerSnapshot {
  return {
    id,
    alive: true,
    x,
    y,
    angle: 0,
    mass: 10,
    score: 0,
    boosting: false,
    name: 'p',
    skinId: 0,
    path: [{ x: x - 10, y }],
  };
}

const welcome: WelcomeMessage = {
  protocolVersion: 1,
  playerId: 'me',
  roomId: 'r1',
  configVersion: config.version,
  tickRate: 20,
  snapshotRate: 10,
  serverTime: 0,
  tickId: 10,
  arena: { width: 6000, height: 6000 },
  players: [player('me', 1000, 1000)],
  pellets: [
    { id: 1, x: 1005, y: 1000, value: 1 },
    { id: 2, x: 1600, y: 1000, value: 1 },
  ],
};

function snap(partial: Partial<SnapshotMessage>): SnapshotMessage {
  return {
    tickId: 12,
    serverTime: 100,
    lastAckInputSeq: 3,
    snakes: [],
    enters: [],
    leaves: [],
    pelletChunks: [],
    ...partial,
  };
}

describe('NetWorldState (M4 AOI/델타)', () => {
  it('welcome baseline으로 뱀/펠릿/청크 인덱스를 만든다', () => {
    const w = createWorldFromWelcome(welcome, config);
    expect(w.snakes.get('me')?.x).toBe(1000);
    expect(w.pellets.size).toBe(2);
    expect(w.chunkPellets.get('2:2')?.has(1)).toBe(true); // 1005/500=2
    expect(w.chunkPellets.get('3:2')?.has(2)).toBe(true); // 1600/500=3
  });

  it('aoi enter로 뱀이 생기고 leave로 사라진다', () => {
    const w = createWorldFromWelcome(welcome, config);
    applySnapshot(w, snap({ enters: [{ type: 'snake', snake: player('other', 2000, 1000) }] }), config);
    expect(w.snakes.has('other')).toBe(true);

    applySnapshot(w, snap({ tickId: 14, leaves: [{ type: 'snake', id: 'other' }] }), config);
    expect(w.snakes.has('other')).toBe(false);
  });

  it('청크 leave는 그 청크의 펠릿을 일괄 제거한다', () => {
    const w = createWorldFromWelcome(welcome, config);
    applySnapshot(w, snap({ leaves: [{ type: 'pelletChunk', chunkId: '3:2' }] }), config);
    expect(w.pellets.has(2)).toBe(false);
    expect(w.pellets.has(1)).toBe(true);
  });

  it('snake 델타는 신규 키포인트를 앞에 붙이고 길이에 맞게 trim한다', () => {
    const w = createWorldFromWelcome(welcome, config);
    applySnapshot(
      w,
      snap({
        snakes: [
          {
            id: 'me',
            alive: true,
            x: 1024,
            y: 1000,
            angle: 0,
            mass: 10,
            score: 20,
            boosting: false,
            newPathNodes: [
              { x: 1012, y: 1000 },
              { x: 1000, y: 1000 },
            ],
          },
        ],
      }),
      config,
    );
    const me = w.snakes.get('me')!;
    expect(me.x).toBe(1024);
    expect(me.score).toBe(20);
    expect(me.path[0]).toEqual({ x: 1012, y: 1000 });
    expect(me.path[1]).toEqual({ x: 1000, y: 1000 });
    // 기존 baseline 노드가 뒤에 유지된다 (mass 10 → keep 212, 전체 유지)
    expect(me.path[2]).toEqual({ x: 990, y: 1000 });
  });

  it('펠릿 청크 증분(created/removed)을 반영한다', () => {
    const w = createWorldFromWelcome(welcome, config);
    applySnapshot(
      w,
      snap({
        pelletChunks: [
          { chunkId: '2:2', created: [{ id: 9, x: 1010, y: 1010, value: 2 }], removed: [1] },
        ],
      }),
      config,
    );
    expect(w.pellets.has(1)).toBe(false);
    expect(w.pellets.get(9)?.value).toBe(2);
  });

  it('과거 tickId의 늦은 snapshot은 폐기한다', () => {
    const w = createWorldFromWelcome(welcome, config);
    applySnapshot(w, snap({ tickId: 20 }), config);
    applySnapshot(w, snap({ tickId: 15, lastAckInputSeq: 99 }), config);
    expect(w.tickId).toBe(20);
    expect(w.lastAckInputSeq).not.toBe(99);
  });
});
