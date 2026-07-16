import { createGameConfig } from '@serpent/config';
import { normalizeDirection, stepSnakeMovement, type MovementState } from '@serpent/game-core';
import type { PlayerSnapshot } from '@serpent/protocol';
import { describe, expect, it } from 'vitest';
import { Predictor, type PendingInput } from './prediction';

const config = createGameConfig();

function spawnSnapshot(): PlayerSnapshot {
  return {
    id: 'me',
    alive: true,
    x: 1000,
    y: 1000,
    angle: 0,
    mass: 50,
    score: 0,
    boosting: false,
    name: 'p',
    skinId: 0,
    path: [{ x: 999, y: 1000 }],
  };
}

/** 서버 권위 시뮬레이션의 등가물: 같은 입력 시퀀스를 같은 함수로 적분 */
function serverStateAfter(inputs: PendingInput[]): MovementState {
  const s: MovementState = {
    head: { x: 1000, y: 1000 },
    angle: 0,
    mass: 50,
    boosting: false,
    path: [{ x: 999, y: 1000 }],
  };
  for (const i of inputs) {
    stepSnakeMovement(
      s,
      { dir: normalizeDirection({ x: i.dirX, y: i.dirY }), boost: i.boost },
      config,
      true,
    );
  }
  return s;
}

function makeInputs(count: number): PendingInput[] {
  return Array.from({ length: count }, (_, k) => ({
    seq: k + 1,
    dirX: Math.cos(k / 5),
    dirY: Math.sin(k / 5),
    boost: k % 3 === 0,
  }));
}

function toSnapshot(s: MovementState): PlayerSnapshot {
  return {
    id: 'me',
    alive: true,
    x: s.head.x,
    y: s.head.y,
    angle: s.angle,
    mass: s.mass,
    score: 0,
    boosting: s.boosting,
    name: 'p',
    skinId: 0,
    path: s.path.map((p) => ({ ...p })),
  };
}

describe('Predictor — 서브틱 렌더 보간 (머리 튐 방지)', () => {
  it('입력 틱 사이 렌더 위치가 prevHead→head를 알파로 보간한다', () => {
    const predictor = new Predictor(config);
    predictor.reset(spawnSnapshot());
    // angle 0, dir (1,0) → 한 틱에 +9u 직진
    predictor.applyInput({ seq: 1, dirX: 1, dirY: 0, boost: false });

    const p0 = predictor.renderHead(0, 0)!; // 틱 시작 직후 프레임
    const p5 = predictor.renderHead(0, 0.5)!; // 틱 중간 프레임
    const p1 = predictor.renderHead(0, 1)!; // 틱 종료 직전 프레임

    const dt = config.simulation.fixedDeltaMs / 1000;
    expect(p1.x - p0.x).toBeCloseTo(config.snake.baseSpeed * dt, 6); // 9u 전진
    expect(p5.x).toBeCloseTo((p0.x + p1.x) / 2, 6); // 중간값 — 정지·점프 없음
    expect(p0.x).toBeCloseTo(1000, 6); // prevHead = 틱 이전 위치
  });

  it('reconcile 직후에도 보간 기준이 이어져 렌더 위치가 점프하지 않는다', () => {
    const predictor = new Predictor(config);
    predictor.reset(spawnSnapshot());
    const inputs = makeInputs(6);
    for (const i of inputs) predictor.applyInput(i);
    const before = predictor.renderHead(0, 0.5)!;

    const server = serverStateAfter(inputs.slice(0, 3));
    predictor.reconcile(toSnapshot(server), 3);
    const after = predictor.renderHead(0, 0.5)!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
  });
});

describe('Predictor — reconciliation (PRD §9.5)', () => {
  it('ack 이후 미확인 입력을 재적용하면 서버와 동일한 전체 시퀀스 결과가 된다', () => {
    const predictor = new Predictor(config);
    predictor.reset(spawnSnapshot());

    const inputs = makeInputs(10);
    for (const i of inputs) predictor.applyInput(i);

    // 서버는 seq 4까지 반영한 상태를 보내온다
    const serverAt4 = serverStateAfter(inputs.slice(0, 4));
    predictor.reconcile(toSnapshot(serverAt4), 4);

    // 재적용 결과 == 서버가 10개 전부 처리했을 상태 (오차 0)
    const serverAt10 = serverStateAfter(inputs);
    expect(predictor.state!.head.x).toBeCloseTo(serverAt10.head.x, 10);
    expect(predictor.state!.head.y).toBeCloseTo(serverAt10.head.y, 10);
    expect(predictor.state!.angle).toBeCloseTo(serverAt10.angle, 10);
    expect(predictor.state!.mass).toBeCloseTo(serverAt10.mass, 10);
    expect(predictor.pendingCount()).toBe(6);
  });

  it('보정 점프는 렌더 오프셋으로 흡수되어 순간이동하지 않고 감쇠한다', () => {
    const predictor = new Predictor(config);
    predictor.reset(spawnSnapshot());
    const inputs = makeInputs(6);
    for (const i of inputs) predictor.applyInput(i);
    const renderBefore = predictor.renderHead(0)!;

    // 서버가 예측과 40 유닛 어긋난 위치를 통보 (패킷 손실 등)
    const shifted = serverStateAfter(inputs.slice(0, 3));
    shifted.head = { x: shifted.head.x + 40, y: shifted.head.y };
    predictor.reconcile(toSnapshot(shifted), 6); // 전부 ack → 재적용 없음

    // 직후 렌더 위치는 이전 렌더 위치와 거의 같다 (스냅 없음)
    const renderAfter = predictor.renderHead(0)!;
    const jump = Math.hypot(renderAfter.x - renderBefore.x, renderAfter.y - renderBefore.y);
    expect(jump).toBeLessThan(1);
    expect(predictor.correctionDistance()).toBeGreaterThan(10);

    // 500ms 경과 시 오프셋이 충분히 감쇠해 서버 위치로 수렴
    predictor.renderHead(500);
    expect(predictor.correctionDistance()).toBeLessThan(5);
  });

  it('비정상적으로 큰 오차(리스폰 등)는 스냅한다', () => {
    const predictor = new Predictor(config);
    predictor.reset(spawnSnapshot());
    predictor.applyInput(makeInputs(1)[0]!);

    const far = spawnSnapshot();
    far.x = 5000;
    far.y = 5000;
    predictor.reconcile(far, 1);
    expect(predictor.correctionDistance()).toBe(0);
  });
});
