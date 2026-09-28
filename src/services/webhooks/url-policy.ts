import { isIP } from 'node:net';

/**
 * Endpoint URL policy, applied when an endpoint is created or its URL changes
 * (README §6, an SSRF guard):
 *
 * - `https:` only;
 * - no user-info (`user:pass@host`);
 * - not `localhost` / `*.localhost`;
 * - not a literal IP in a private, loopback, link-local (incl. the
 *   169.254.169.254 metadata address), CGNAT, unspecified or multicast range,
 *   v4 or v6 (incl. v4-mapped v6).
 *
 * A hostname that RESOLVES to a private address is not caught here (no DNS at
 * create time; rebinding would defeat it anyway). The deliver Lambda is not in
 * a VPC, so the reachable private surface is the Lambda's own, and delivery
 * never follows redirects (a 3xx is a failure).
 *
 * Returns the problem, or null when the URL is acceptable.
 */
export function endpointUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return 'url is required';
  if (raw.length > 2048) return 'url must be at most 2048 characters';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'url is not a valid URL';
  }
  if (u.protocol !== 'https:') return 'url must use https://';
  if (u.username || u.password) return 'url must not contain credentials (user:pass@)';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'url must not point at localhost';
  const kind = isIP(host);
  if (kind === 4 && isBlockedIPv4(host)) return 'url must not point at a private, loopback or link-local address';
  if (kind === 6 && isBlockedIPv6(host)) return 'url must not point at a private, loopback or link-local address';
  return null;
}

function v4Octets(ip: string): number[] {
  return ip.split('.').map((p) => Number(p));
}

export function isBlockedIPv4(ip: string): boolean {
  const [a, b] = v4Octets(ip);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. instance metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF + 192.0.2.0/24 docs
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast + reserved + broadcast
  );
}

export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // v4-mapped / v4-compatible: judge the embedded v4 address.
  const mapped = lower.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  // URL normalises ::ffff:10.0.0.1 to ::ffff:a00:1; decode that form too.
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // multicast
  );
}
