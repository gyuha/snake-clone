/** HUD 점수 표기 — 천 단위 구분 (PRD §7.2) */
export function formatScore(score: number): string {
  return Math.max(0, Math.floor(score)).toLocaleString('en-US');
}
