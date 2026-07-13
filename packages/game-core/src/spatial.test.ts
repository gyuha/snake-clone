import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import {
  BodyCollisionIndex,
  SpatialHashGrid,
  chunkKeyForPosition,
  pointSegmentDistanceSq,
} from './spatial';
import type { Vec2 } from './types';

describe('pointSegmentDistanceSq', () => {
  it('선분 위 수선/끝점 거리를 계산한다', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(pointSegmentDistanceSq({ x: 5, y: 3 }, a, b)).toBeCloseTo(9);
    expect(pointSegmentDistanceSq({ x: -4, y: 0 }, a, b)).toBeCloseTo(16);
    expect(pointSegmentDistanceSq({ x: 13, y: 4 }, a, b)).toBeCloseTo(25);
  });
});

describe('SpatialHashGrid', () => {
  it('원 질의는 반경 내 항목을 모두 포함한다 (놓침 없음)', () => {
    const grid = new SpatialHashGrid<number>(500);
    grid.insertPoint(1, 100, 100);
    grid.insertPoint(2, 600, 100); // 다른 셀
    grid.insertPoint(3, 3000, 3000); // 먼 곳
    const hits = grid.queryCircle(400, 100, 250);
    expect(hits.has(1)).toBe(true);
    expect(hits.has(2)).toBe(true);
    expect(hits.has(3)).toBe(false);
  });

  it('remove 후에는 질의에 나오지 않는다', () => {
    const grid = new SpatialHashGrid<number>(500);
    grid.insertPoint(1, 100, 100);
    grid.remove(1);
    expect(grid.queryCircle(100, 100, 50).size).toBe(0);
    expect(grid.size()).toBe(0);
  });
});

describe('BodyCollisionIndex — 전수 검사 동등성 (loop.md C6-d)', () => {
  const CELL = 500;
  const HIT_RADIUS = 22; // headRadius 12 + bodyRadius 10

  /** 무작위 지그재그 경로 생성 */
  function randomPath(rng: Rng, nodes: number): Vec2[] {
    const path: Vec2[] = [{ x: rng.range(0, 6000), y: rng.range(0, 6000) }];
    for (let i = 1; i < nodes; i++) {
      const prev = path[i - 1]!;
      path.push({ x: prev.x + rng.range(-60, 60), y: prev.y + rng.range(-60, 60) });
    }
    return path;
  }

  /** 전수 검사: 모든 소유자의 모든 세그먼트에 대해 narrow phase 직접 수행 */
  function bruteForce(
    head: Vec2,
    selfId: string,
    all: Map<string, Vec2[]>,
    hitRadius: number,
  ): boolean {
    const hitSq = hitRadius * hitRadius;
    for (const [owner, path] of all) {
      if (owner === selfId) continue;
      for (let i = 0; i < path.length - 1; i++) {
        if (pointSegmentDistanceSq(head, path[i]!, path[i + 1]!) <= hitSq) return true;
      }
    }
    return false;
  }

  it('무작위 500 질의에서 spatial hash 판정 == 전수 판정', () => {
    const rng = new Rng(20260713);
    const index = new BodyCollisionIndex(CELL, 10);
    const paths = new Map<string, Vec2[]>();
    for (let s = 0; s < 12; s++) {
      const id = `s${s}`;
      const path = randomPath(rng, 30);
      paths.set(id, path);
      index.syncSnake(id, path);
    }

    let hits = 0;
    for (let q = 0; q < 500; q++) {
      // 절반은 경로 근처, 절반은 완전 무작위 (히트/미스 모두 커버)
      let head: Vec2;
      if (q % 2 === 0) {
        const path = paths.get(`s${q % 12}`)!;
        const node = path[Math.floor(rng.range(0, path.length))]!;
        head = { x: node.x + rng.range(-40, 40), y: node.y + rng.range(-40, 40) };
      } else {
        head = { x: rng.range(0, 6000), y: rng.range(0, 6000) };
      }
      const selfId = `s${Math.floor(rng.range(0, 12))}`;
      const hashResult = index.hitsOtherBody(head, selfId, HIT_RADIUS) !== null;
      const bruteResult = bruteForce(head, selfId, paths, HIT_RADIUS);
      expect(hashResult).toBe(bruteResult);
      if (hashResult) hits++;
    }
    expect(hits).toBeGreaterThan(20); // 히트 케이스가 실제로 존재했음을 보증
  });

  it('증분 동기화: 앞 추가/뒤 제거가 세그먼트 수에 정확히 반영된다', () => {
    const index = new BodyCollisionIndex(CELL, 10);
    const n1 = { x: 100, y: 0 };
    const n2 = { x: 88, y: 0 };
    const path: Vec2[] = [n1, n2];
    index.syncSnake('a', path);
    expect(index.segmentCount('a')).toBe(1);

    // 앞에 노드 추가 (unshift와 동일)
    path.unshift({ x: 112, y: 0 });
    index.syncSnake('a', path);
    expect(index.segmentCount('a')).toBe(2);

    // 뒤 trim
    path.length = 2;
    index.syncSnake('a', path);
    expect(index.segmentCount('a')).toBe(1);

    // 제거
    index.removeSnake('a');
    expect(index.segmentCount('a')).toBe(0);
  });

  it('제거된 뱀의 몸통은 더 이상 충돌하지 않는다', () => {
    const index = new BodyCollisionIndex(CELL, 10);
    index.syncSnake('b', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(index.hitsOtherBody({ x: 50, y: 5 }, 'a', HIT_RADIUS)).toBe('b');
    index.removeSnake('b');
    expect(index.hitsOtherBody({ x: 50, y: 5 }, 'a', HIT_RADIUS)).toBeNull();
  });
});

describe('chunkKeyForPosition', () => {
  it('클라이언트/서버가 공유하는 결정적 청크 키', () => {
    expect(chunkKeyForPosition(0, 0, 500)).toBe('0:0');
    expect(chunkKeyForPosition(499, 499, 500)).toBe('0:0');
    expect(chunkKeyForPosition(500, 0, 500)).toBe('1:0');
    expect(chunkKeyForPosition(-1, -1, 500)).toBe('-1:-1');
  });
});
