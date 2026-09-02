/**
 * The pure rules behind the destroy paths, kept free of AWS and database
 * imports so they can be unit-tested and so the handlers that use them read
 * as policy rather than plumbing.
 */

/** The two key prefixes a device uploads under in the core bucket. */
export function deviceStoragePrefixes(deviceId: string): string[] {
  return [`media-sessions/v1/${deviceId}/`, `telemetry/v1/${deviceId}/`];
}

/**
 * Organizations the caller is the ONLY owner of. xorgate allows several
 * owners, so what blocks an account deletion is not "owns something" but "is
 * the last one who could": those organizations must be handed over or deleted
 * first.
 */
export function soleOwnerOrganizationIds(
  own: Array<{ organizationId: string; role: string }>,
  ownersByOrg: Array<{ organizationId: string }>,
): string[] {
  const ownerCount = new Map<string, number>();
  for (const m of ownersByOrg) {
    ownerCount.set(m.organizationId, (ownerCount.get(m.organizationId) ?? 0) + 1);
  }
  return own
    .filter((m) => m.role === 'owner' && (ownerCount.get(m.organizationId) ?? 0) <= 1)
    .map((m) => m.organizationId);
}
