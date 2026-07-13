import type { Vec2 } from './types';

/** 점-선분 최단 거리 제곱 (narrow phase 공용 — sqrt 최소화, PRD §9.8.7) */
export function pointSegmentDistanceSq(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = 0;
  if (lenSq > 0) {
    t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return dx * dx + dy * dy;
}

/** 셀 좌표 키 (음수 좌표 포함 안전) */
export function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

export function cellOf(x: number, y: number, cellSize: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / cellSize), cy: Math.floor(y / cellSize) };
}

/** 위치의 청크 키 — 클라이언트/서버가 동일 계산을 공유한다 (pellet chunk 동기화) */
export function chunkKeyForPosition(x: number, y: number, cellSize: number): string {
  const { cx, cy } = cellOf(x, y, cellSize);
  return cellKey(cx, cy);
}

/**
 * Uniform Spatial Hash Grid (PRD §9.4, §9.8.7).
 * 항목은 AABB가 걸치는 모든 셀에 등록되고, 원 질의는 원의 AABB가 걸치는
 * 셀들의 후보를 반환한다 (broad phase). 정밀 판정은 호출자 몫.
 */
export class SpatialHashGrid<T> {
  private cells = new Map<string, Set<T>>();
  private itemCells = new Map<T, string[]>();

  constructor(readonly cellSize: number) {}

  insert(item: T, minX: number, minY: number, maxX: number, maxY: number): void {
    this.remove(item);
    const c0 = cellOf(minX, minY, this.cellSize);
    const c1 = cellOf(maxX, maxY, this.cellSize);
    const keys: string[] = [];
    for (let cx = c0.cx; cx <= c1.cx; cx++) {
      for (let cy = c0.cy; cy <= c1.cy; cy++) {
        const key = cellKey(cx, cy);
        let set = this.cells.get(key);
        if (!set) {
          set = new Set();
          this.cells.set(key, set);
        }
        set.add(item);
        keys.push(key);
      }
    }
    this.itemCells.set(item, keys);
  }

  insertPoint(item: T, x: number, y: number): void {
    this.insert(item, x, y, x, y);
  }

  remove(item: T): void {
    const keys = this.itemCells.get(item);
    if (!keys) return;
    for (const key of keys) {
      const set = this.cells.get(key);
      set?.delete(item);
      if (set && set.size === 0) this.cells.delete(key);
    }
    this.itemCells.delete(item);
  }

  /** 원(중심, 반경)의 AABB가 걸치는 셀들의 후보 집합 (중복 제거) */
  queryCircle(x: number, y: number, radius: number): Set<T> {
    const out = new Set<T>();
    const c0 = cellOf(x - radius, y - radius, this.cellSize);
    const c1 = cellOf(x + radius, y + radius, this.cellSize);
    for (let cx = c0.cx; cx <= c1.cx; cx++) {
      for (let cy = c0.cy; cy <= c1.cy; cy++) {
        const set = this.cells.get(cellKey(cx, cy));
        if (set) for (const item of set) out.add(item);
      }
    }
    return out;
  }

  size(): number {
    return this.itemCells.size;
  }
}

/** 등록된 몸통 캡슐 세그먼트 */
export interface BodySegment {
  ownerId: string;
  a: Vec2;
  b: Vec2;
}

/**
 * 몸통 충돌 인덱스 — 경로 키포인트 세그먼트를 증분 관리한다.
 * 키포인트 세그먼트 (path[i] → path[i+1])는 생성 후 불변이므로,
 * 틱마다 전체 재생성 없이 앞(unshift)에서 추가하고 뒤(trim)에서 제거한다
 * (PRD §9.8.7: 전체 인덱스 재생성 금지).
 */
export class BodyCollisionIndex {
  private grid: SpatialHashGrid<BodySegment>;
  /** ownerId → 등록된 세그먼트 (front→back, seg[i]는 front node 객체 동일성으로 대응) */
  private segments = new Map<string, BodySegment[]>();

  constructor(cellSize: number, private readonly padding: number) {
    this.grid = new SpatialHashGrid(cellSize);
  }

  /** 뱀의 현재 path와 등록 상태를 동기화 (앞 추가/뒤 제거만 발생) */
  syncSnake(ownerId: string, path: readonly Vec2[]): void {
    let segs = this.segments.get(ownerId);
    if (!segs) {
      segs = [];
      this.segments.set(ownerId, segs);
    }

    // 앞쪽 신규 노드 → 새 세그먼트 (front node 객체 동일성 비교;
    // 키포인트는 앞에서만 추가되고 뒤에서만 제거되므로 이 대응은 안정적이다)
    let newCount = 0;
    while (newCount < path.length - 1 && path[newCount] !== segs[0]?.a) {
      newCount++;
    }
    for (let i = newCount - 1; i >= 0; i--) {
      const seg: BodySegment = { ownerId, a: path[i]!, b: path[i + 1]! };
      this.insertSegment(seg);
      segs.unshift(seg);
    }

    // 뒤쪽 trim → 세그먼트 제거
    const want = Math.max(0, path.length - 1);
    while (segs.length > want) {
      const seg = segs.pop()!;
      this.grid.remove(seg);
    }
  }

  private insertSegment(seg: BodySegment): void {
    const minX = Math.min(seg.a.x, seg.b.x) - this.padding;
    const minY = Math.min(seg.a.y, seg.b.y) - this.padding;
    const maxX = Math.max(seg.a.x, seg.b.x) + this.padding;
    const maxY = Math.max(seg.a.y, seg.b.y) + this.padding;
    this.grid.insert(seg, minX, minY, maxX, maxY);
  }

  removeSnake(ownerId: string): void {
    const segs = this.segments.get(ownerId);
    if (!segs) return;
    for (const seg of segs) this.grid.remove(seg);
    this.segments.delete(ownerId);
  }

  /** head 원과 교차하는 다른 소유자의 세그먼트가 있는가 (broad → narrow) */
  hitsOtherBody(head: Vec2, selfId: string, hitRadius: number): string | null {
    const candidates = this.grid.queryCircle(head.x, head.y, hitRadius);
    const hitSq = hitRadius * hitRadius;
    for (const seg of candidates) {
      if (seg.ownerId === selfId) continue;
      if (pointSegmentDistanceSq(head, seg.a, seg.b) <= hitSq) return seg.ownerId;
    }
    return null;
  }

  segmentCount(ownerId: string): number {
    return this.segments.get(ownerId)?.length ?? 0;
  }
}
