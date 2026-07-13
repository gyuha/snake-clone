import { createGameConfig } from '@serpent/config';
import { Rng, Simulation } from '@serpent/game-core';
import type { PlayerSnapshot } from '@serpent/protocol';
import { describe, expect, it } from 'vitest';
import { RemoteInterpolator } from './interpolation';
import { Predictor, type PendingInput } from './prediction';

/**
 * 네트워크 에뮬레이션 (loop.md C3, PRD §21.6 L-06/L-10):
 * RTT 100ms(편도 50ms) · jitter 30ms · loss 5%를 가상 시간 위에서 주입하고
 * 예측/reconciliation/보간 파이프라인이 PRD 기준을 지키는지 검증한다.
 * 실제 타이머 없이 시드 기반으로 결정적으로 실행된다.
 */

const ONE_WAY_MS = 50;
const JITTER_MS = 30;
const LOSS_RATE = 0.05;

interface Delivery<T> {
  deliverAt: number;
  msg: T;
}

/** 순서 보존(TCP 유사) + 지연/지터/손실 채널 */
class NetemChannel<T> {
  private queue: Delivery<T>[] = [];
  private lastDeliverAt = 0;

  constructor(private readonly rng: Rng) {}

  send(msg: T, now: number): void {
    if (this.rng.next() < LOSS_RATE) return; // 손실
    const jitter = (this.rng.next() * 2 - 1) * JITTER_MS;
    let deliverAt = now + Math.max(1, ONE_WAY_MS + jitter);
    if (deliverAt < this.lastDeliverAt) deliverAt = this.lastDeliverAt; // 순서 보존
    this.lastDeliverAt = deliverAt;
    this.queue.push({ deliverAt, msg });
  }

  receive(now: number): T[] {
    const out: T[] = [];
    while (this.queue.length > 0 && this.queue[0]!.deliverAt <= now) {
      out.push(this.queue.shift()!.msg);
    }
    return out;
  }
}

const config = createGameConfig({
  arena: { width: 50000, height: 50000, boundary: 'lethal' },
  pellets: { targetCount: 0, chunkSync: true, respawnBudgetPerTick: 0, baseValue: 1, radius: 6 },
});

function toSnapshot(sim: Simulation, id: string): PlayerSnapshot {
  const s = sim.snakes.get(id)!;
  return {
    id: s.id,
    alive: s.alive,
    x: s.head.x,
    y: s.head.y,
    angle: s.angle,
    mass: s.mass,
    score: s.score,
    boosting: s.boosting,
    name: 'p',
    skinId: 0,
    path: s.path.map((p) => ({ x: p.x, y: p.y })),
  };
}

describe('netem — 예측/reconciliation (RTT 100ms · jitter 30ms · loss 5%)', () => {
  it('보정 거리 P95가 캐릭터 반경의 0.5배 이하이고 렌더가 순간이동하지 않는다 (NFR-LAT-02)', () => {
    const rng = new Rng(777);
    const c2s = new NetemChannel<PendingInput>(rng);
    const s2c = new NetemChannel<{ snap: PlayerSnapshot; tick: number }>(rng);

    const server = new Simulation(config, 1);
    const spawn = server.addSnake('p');
    spawn.head = { x: 25000, y: 25000 };
    spawn.angle = 0;
    spawn.mass = 100;
    spawn.path = [{ x: 24999, y: 25000 }];

    const predictor = new Predictor(config);
    predictor.reset(toSnapshot(server, 'p'));

    let seq = 0;
    let serverAck = 0;
    const corrections: number[] = [];
    const renderSteps: number[] = [];
    let prevRender: { x: number; y: number } | null = null;

    const STEP = config.simulation.fixedDeltaMs; // 50ms
    const TICKS = 600; // 30초 시뮬 시간

    for (let t = 0; t < TICKS; t++) {
      const now = t * STEP;

      // 클라이언트 틱: 부드럽게 도는 조향 입력을 즉시 예측 + 전송
      const input: PendingInput = {
        seq: ++seq,
        dirX: Math.cos(t / 40),
        dirY: Math.sin(t / 40),
        boost: false,
      };
      predictor.applyInput(input);
      c2s.send(input, now);

      // 서버 틱: 도착한 입력 중 최신(seq 단조)만 반영
      for (const msg of c2s.receive(now)) {
        if (msg.seq <= serverAck) continue;
        serverAck = msg.seq;
        server.setInput('p', { dirX: msg.dirX, dirY: msg.dirY, boost: msg.boost });
      }
      server.step();

      // 10Hz snapshot 전송 (틱 정렬 reconciliation의 기준 tickId 포함)
      if (t % 2 === 0) {
        s2c.send({ snap: toSnapshot(server, 'p'), tick: server.tickId }, now);
      }

      // 클라이언트 수신 → reconciliation
      for (const { snap, tick } of s2c.receive(now)) {
        predictor.reconcile(snap, tick);
        corrections.push(predictor.correctionDistance());
      }

      // 렌더 프레임(50ms 간격으로 근사) — 스무딩된 렌더 위치 연속성 측정
      const rh = predictor.renderHead(STEP)!;
      if (prevRender) {
        renderSteps.push(Math.hypot(rh.x - prevRender.x, rh.y - prevRender.y));
      }
      prevRender = { x: rh.x, y: rh.y };
    }

    // 워밍업(첫 1초) 이후 보정 거리 P95 ≤ headRadius × 0.5 = 6 (NFR-LAT-02)
    const settled = corrections.slice(10);
    expect(settled.length).toBeGreaterThan(100);
    const sorted = [...settled].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(p95).toBeLessThanOrEqual(config.snake.headRadius * 0.5);

    // 렌더 순간이동 없음: 프레임당 이동이 1.5× 기본 속도 스텝(9u) 이내
    const maxStep = Math.max(...renderSteps);
    expect(maxStep).toBeLessThanOrEqual(config.snake.baseSpeed * (STEP / 1000) * 1.5);
  });

  it('전송 중단 후 모든 입력이 ack되면 예측 상태가 서버와 정확히 일치한다', () => {
    const rng = new Rng(999);
    const c2s = new NetemChannel<PendingInput>(rng);

    const server = new Simulation(config, 2);
    const spawn = server.addSnake('p');
    spawn.head = { x: 25000, y: 25000 };
    spawn.angle = 0;
    spawn.path = [{ x: 24999, y: 25000 }];

    const predictor = new Predictor(config);
    predictor.reset(toSnapshot(server, 'p'));

    let seq = 0;
    let serverAck = 0;
    const STEP = config.simulation.fixedDeltaMs;

    // 200틱 주행
    for (let t = 0; t < 200; t++) {
      const now = t * STEP;
      const input: PendingInput = { seq: ++seq, dirX: Math.cos(t / 25), dirY: Math.sin(t / 25), boost: false };
      predictor.applyInput(input);
      c2s.send(input, now);
      for (const msg of c2s.receive(now)) {
        if (msg.seq <= serverAck) continue;
        serverAck = msg.seq;
        server.setInput('p', { dirX: msg.dirX, dirY: msg.dirY, boost: msg.boost });
      }
      server.step();
    }

    // 전송 중단, 잔여 배달 후 서버 정지 → 최종 스냅샷으로 reconcile
    for (let t = 200; t < 210; t++) {
      const now = t * STEP;
      for (const msg of c2s.receive(now)) {
        if (msg.seq <= serverAck) continue;
        serverAck = msg.seq;
        server.setInput('p', { dirX: msg.dirX, dirY: msg.dirY, boost: msg.boost });
      }
    }
    predictor.reconcile(toSnapshot(server, 'p'), server.tickId); // 전 틱 반영 → 재적용 없음

    const s = server.snakes.get('p')!;
    expect(predictor.state!.head.x).toBeCloseTo(s.head.x, 9);
    expect(predictor.state!.head.y).toBeCloseTo(s.head.y, 9);
    expect(predictor.pendingCount()).toBe(0);
  });
});

