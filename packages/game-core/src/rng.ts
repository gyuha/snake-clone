/**
 * mulberry32 — 시드 기반 결정적 PRNG.
 * 시뮬레이션의 모든 난수(스폰 위치, 펠릿 배치, 잔해 산포)는
 * 반드시 이 인스턴스에서 나와야 한다 (Math.random 금지 — 결정성 계약).
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) 균등 난수 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 균등 난수 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}
