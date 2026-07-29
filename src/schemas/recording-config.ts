import { z } from 'zod';

/**
 * Validation for `devices.recording_config` (offline recording plan, Phase 5 /
 * D7) — the README `recording` settings shape as accepted by PUT /devices/{id}
 * and delivered verbatim to the device as retained MQTT config.
 *
 * Mirrors the device agent's own validation (device
 * `src/daemon/settings.ts` parseRecordingSettings + `src/recording/video-presets.ts`)
 * with one deliberate difference in posture: the device CLAMPS out-of-range
 * numbers (forgiving — a bad settings.json must never disable recording), the
 * cloud REJECTS them 4xx (an operator typo should surface in the UI, not
 * silently save a different value). Change the preset table in both places
 * together.
 *
 * Every namespace and field is optional (a partial config is valid and the
 * device merges it over its defaults), but unknown keys are rejected at every
 * level so a misspelled field can't be silently persisted and ignored.
 */

// Closed preset table — MUST match device src/recording/video-presets.ts.
export const VIDEO_PRESET_NAMES = [
  '1080p30-4mbps',
  '1080p15-2mbps',
  '720p30-2mbps',
  '720p15-2mbps',
  '720p15-1mbps',
] as const;

export const RECORDING_RATE_HZ_MIN = 1;
export const RECORDING_RATE_HZ_MAX = 20; // IMU native cadence cap
export const RECORDING_SEGMENT_SECONDS_MIN = 10;
export const RECORDING_SEGMENT_SECONDS_MAX = 300;
// Boot power staging (optimize-system-process-cycle plan, Phase 2). The device
// clamps to the same bounds (device src/daemon/settings.ts).
export const BOOT_DEFER_MODES = ['auto', 'always', 'off'] as const;
export const BOOT_DEFER_MAX_SECS_MAX = 600; // recording is the product — never defer past 10 min
export const BOOT_DEFER_MIN_BUDGET_MA_MAX = 10_000;
export const SPAWN_STAGGER_SECS_MAX = 30;
// Runtime undervoltage load shedding (optimize-system-process-cycle plan,
// Phase 3). Bounds match the device's clamps (device src/daemon/settings.ts).
export const SHED_UV_SAMPLES_MIN = 1;
export const SHED_UV_SAMPLES_MAX = 60;
export const SHED_UV_WINDOW_SECS_MIN = 5;
export const SHED_UV_WINDOW_SECS_MAX = 300;
export const SHED_RAIL_VOLTS_MIN = 4.0;
export const SHED_RAIL_LOW_VOLTS_MAX = 5.2;
export const SHED_RAIL_RESTORE_VOLTS_MAX = 5.4;
export const SHED_RAIL_LOW_SECS_MIN = 3;
export const SHED_RAIL_LOW_SECS_MAX = 120;
export const SHED_ESCALATE_DWELL_SECS_MIN = 5;
export const SHED_ESCALATE_DWELL_SECS_MAX = 600;
export const SHED_RESTORE_SECS_MIN = 10;
export const SHED_RESTORE_SECS_MAX = 3600;
export const SHED_MAX_SHEDS_PER_HOUR_MAX = 60;
// Retention sanity bounds: at least one video segment's worth of quota, at
// most far beyond any current device disk (the device additionally enforces
// its own free-space floor).
export const RETENTION_MAX_BYTES_MIN = 512 * 1024 ** 2; // 512 MiB
export const RETENTION_MAX_BYTES_MAX = 1024 ** 4; // 1 TiB
export const RETENTION_MIN_FREE_BYTES_MAX = 64 * 1024 ** 3; // 64 GiB

