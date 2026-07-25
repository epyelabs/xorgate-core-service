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
      })
      .strict()
      .optional(),
    upload: z
      .object({ mode: z.enum(['auto', 'off']).optional() })
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
