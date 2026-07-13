import { describe, expect, it } from 'vitest';
import { ClientAoi, type ObservedEntity } from './AoiManager';

const radii = { radius: 1500, despawnRadius: 1800 };
const observer = { x: 0, y: 0 };

function entity(id: string, dist: number): ObservedEntity {
  return { id, x: dist, y: 0, present: true };
}

describe('ClientAoi (loop.md C6 a/b/c)', () => {
  it('(a) interest 반경 밖 엔터티는 구독되지 않는다', () => {
    const aoi = new ClientAoi(radii);
    const diff = aoi.update(observer, [entity('far', 2000)]);
    expect(diff.enters).toHaveLength(0);
    expect(aoi.isKnown('far')).toBe(false);
  });

  it('(b) 진입 시 enter가 정확히 한 번, 이탈 시 leave가 정확히 한 번 발생한다', () => {
    const aoi = new ClientAoi(radii);
    // 밖 → 안
    let enters = 0;
    let leaves = 0;
    const count = (d: { enters: string[]; leaves: string[] }) => {
      enters += d.enters.length;
      leaves += d.leaves.length;
    };

    count(aoi.update(observer, [entity('e', 2000)])); // 밖
    count(aoi.update(observer, [entity('e', 1400)])); // 진입 → enter
    count(aoi.update(observer, [entity('e', 1300)])); // 내부 유지
    count(aoi.update(observer, [entity('e', 1000)]));
    expect(enters).toBe(1);
    expect(leaves).toBe(0);

    count(aoi.update(observer, [entity('e', 1900)])); // despawn 밖 → leave
    count(aoi.update(observer, [entity('e', 2100)]));
    expect(enters).toBe(1);
    expect(leaves).toBe(1);
  });

  it('(c) interest~despawn 사이 왕복은 enter/leave를 반복 발생시키지 않는다 (hysteresis)', () => {
    const aoi = new ClientAoi(radii);
    aoi.update(observer, [entity('e', 1400)]); // enter 1회
    let events = 0;
    // 1550 ↔ 1750 왕복 (interest 밖 despawn 안)
    for (let i = 0; i < 20; i++) {
      const d = aoi.update(observer, [entity('e', i % 2 === 0 ? 1550 : 1750)]);
      events += d.enters.length + d.leaves.length;
    }
    expect(events).toBe(0);
    expect(aoi.isKnown('e')).toBe(true);

    // 반대: 아직 진입한 적 없는 엔터티가 같은 구간을 왕복해도 enter되지 않는다
    let events2 = 0;
    for (let i = 0; i < 20; i++) {
      const d = aoi.update(observer, [entity('e', 1550), entity('never', i % 2 === 0 ? 1550 : 1750)]);
      events2 += d.enters.length + d.leaves.length;
    }
    expect(events2).toBe(0);
    expect(aoi.isKnown('never')).toBe(false);
  });

  it('제거된(present=false) 엔터티와 목록에서 사라진 엔터티는 즉시 leave된다', () => {
    const aoi = new ClientAoi(radii);
    aoi.update(observer, [entity('a', 100), entity('b', 100)]);
    expect(aoi.isKnown('a')).toBe(true);

    const d1 = aoi.update(observer, [{ ...entity('a', 100), present: false }, entity('b', 100)]);
    expect(d1.leaves).toEqual(['a']);

    const d2 = aoi.update(observer, [entity('b', 100)].slice(1)); // b도 목록에서 소멸
    expect(d2.leaves).toEqual(['b']);
  });

  it('pinned(자기 자신)는 거리와 무관하게 항상 구독된다', () => {
    const aoi = new ClientAoi(radii);
    const d = aoi.update(observer, [entity('me', 99999)], 'me');
    expect(d.enters).toEqual(['me']);
    for (let i = 0; i < 5; i++) {
      const dd = aoi.update(observer, [entity('me', 99999)], 'me');
      expect(dd.enters).toHaveLength(0);
      expect(dd.leaves).toHaveLength(0);
    }
    expect(aoi.isKnown('me')).toBe(true);
  });
});
