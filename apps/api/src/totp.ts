import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(secret: string): Buffer | null {
  const normalized = secret.toUpperCase().replace(/[\s=-]/g, '');
  if (normalized.length < 16) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length > 0 ? Buffer.from(bytes) : null;
}

/** RFC 6238 SHA-1 / 30초 / 6자리 TOTP. 비밀은 base32 환경 변수로만 받는다. */
export function totpCode(secret: string, timestampMs: number): string | null {
  const key = decodeBase32(secret);
  if (!key || !Number.isFinite(timestampMs)) return null;
  const counter = Math.floor(timestampMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(value % 1_000_000).padStart(6, '0');
}

/** 시계 오차 ±1 step을 허용하되 비교는 timing-safe로 수행한다. */
export function verifyTotp(secret: string, candidate: unknown, timestampMs: number): boolean {
  if (typeof candidate !== 'string' || !/^\d{6}$/.test(candidate)) return false;
  const actual = Buffer.from(candidate);
  for (const offset of [-30_000, 0, 30_000]) {
    const expected = totpCode(secret, timestampMs + offset);
    if (expected && timingSafeEqual(actual, Buffer.from(expected))) return true;
  }
  return false;
}
