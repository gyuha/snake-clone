/** 닉네임 정책 (FR-PROF-01): 길이·문자 집합·금칙어 */

const MIN = 2;
const MAX = 16;
const ALLOWED = /^[A-Za-z0-9가-힣_-]+$/;

/** 최소 금칙어 목록 — 운영 설정으로 교체 가능해야 한다 (PRD §16.3 Moderation config) */
const BANNED_WORDS = ['admin', 'administrator', 'moderator', 'system', '운영자', '관리자'];

export type NicknameResult = { ok: true; normalized: string } | { ok: false; error: string };

export function validateNickname(raw: unknown): NicknameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_type' };
  const trimmed = raw.trim();
  if (trimmed.length < MIN || trimmed.length > MAX) return { ok: false, error: 'invalid_length' };
  if (!ALLOWED.test(trimmed)) return { ok: false, error: 'invalid_charset' };
  const normalized = trimmed.toLowerCase();
  for (const banned of BANNED_WORDS) {
    if (normalized.includes(banned)) return { ok: false, error: 'banned_word' };
  }
  return { ok: true, normalized: trimmed };
}
