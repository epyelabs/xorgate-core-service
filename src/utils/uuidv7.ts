import { randomBytes } from 'node:crypto';

/**
 * A time-ordered RFC 9562 version-7 UUID: a 48-bit Unix-millisecond timestamp,
 * the version and variant bits, and 74 random bits. The device agent mints its
 * session ids the same way; core had no helper until the webhook outbox needed
 * one (its ids sort by creation, and are the envelope `id` consumers dedupe on).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(nowMs, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
