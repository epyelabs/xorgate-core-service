/**
 * Echoing input in a message.
 *
 * Validation messages quote what was sent. What was sent is untrusted: it can
 * be megabytes long, hold control characters, or not be a string at all. So
 * every echoed value or key goes through `shown`.
 */

/**
 * Cut a string short, so a blob cannot flood a 400 or a log line. Never
 * leaves half a surrogate pair at the cut.
 */
export function clip(text: string, max = 60): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}...`;
}

/**
 * A sent value OR key, as JSON, for a message: strings quoted with control
 * characters escaped, everything cut short. Never throws.
 */
export function shown(value: unknown): string {
  // JSON has no NaN/Infinity (they print as "null", which would mislead).
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  try {
    return clip(JSON.stringify(value) ?? String(value));
  } catch {
    // A cycle, a BigInt, a throwing toJSON.
    try {
      return clip(String(value));
    } catch {
      return '(unprintable)';
    }
  }
}
