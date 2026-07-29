import { z } from 'zod';

/**
 * Validation for `devices.time_sync_config` (optimize-system-process-cycle
 * plan, Phase 4) — the offline time-sources policy as accepted by PUT
 * /devices/{id} and delivered verbatim to the device as retained MQTT config
 * (`timeSync` key). The device agent's clock stepper re-reads settings.json
 * each tick (~30 s), so a cloud change applies live without a restart.
 *
 * Mirrors the device agent's parseTimeSyncSettings (device
 * `src/daemon/settings.ts`); the cloud rejects out-of-range values 4xx (an
 * operator typo should surface in the UI) while the device clamps them
 * silently. Keep bounds in both places in sync.
 */
export const timeSyncConfigSchema = z
  .object({
    /**
     * Kill switch (Q5): false disables GPS/NITZ clock stepping entirely.
     * Default on the device is ON; the stepper additionally self-disarms
     * every boot once NTP has synchronized.
     */
    offlineSources: z.boolean().optional(),
    /** Step only when |clock offset| exceeds this many seconds (device default 10). */
    stepThresholdSecs: z.number().int().min(2).max(600).optional(),
    /** Hard cap on clock steps per boot (device default 4). */
    maxStepsPerBoot: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type TimeSyncConfig = z.infer<typeof timeSyncConfigSchema>;

/**
 * Parse a PUT body's `timeSyncConfig` value. `null` clears the column (cloud
 * stops managing the policy; the device falls back to its defaults on the
 * next retained delivery). Returns `{ error }` with a human-readable message
 * for the 400 response.
 */
export function parseTimeSyncConfigBody(
  v: unknown,
): { value: TimeSyncConfig | null } | { error: string } {
  if (v === null) return { value: null };
  const parsed = timeSyncConfigSchema.safeParse(v);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length
      ? `timeSyncConfig.${issue.path.join('.')}`
      : 'timeSyncConfig';
    return { error: `${path}: ${issue?.message ?? 'invalid'}` };
  }
  return { value: parsed.data };
}
