/**
 * 클라이언트별 관심 영역(AOI) 추적기 (PRD §9.8.3).
 * - interest radius 안으로 들어온 엔터티 → enter (정확히 1회)
 * - despawn radius 밖으로 나간 엔터티 → leave (정확히 1회)
 * - 두 반경의 간격이 hysteresis 역할을 해 경계 왕복 시 enter/leave가 반복되지 않는다.
 * 순수 로직 — Colyseus/시뮬레이션에 의존하지 않아 단위 테스트 가능.
 */

export interface AoiRadii {
  radius: number;
  despawnRadius: number;
}

export interface ObservedEntity {
  id: string;
  x: number;
  y: number;
  /** 존재 여부 — 제거된 엔터티(퇴장/리스폰 리셋)는 즉시 leave */
  present: boolean;
}

export interface AoiDiff {
  enters: string[];
  leaves: string[];
}

export class ClientAoi {
  private known = new Set<string>();

  constructor(private readonly radii: AoiRadii) {}

  isKnown(id: string): boolean {
    return this.known.has(id);
  }

  knownIds(): ReadonlySet<string> {
    return this.known;
  }

  /** 강제 구독 (자기 자신 등 — leave 판정에서 제외하려면 update의 pinned로 전달) */
  markKnown(id: string): void {
    this.known.add(id);
  }

  forget(id: string): void {
    this.known.delete(id);
  }

  /**
   * 경계마다 호출: 관측자 위치 기준으로 enter/leave를 계산하고 known 집합을 갱신한다.
   * pinned id는 거리와 무관하게 항상 구독 유지 (자기 자신).
   */
  update(observer: { x: number; y: number }, entities: ObservedEntity[], pinned?: string): AoiDiff {
    const enters: string[] = [];
    const leaves: string[] = [];
    const seen = new Set<string>();

    for (const e of entities) {
      seen.add(e.id);
      const dist = Math.hypot(e.x - observer.x, e.y - observer.y);
      const known = this.known.has(e.id);
      if (e.id === pinned) {
        if (!known) {
          this.known.add(e.id);
          enters.push(e.id);
        }
        continue;
      }
      if (!e.present) {
        if (known) {
          this.known.delete(e.id);
          leaves.push(e.id);
        }
        continue;
      }
      if (!known && dist <= this.radii.radius) {
        this.known.add(e.id);
        enters.push(e.id);
      } else if (known && dist > this.radii.despawnRadius) {
        this.known.delete(e.id);
        leaves.push(e.id);
      }
    }

    // 목록에서 아예 사라진(제거된) 엔터티도 leave
    for (const id of [...this.known]) {
      if (!seen.has(id) && id !== pinned) {
        this.known.delete(id);
        leaves.push(id);
      }
    }

    return { enters, leaves };
  }
}
