import { wrapAngle } from '@serpent/game-core';

export interface RemoteSample {
  /** 서버 시각 (ms) */
  time: number;
  x: number;
  y: number;
  angle: number;
  mass: number;
  boosting: boolean;
  alive: boolean;
  path: { x: number; y: number }[];
}

/**
 * 원격 뱀 보간기 (PRD §9.5, §9.8.4).
 * renderTime(= 최신 서버 시각 - 보간 버퍼)에 대해 두 스냅샷 사이를 선형 보간한다.
 * 버퍼가 고갈되면 마지막 속도로 최대 maxExtrapolationMs까지 외삽 후 정지한다.
 */
export class RemoteInterpolator {
  private buf: RemoteSample[] = [];

  constructor(private readonly maxExtrapolationMs = 200) {}

  push(sample: RemoteSample): void {
    const last = this.buf[this.buf.length - 1];
    if (last && sample.time <= last.time) return; // 역행/중복 폐기
    this.buf.push(sample);
    // 오래된 샘플 정리 (2초 이상 과거)
    const cutoff = sample.time - 2000;
    while (this.buf.length > 2 && this.buf[0]!.time < cutoff) this.buf.shift();
  }

  /** renderTime 기준 표시 상태. 샘플이 없으면 null */
  sample(renderTime: number): RemoteSample | null {
    if (this.buf.length === 0) return null;
    const newest = this.buf[this.buf.length - 1]!;
    const oldest = this.buf[0]!;

    if (renderTime <= oldest.time) return oldest;

    if (renderTime >= newest.time) {
      // 외삽: 마지막 두 샘플의 속도로 전진, maxExtrapolationMs에서 중단 (정지)
      const prev = this.buf.length >= 2 ? this.buf[this.buf.length - 2]! : null;
      const elapsed = Math.min(renderTime - newest.time, this.maxExtrapolationMs);
      if (!prev || elapsed <= 0) return newest;
      const span = newest.time - prev.time;
      if (span <= 0) return newest;
      const vx = (newest.x - prev.x) / span;
      const vy = (newest.y - prev.y) / span;
      return { ...newest, x: newest.x + vx * elapsed, y: newest.y + vy * elapsed };
    }

    // 보간: renderTime을 감싸는 두 샘플 탐색
    for (let i = this.buf.length - 1; i >= 1; i--) {
      const a = this.buf[i - 1]!;
      const b = this.buf[i]!;
      if (a.time <= renderTime && renderTime <= b.time) {
        const t = (renderTime - a.time) / (b.time - a.time);
        return {
          ...b, // path/mass/alive 등 이산 필드는 최신 샘플 기준
          time: renderTime,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          angle: wrapAngle(a.angle + wrapAngle(b.angle - a.angle) * t),
        };
      }
    }
    return newest;
  }

  size(): number {
    return this.buf.length;
  }
}
