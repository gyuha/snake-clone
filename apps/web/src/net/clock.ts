/**
 * ClockSync — ping/pong으로 RTT와 서버 시각 offset을 추정한다 (PRD §9.5).
 * offset = serverTime + rtt/2 - clientNow (대칭 지연 가정).
 * 최근 표본 중 RTT가 작은 쪽 절반의 중앙값을 사용해 지터에 강건하게 만든다.
 */
export class ClockSync {
  private nextNonce = 1;
  private pending = new Map<number, number>(); // nonce → sentAt(clientTime)
  private samples: { rtt: number; offset: number }[] = [];

  constructor(private readonly maxSamples = 10) {}

  /** 핑 페이로드 생성 (호출 측이 전송) */
  createPing(clientNow: number): { nonce: number; clientTime: number } {
    const nonce = this.nextNonce++;
    this.pending.set(nonce, clientNow);
    // 응답 없는 오래된 핑 정리
    if (this.pending.size > 8) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    return { nonce, clientTime: clientNow };
  }

  /** pong 수신 처리 */
  onPong(pong: { nonce: number; clientTime: number; serverTime: number }, clientNow: number): void {
    const sentAt = this.pending.get(pong.nonce);
    if (sentAt === undefined) return; // 미지의/중복 nonce 폐기
    this.pending.delete(pong.nonce);
    const rtt = clientNow - sentAt;
    if (rtt < 0) return;
    const offset = pong.serverTime + rtt / 2 - clientNow;
    this.samples.push({ rtt, offset });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  hasEstimate(): boolean {
    return this.samples.length > 0;
  }

  /** 현재 RTT 추정 (低 RTT 절반의 중앙값) */
  rtt(): number {
    return this.best().rtt;
  }

  /** 서버-클라이언트 시각 offset 추정 */
  offset(): number {
    return this.best().offset;
  }

  /** 서버 시각 추정 */
  serverNow(clientNow: number): number {
    return clientNow + this.offset();
  }

  private best(): { rtt: number; offset: number } {
    if (this.samples.length === 0) return { rtt: 0, offset: 0 };
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const half = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    const mid = half[Math.floor(half.length / 2)] ?? half[0]!;
    return mid;
  }
}
