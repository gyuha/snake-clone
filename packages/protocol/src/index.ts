/**
 * protocol — 클라이언트/서버 공유 메시지 스키마와 런타임 검증 (PRD §11.4~11.5).
 * 클라이언트와 서버는 반드시 이 패키지의 단일 정의를 공유한다
 * (부록 E: 중복 프로토콜 정의 금지).
 *
 * 원칙:
 * - 클라이언트는 seq/방향/부스트만 보낸다. 좌표·점수·길이는 스키마에 존재하지 않으며
 *   서버 검증기는 알 수 없는 필드를 절대 복사하지 않는다 (§11.5).
 * - input은 드롭 가능·최신 우선, death/result/config는 신뢰성 전달 (§11.5).
 */

export const PROTOCOL_VERSION = 1;

/** Colyseus 메시지 채널 이름 */
export const MSG = {
  input: 'input',
  welcome: 'welcome',
  snapshot: 'snapshot',
  event: 'event',
  respawn: 'respawn',
  result: 'result',
  ping: 'ping',
  pong: 'pong',
  resync: 'resync',
  leaderboard: 'leaderboard',
} as const;

export type MessageName = (typeof MSG)[keyof typeof MSG];

// ---------------------------------------------------------------------------
// C → S
// ---------------------------------------------------------------------------

/** 입력 메시지 — 의도만 전송 (PRD §9.8.2) */
export interface InputMessage {
  /** 단조 증가 시퀀스 (uint) */
  seq: number;
  /** 입력 생성 시각(ms). 서버 판정에는 사용하지 않고 지연 진단에만 쓴다. */
  clientTime?: number;
  dirX: number;
  dirY: number;
  boost: boolean;
}

/**
 * 입력 메시지 런타임 검증 (PRD §14.2).
 * - seq: 0 이상의 유한 정수
 * - dirX/dirY: 유한수 (정규화는 시뮬레이션에서)
 * - boost: boolean
 * 알 수 없는 필드(x, y, score, length 등)는 결과 객체에 복사되지 않는다.
 * 위반 시 null (메시지 폐기).
 */
export function validateInputMessage(raw: unknown): InputMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const { seq, clientTime, dirX, dirY, boost } = m;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) return null;
  if (typeof dirX !== 'number' || !Number.isFinite(dirX)) return null;
  if (typeof dirY !== 'number' || !Number.isFinite(dirY)) return null;
  if (typeof boost !== 'boolean') return null;
  // 이전 JSON 클라이언트와의 짧은 호환 기간에는 누락을 허용하되, 유효하지 않은
  // timestamp는 조용히 버려 서버의 시간 판단에 영향을 주지 않게 한다.
  if (clientTime !== undefined && (typeof clientTime !== 'number' || !Number.isFinite(clientTime))) return null;
  return { seq, ...(clientTime === undefined ? {} : { clientTime }), dirX, dirY, boost };
}

/** RTT/offset 추정용 핑 (PRD §9.5 Clock sync, 1~2Hz) */
export interface PingMessage {
  nonce: number;
  clientTime: number;
}