export const recordingConfigSchema = z
  .object({
    telemetry: z
      .object({
        enabled: z.boolean().optional(),
        rateHz: z
          .number()
          .int()
          .min(RECORDING_RATE_HZ_MIN)
          .max(RECORDING_RATE_HZ_MAX)
          .optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        enabled: z.boolean().optional(),
        preset: z.enum(VIDEO_PRESET_NAMES).optional(),
        segmentSeconds: z
          .number()
          .int()
          .min(RECORDING_SEGMENT_SECONDS_MIN)
          .max(RECORDING_SEGMENT_SECONDS_MAX)
          .optional(),
        // Boot power staging knobs (Phase 2): defer heavy encoders at boot
        // until the modem settles. bootDeferMaxSecs 0 = feature off.
        bootDefer: z.enum(BOOT_DEFER_MODES).optional(),
        bootDeferMaxSecs: z.number().int().min(0).max(BOOT_DEFER_MAX_SECS_MAX).optional(),
        bootDeferMinBudgetMa: z
          .number()
          .int()
          .min(0)
          .max(BOOT_DEFER_MIN_BUDGET_MA_MAX)
          .optional(),
        spawnStaggerSecs: z.number().int().min(0).max(SPAWN_STAGGER_SECS_MAX).optional(),
      })
      .strict()
      .optional(),
    upload: z
      .object({ mode: z.enum(['auto', 'off']).optional() })
      .strict()
      .optional(),
    // Runtime undervoltage load shedding (Phase 3): live streaming sheds
    // first, recording last, restore with hysteresis. All Q4 starting values
    // are cloud-tunable so the Phase 5 field loop needs no redeploy.
    powerShedding: z
      .object({
        enabled: z.boolean().optional(),
        uvSamples: z.number().int().min(SHED_UV_SAMPLES_MIN).max(SHED_UV_SAMPLES_MAX).optional(),
        uvWindowSecs: z
          .number()
          .int()
          .min(SHED_UV_WINDOW_SECS_MIN)
          .max(SHED_UV_WINDOW_SECS_MAX)
          .optional(),
        railLowVolts: z.number().min(SHED_RAIL_VOLTS_MIN).max(SHED_RAIL_LOW_VOLTS_MAX).optional(),
        railLowSecs: z
          .number()
          .int()
          .min(SHED_RAIL_LOW_SECS_MIN)
          .max(SHED_RAIL_LOW_SECS_MAX)
          .optional(),
        escalateDwellSecs: z
          .number()
          .int()
          .min(SHED_ESCALATE_DWELL_SECS_MIN)
          .max(SHED_ESCALATE_DWELL_SECS_MAX)
          .optional(),
        restoreSecs: z
          .number()
          .int()
          .min(SHED_RESTORE_SECS_MIN)
          .max(SHED_RESTORE_SECS_MAX)
          .optional(),
        railRestoreVolts: z
          .number()
          .min(SHED_RAIL_VOLTS_MIN)
          .max(SHED_RAIL_RESTORE_VOLTS_MAX)
          .optional(),
        maxShedsPerHour: z.number().int().min(0).max(SHED_MAX_SHEDS_PER_HOUR_MAX).optional(),
      })
      .strict()
      .optional(),
    retention: z
      .object({
        maxBytes: z
          .number()
          .int()
          .min(RETENTION_MAX_BYTES_MIN)
          .max(RETENTION_MAX_BYTES_MAX)
          .optional(),
        minFreeBytes: z
          .number()
          .int()
          .min(0)
          .max(RETENTION_MIN_FREE_BYTES_MAX)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RecordingConfig = z.infer<typeof recordingConfigSchema>;

/**
 * Parse a PUT body's `recordingConfig` value. `null` clears the column (cloud
 * stops managing recording; the device keeps whatever it has locally).
 * Returns `{ error }` with a human-readable message for the 400 response.
 */
export function parseRecordingConfigBody(
  v: unknown,
): { value: RecordingConfig | null } | { error: string } {
  if (v === null) return { value: null };
  const parsed = recordingConfigSchema.safeParse(v);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `recordingConfig.${issue.path.join('.')}` : 'recordingConfig';
    return { error: `${path}: ${issue?.message ?? 'invalid'}` };
  }
  return { value: parsed.data };
}
