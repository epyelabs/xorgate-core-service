import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `lteRecovery` namespace (lte_gnss_recovery plan, R8) — how aggressively
 * the device's connection manager may use the GNSS-destructive modem reset.
 *
 * Read LIVE by the sim7600-lte daemon out of settings.json at each recovery
 * decision, so a change applies with no restart — and the daemon must NEVER be
 * restarted to apply one (that drops LTE). Mirrors the device agent's
 * parseLteRecoverySettings; the cloud rejects unknown keys/values 4xx while the
 * device drops them silently. Keep the enums in sync with the daemon's preset
 * bundles (`deadzone_profile_params` in modem/sim7600-lte.sh).
 */
export const lteRecoveryConfigSchema = z
  .object({
    gpsFixResetPolicy: z
      .enum(['defer', 'veto-deadzone'])
      .describe(
        'With a live GPS fix: "defer" (default) allows a modem reset only after 30+ min of ' +
          'unusable LTE; "veto-deadzone" additionally never resets while parked in a dead zone.',
      )
      .optional(),
    deadZoneProfile: z
      .enum(['conservative', 'balanced', 'aggressive'])
      .describe(
        'Dead-zone recovery pacing: conservative (nudge every 15-120 min, never resets), ' +
          'balanced (default; 10-60 min, reset only after 3 failed radio cycles), aggressive ' +
          '(10-20 min, reset after 1 failed cycle).',
      )
      .optional(),
  })
  .strict();

export type LteRecoveryConfig = z.infer<typeof lteRecoveryConfigSchema>;

/** Device/daemon defaults when the namespace is absent (modem/sim7600-lte.sh). */
export const LTE_RECOVERY_DEFAULTS = {
  gpsFixResetPolicy: 'defer',
  deadZoneProfile: 'balanced',
} as const;

export const lteRecoveryNamespace: ConfigNamespaceSpec<LteRecoveryConfig> = {
  key: 'lteRecovery',
  title: 'LteRecoveryConfig',
  description:
    'LTE recovery policy (`lteRecovery` namespace): how aggressively the device connection ' +
    'manager may use the GNSS-destructive full modem reset. Both fields optional; omitted ' +
    'fields fall back to the device defaults. Read live by the modem daemon at its next ' +
    'recovery decision — no device restart.',
  schema: lteRecoveryConfigSchema,
  defaults: LTE_RECOVERY_DEFAULTS,
  applyClass: 'modem-poll',
  legacyColumn: 'lteRecoveryConfig',
  legacyPutField: 'lteRecoveryConfig',
  kind: 'object',
};
