import { randomBytes } from 'node:crypto';

// RFC 4648 base32 alphabet, lowercase. 10 random bytes encode to exactly 16
// base32 chars (no padding) with ~80 bits of entropy. Well above the typical
// 60-bit "unguessable token" bar and resistant to brute-force enumeration
// against the 15-minute unauthenticated /get/:code endpoint.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function generateRegistrationCode(): string {
  return encodeBase32(randomBytes(10));
}

function encodeBase32(buf: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}