/** baseline 불일치/유실 시 재동기화 요청 (PRD §11.4 resync) */
export interface ResyncMessage {
  lastGoodTickId: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// S → C
// ---------------------------------------------------------------------------

/** 핑 응답 — 클라이언트 에코 + 서버 시각 */
export interface PongMessage {
  nonce: number;
  clientTime: number;
  serverTime: number;
}

export interface PlayerSnapshot {
  id: string;
  alive: boolean;
  x: number;
  y: number;
  angle: number;
  mass: number;
  score: number;
  boosting: boolean;
  /** 표시 이름 (로비 닉네임 — 서버가 길이 제한 후 반사) */
  name: string;
  /** 코스메틱 스킨 (FR-COS-01 — 모든 클라이언트에 표시) */
  skinId: number;
  /** 몸통 복원용 경로 키포인트 (M2 전체 전송 — M4에서 델타화) */
  path: { x: number; y: number }[];
}

export interface PelletSnapshot {
  id: number;
  x: number;
  y: number;
  value: number;
}

/** 최초 입장/재입장 기준 상태 (PRD §11.4 welcome) */
export interface WelcomeMessage {
  protocolVersion: number;
  playerId: string;
  roomId: string;
  configVersion: string;
  tickRate: number;
  snapshotRate: number;
  serverTime: number;
  tickId: number;
  arena: { width: number; height: number };
  players: PlayerSnapshot[];
  pellets: PelletSnapshot[];
}

/** AOI 내 뱀의 주기 델타 (PRD §9.8.5 — 전체 경로 대신 신규 키포인트만) */
export interface SnakeDelta {
  id: string;
  alive: boolean;
  x: number;
  y: number;
  angle: number;
  mass: number;
  score: number;
  boosting: boolean;
  /** 지난 snapshot 이후 추가된 경로 키포인트 (front 순서) */
  newPathNodes: { x: number; y: number }[];
}

/** AOI 진입 엔터티의 기준 상태 (PRD §11.6 aoi_enter) */
export type AoiEnter =
  | { type: 'snake'; snake: PlayerSnapshot }
  | { type: 'pelletChunk'; chunkId: string; pellets: PelletSnapshot[] };

/** AOI 이탈 (PRD §11.6 aoi_leave) */
export type AoiLeave = { type: 'snake'; id: string } | { type: 'pelletChunk'; chunkId: string };

/** 구독 중 청크의 펠릿 증분 (PRD §11.6 pellet_batch) */
export interface PelletChunkUpdate {
  chunkId: string;
  created: PelletSnapshot[];
  removed: number[];
}

/**
 * 주기 상태 (M4: AOI 필터링 + 델타).
 * snakes에는 관심 영역 내(구독 중) 뱀만 실린다 — 밖의 뱀은 전송 자체가 없다.
 * enter/leave/pellet_batch는 경계마다 이 메시지에 동봉된다 (순서 보장).
 */
export interface SnapshotMessage {
  tickId: number;
  serverTime: number;
  /** 수신 클라이언트의 마지막 처리 입력 seq (reconciliation 기준) */
  lastAckInputSeq: number;
  snakes: SnakeDelta[];
  enters: AoiEnter[];
  leaves: AoiLeave[];
  pelletChunks: PelletChunkUpdate[];
}

/** 신뢰성 이벤트 (PRD §11.5 — 순서/전달 보장 필요) */
export type EventMessage =
  | {
      type: 'death';
      tickId: number;
      snakeId: string;
      cause: 'boundary' | 'body' | 'head' | 'disconnect';
      killerId?: string;
    }
  | {
      /** body 충돌로 확정된 처치 — death와 같은 tick에 신뢰성 있게 전송한다. */
      type: 'kill';
      tickId: number;
      killerId: string;
      victimId: string;
    }
  | {
      /** 운영/유지보수 안내. gameplay 판정과 분리된 신뢰성 UI 이벤트다. */
      type: 'notice';
      tickId: number;
      level: 'info' | 'warning';
      message: string;
    }
  | { type: 'spawn'; tickId: number; snakeId: string; x: number; y: number };

/** 방 내 리더보드 — 4Hz 이하 (PRD §5.2 Leaderboard, FR-RANK-01) */
export interface LeaderboardMessage {
  entries: { id: string; name: string; score: number }[];
  selfRank: number;
  totalPlayers: number;
}

/** 사망 후 결과 (PRD §11.4 result) */
export interface ResultMessage {
  /** 이번 생 단위의 안정 식별자 — 화면 추적과 결과 저장 멱등성에 공통 사용한다. */
  matchId: string;
  rank: number;
  score: number;
  length: number;
  survivalMs: number;
  kills: number;
  reason: string;
}