describe('netem — 원격 보간 (snapshot 손실/지터)', () => {
  it('블랙아웃 시 200ms 외삽 후 정지하고, 그 외 구간은 연속적으로 움직인다', () => {
    const rng = new Rng(555);
    const interp = new RemoteInterpolator(config.network.maxExtrapolationMs);
    const SNAP_MS = 100; // 10Hz
    const SPEED = 0.18; // 180 u/s = 0.18 u/ms
    const BLACKOUT_START = 3000;
    const BLACKOUT_END = 3600;

    // 등속 이동 타깃의 snapshot 스트림 (블랙아웃 구간은 전량 유실)
    const deliveries: { at: number; time: number; x: number }[] = [];
    for (let st = 0; st <= 6000; st += SNAP_MS) {
      if (st >= BLACKOUT_START && st < BLACKOUT_END) continue;
      if (rng.next() < LOSS_RATE) continue;
      const jitter = (rng.next() * 2 - 1) * JITTER_MS;
      deliveries.push({ at: st + ONE_WAY_MS + jitter, time: st, x: st * SPEED });
    }
    deliveries.sort((a, b) => a.at - b.at);

    // 60fps 렌더 루프
    let di = 0;
    let prevX: number | null = null;
    let plateauX: number | null = null;
    const FRAME = 1000 / 60;
    for (let now = 500; now <= 6000; now += FRAME) {
      while (di < deliveries.length && deliveries[di]!.at <= now) {
        const d = deliveries[di++]!;
        interp.push({ time: d.time, x: d.x, y: 0, angle: 0, mass: 10, boosting: false, alive: true, path: [] });
      }
      const renderTime = now - ONE_WAY_MS - config.network.interpolationDelayMs;
      const s = interp.sample(renderTime);
      if (!s) continue;

      // 정지(plateau) 검증 창: 외삽 상한을 넘겼고, 아직 블랙아웃 이후 샘플이
      // 도착할 수 없는 시각(now < BLACKOUT_END) — 이후 회복 구간은 갭을
      // 가로질러 보간하며 전진하는 것이 정상이므로 제외한다.
      const inPlateauWindow =
        renderTime > BLACKOUT_START - SNAP_MS + config.network.maxExtrapolationMs &&
        now < BLACKOUT_END;
      if (inPlateauWindow) {
        // 외삽 상한 도달 후 정지 (전진 없음)
        if (plateauX === null) plateauX = s.x;
        expect(s.x).toBeLessThanOrEqual(plateauX + 1e-6);
      } else if (prevX !== null && renderTime > 700 && renderTime < BLACKOUT_START - SNAP_MS) {
        // 정상 구간: 프레임당 이동이 속도×프레임의 3배 이내 (순간이동 없음)
        expect(Math.abs(s.x - prevX)).toBeLessThanOrEqual(SPEED * FRAME * 3);
      }
      prevX = s.x;
    }
    expect(plateauX).not.toBeNull(); // 블랙아웃에서 실제로 정지 상태에 도달했음
  });
});
