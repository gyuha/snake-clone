import type { LeaderboardMessage, ResultMessage } from '@serpent/protocol';

/**
 * Phaser ↔ React 브리지 (PRD §10.1) — 게임 상태 전체가 아니라
 * 낮은 빈도의 이벤트만 넘긴다. React는 리더보드/결과/상태 표시를 담당.
 */
export interface GameBridge {
  /** Phaser → React */
  onLeaderboard(lb: LeaderboardMessage): void;
  onResult(result: ResultMessage | null): void;
  onStatus(status: string): void;
  onHud(hud: { score: number; length: number; kills: number; rttMs: number | null }): void;

  /** React → Phaser (씬이 채운다) */
  requestRespawn?: () => void;
  leaveGame?: () => void;
}
