import { z } from 'zod';

/**
 * Validation for `devices.lte_recovery_config` (lte_gnss_recovery plan, R8) —
 * the LTE recovery *policy* knobs as accepted by PUT /devices/{id} and
 * delivered verbatim to the device as retained MQTT config (`lteRecovery`
 * key). The device's sim7600-lte daemon reads settings.json live at each
 * recovery decision, resolving anything missing/unknown to the safe defaults
 * (gpsFixResetPolicy `defer`, deadZoneProfile `balanced`).
 *
 * Mirrors the device agent's parseLteRecoverySettings (device
 * `src/daemon/settings.ts`); the cloud rejects unknown keys/values 4xx (an
 * operator typo should surface in the UI) while the device drops them
 * silently (a bad settings.json must never break recovery). Keep the enums in
 * both places in sync — the daemon's preset bundles are documented at
 * `deadzone_profile_params` in modem/sim7600-lte.sh.
 */
export const lteRecoveryConfigSchema = z
  .object({
    /**
     * What a live GNSS fix means for a modem reset (AT+CRESET destroys GNSS
     * acquisition): `defer` allows one only after LTE has been unusable 30+
     * min; `veto-deadzone` additionally never resets in a dead zone while a
     * fix is held.
     */
    gpsFixResetPolicy: z.enum(['defer', 'veto-deadzone']).optional(),
    /** Dead-zone nudge pacing preset (radio-cycle cadence + reset quota). */
    deadZoneProfile: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
  })
  .strict();

export type LteRecoveryConfig = z.infer<typeof lteRecoveryConfigSchema>;

/**
 * Parse a PUT body's `lteRecoveryConfig` value. `null` clears the column
 * (cloud stops managing the policy; the device falls back to its safe
 * defaults on the next retained delivery). Returns `{ error }` with a
 * human-readable message for the 400 response.
 */
export function parseLteRecoveryConfigBody(
  v: unknown,
): { value: LteRecoveryConfig | null } | { error: string } {
  if (v === null) return { value: null };
  const parsed = lteRecoveryConfigSchema.safeParse(v);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length
      ? `lteRecoveryConfig.${issue.path.join('.')}`
      : 'lteRecoveryConfig';
    return { error: `${path}: ${issue?.message ?? 'invalid'}` };
  }
  return { value: parsed.data };
}
