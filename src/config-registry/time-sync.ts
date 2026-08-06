import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `timeSync` namespace (optimize-system-process-cycle plan, Phase 4) —
 * GPS/NITZ clock stepping while NTP is unsynced this boot.
 *
 * The agent's clock stepper re-reads settings.json each tick (~30 s), so a
 * cloud change applies live without a restart. Mirrors the device agent's
 * parseTimeSyncSettings; the cloud rejects out-of-range values 4xx while the
 * device clamps them silently. Keep bounds in both places in sync.
 */
export const TIME_SYNC_STEP_THRESHOLD_SECS_MIN = 2;
export const TIME_SYNC_STEP_THRESHOLD_SECS_MAX = 600;
export const TIME_SYNC_MAX_STEPS_PER_BOOT_MIN = 1;
export const TIME_SYNC_MAX_STEPS_PER_BOOT_MAX = 20;

export const timeSyncConfigSchema = z
  .object({
    offlineSources: z
      .boolean()
      .describe(
        'Kill switch: false disables GPS/NITZ clock stepping entirely (device default: true).',
      )
      .optional(),
    stepThresholdSecs: z
      .number()
      .int()
      .min(TIME_SYNC_STEP_THRESHOLD_SECS_MIN)
      .max(TIME_SYNC_STEP_THRESHOLD_SECS_MAX)
      .describe(
        'Step only when the measured clock offset exceeds this many seconds (device default 10). ' +
          'A battery-backed RTC boots inside the threshold, making the feature a natural no-op.',
      )
      .optional(),
    maxStepsPerBoot: z
      .number()
      .int()
      .min(TIME_SYNC_MAX_STEPS_PER_BOOT_MIN)
      .max(TIME_SYNC_MAX_STEPS_PER_BOOT_MAX)
      .describe(
        'Hard cap on clock steps per boot (device default 4; bounds a flapping source).',
      )
      .optional(),
  })
  .strict();

export type TimeSyncConfig = z.infer<typeof timeSyncConfigSchema>;

/** Device defaults when the namespace is absent (device src/agent/clock-step.ts). */
export const TIME_SYNC_DEFAULTS = {
  offlineSources: true,
  stepThresholdSecs: 10,
  maxStepsPerBoot: 4,
} as const;

export const timeSyncNamespace: ConfigNamespaceSpec<TimeSyncConfig> = {
  key: 'timeSync',
  title: 'TimeSyncConfig',
  description:
    'Offline time sources (`timeSync` namespace): while NTP is unsynced this boot, the agent ' +
    'may step the system clock from GPS (valid GNSS fix) or the modem NITZ clock, then stand ' +
    'down for the boot once NTP synchronizes. All fields optional; omitted fields fall back ' +
    'to the device defaults.',
  schema: timeSyncConfigSchema,
  defaults: TIME_SYNC_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: 'timeSyncConfig',
  legacyPutField: 'timeSyncConfig',
  kind: 'object',
};
