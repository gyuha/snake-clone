/** 닉네임 정책 (FR-PROF-01): 길이·문자 집합·금칙어 */

const MIN = 2;
const MAX = 16;
const ALLOWED = /^[A-Za-z0-9가-힣_-]+$/;

/** 최소 보호 목록. 운영 목록은 이 목록에 추가되며 기본 보호를 제거할 수 없다. */
export const DEFAULT_BANNED_WORDS = ['admin', 'administrator', 'moderator', 'system', '운영자', '관리자'];

export type NicknameResult = { ok: true; normalized: string } | { ok: false; error: string };

/** 쉼표/줄바꿈 기반 환경 설정을 정규화한다. 빈·과도한 항목은 무시한다. */
export function parseBannedWords(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[\n,]/).map((word) => word.trim().toLowerCase()).filter((word) => word.length >= 2 && word.length <= 32))];
}

export function validateNickname(raw: unknown, additionalBannedWords: readonly string[] = []): NicknameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_type' };
  const trimmed = raw.trim();
  if (trimmed.length < MIN || trimmed.length > MAX) return { ok: false, error: 'invalid_length' };
  if (!ALLOWED.test(trimmed)) return { ok: false, error: 'invalid_charset' };
  const normalized = trimmed.toLowerCase();
  for (const banned of [...DEFAULT_BANNED_WORDS, ...additionalBannedWords]) {
    if (normalized.includes(banned.toLowerCase())) return { ok: false, error: 'banned_word' };
  }
  return { ok: true, normalized: trimmed };
}
