import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `recording` namespace — on-device telemetry/video recording, upload,
 * retention and runtime load shedding (offline recording plan D7, extended by
 * optimize-system-process-cycle and power_management_improvements).
 *
 * Mirrors the device agent's own validation (device `src/daemon/settings.ts`
 * parseRecordingSettings + `src/recording/video-presets.ts`) with one
 * deliberate difference in posture: the device CLAMPS out-of-range numbers
 * (forgiving — a bad settings.json must never disable recording), the cloud
 * REJECTS them 4xx (an operator typo should surface in the UI, not silently
 * save a different value). The device's clamp range therefore always CONTAINS
 * the bounds below — the device contract test asserts exactly that.
 *
 * Field descriptions live on the zod schema (`.describe`) because the OpenAPI
 * block in `handlers/docs.ts` is generated from it. Editing prose here edits
 * the published docs; there is no second copy to forget.
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
// GPS/LTE video gate (Phase 7 / Q8). Same arming enum as bootDefer; the cap is
// tunable AND fully disableable (0 = no time cap), clamped to an hour so a typo
// cannot park video for a whole drive.
export const GPS_GATE_MAX_SECS_MAX = 3600;
// Per-camera enables (Phase 6). Keys are KVS stream keys (kvs.json
// `streamKey`, e.g. `cam0`) — device-specific, so the shape is validated
// rather than a closed enum. The device applies the same key rule.
export const STREAM_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const CAMERAS_MAX_KEYS = 16;
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
export const SHED_ESCALATE_DUTY_PCT_MIN = 50;
export const SHED_ESCALATE_DUTY_PCT_MAX = 100;
// Thermal arm (power_management_improvements plan, Phase 1). Trigger tops out
// at 90 °C because the Pi hard-throttles at 85 — a higher trip point would
// never be reached before the firmware has already capped clocks; restore is
// allowed lower (40) so a cool-running install can demand a real recovery.
export const SHED_CPU_TEMP_C_MIN = 50;
export const SHED_CPU_TEMP_C_MAX = 90;
export const SHED_CPU_TEMP_RESTORE_C_MIN = 40;
export const SHED_CPU_TEMP_RESTORE_C_MAX = 85;
export const SHED_CPU_TEMP_SECS_MIN = 5;
export const SHED_CPU_TEMP_SECS_MAX = 120;
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
        enabled: z.boolean().describe('Record telemetry locally (default false).').optional(),
        rateHz: z
          .number()
          .int()
          .min(RECORDING_RATE_HZ_MIN)
          .max(RECORDING_RATE_HZ_MAX)
          .describe(
            'Target sample rate. Each sensor group is additionally capped by its native cadence ' +
              '(IMU 20 Hz, GPS 1 Hz, system 1 Hz). Default 1.',
          )
          .optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        enabled: z.boolean().describe('Record camera video locally (default false).').optional(),
        preset: z
          .enum(VIDEO_PRESET_NAMES)
          .describe('Closed quality preset table (bounded CPU cost). Default 720p15-1mbps.')
          .optional(),
        segmentSeconds: z
          .number()
          .int()
          .min(RECORDING_SEGMENT_SECONDS_MIN)
          .max(RECORDING_SEGMENT_SECONDS_MAX)
          .describe('Segment length — the unit of upload, retry and eviction. Default 60.')
          .optional(),
        // Boot power staging knobs (Phase 2): defer heavy encoders at boot
        // until the modem settles. bootDeferMaxSecs 0 = feature off.
        bootDefer: z
          .enum(BOOT_DEFER_MODES)
          .describe(
            'Boot power staging: auto (default) defers heavy encoders at boot only when the ' +
              'negotiated PSU budget is below bootDeferMinBudgetMa; always defers every boot; ' +
              'off starts everything immediately.',
          )
          .optional(),
        bootDeferMaxSecs: z
          .number()
          .int()
          .min(0)
          .max(BOOT_DEFER_MAX_SECS_MAX)
          .describe('Hard cap on the boot defer in seconds. Default 90; 0 = feature off.')
          .optional(),
        bootDeferMinBudgetMa: z
          .number()
          .int()
          .min(0)
          .max(BOOT_DEFER_MIN_BUDGET_MA_MAX)
          .describe(
            'auto mode skips the defer when the negotiated supply budget (mA) is at or above ' +
              'this. Default 5000 (a true 5 V/5 A PD supply).',
          )
          .optional(),
        // GPS/LTE video gate (Phase 7): on a constrained budget, video —
        // recording AND live — waits until the modem stops converting power
        // into value (LTE up + GPS fix / dead zone / no-RF sky / the cap).
        gpsGate: z
          .enum(BOOT_DEFER_MODES)
          .describe(
            'GPS/LTE video gate: hold video (recording AND live) until the modem stops ' +
              'converting power into value — LTE connected with a GPS fix, a declared dead ' +
              'zone, a sustained no-signal sky, or gpsGateMaxSecs. auto (default) applies it ' +
              'only below bootDeferMinBudgetMa; always gates every boot; off disables it. ' +
              'Telemetry recording is never gated.',
          )
          .optional(),
        gpsGateMaxSecs: z
          .number()
          .int()
          .min(0)
          .max(GPS_GATE_MAX_SECS_MAX)
          .describe(
            'Give-up cap on the GPS/LTE gate in seconds. Default 600; 0 = no time cap ' +
              '(the other release conditions still apply).',
          )
          .optional(),
        // No-progress escape hatch (Phase 10 iter 2): release the gate once
        // NEITHER a GPS fix NOR an LTE connection has arrived for this long.
        gpsGateNoProgressSecs: z
          .number()
          .int()
          .min(0)
          .max(GPS_GATE_MAX_SECS_MAX)
          .describe(
            'No-progress escape hatch for the GPS/LTE gate, in seconds. Releases the gate ' +
              'once NEITHER a GPS fix NOR an LTE connection has arrived for this long — the ' +
              'underground-garage case, where every other release condition is blind. ' +
              'Cannot fire while LTE is connected (that is the genuinely-acquiring case). ' +
              'Default 120; 0 = off, leaving only gpsGateMaxSecs.',
          )
          .optional(),
        spawnStaggerSecs: z
          .number()
          .int()
          .min(0)
          .max(SPAWN_STAGGER_SECS_MAX)
          .describe(
            'Delay between camera encoder spawns in seconds (flattens the start-up power ' +
              'transient). Default 4; 0 = simultaneous.',
          )
          .optional(),
        // Per-camera capacity (Phase 6): `{"cam1": false}` turns that camera
        // off entirely (no capture, no bridge, no live master). An ABSENT key
        // means enabled, so `{}` is "every detected camera" — today's
        // behavior. Camera count is an install-time choice (1 camera on a 3 A
        // supply, 2 on 5 A), never something the shed ladder toggles.
        cameras: z
          .record(z.string().regex(STREAM_KEY_RE, 'must be a stream key'), z.boolean())
          .refine((m) => Object.keys(m).length <= CAMERAS_MAX_KEYS, {
            message: `at most ${CAMERAS_MAX_KEYS} cameras`,
          })
          .describe(
            'Per-camera enable keyed by stream key (e.g. {"cam1": false}). A disabled camera ' +
              'gets no pipeline at all — no recording, no shm bridge, no live stream. An absent ' +
              'key means enabled, so {} is every detected camera (the default). Use it to match ' +
              'camera count to the supply (one camera on a 3 A install, two on 5 A).',
          )
          .optional(),
      })
      .strict()
      .optional(),
    upload: z
      .object({
        mode: z
          .enum(['auto', 'off'])
          .describe(
            'auto (default): drain segments to S3 whenever connected; off: keep local only.',
          )
          .optional(),
      })
      .strict()
      .optional(),
    // Runtime undervoltage load shedding (Phase 3): live streaming sheds
    // first, recording last, restore with hysteresis. All Q4 starting values
    // are cloud-tunable so the Phase 5 field loop needs no redeploy.
    powerShedding: z
      .object({
        enabled: z.boolean().describe('Master switch. Default true.').optional(),
        uvSamples: z
          .number()
          .int()
          .min(SHED_UV_SAMPLES_MIN)
          .max(SHED_UV_SAMPLES_MAX)
          .describe(
            'Shed when this many ~1 Hz samples with the CURRENT undervoltage bit land within ' +
              'uvWindowSecs. Default 3.',
          )
          .optional(),
        uvWindowSecs: z
          .number()
          .int()
          .min(SHED_UV_WINDOW_SECS_MIN)
          .max(SHED_UV_WINDOW_SECS_MAX)
          .describe('Undervoltage counting window in seconds. Default 30.')
          .optional(),
        railLowVolts: z
          .number()
          .min(SHED_RAIL_VOLTS_MIN)
          .max(SHED_RAIL_LOW_VOLTS_MAX)
          .describe(
            'Alternative trigger: 5 V rail below this, sustained railLowSecs. Default 4.85.',
          )
          .optional(),
        railLowSecs: z
          .number()
          .int()
          .min(SHED_RAIL_LOW_SECS_MIN)
          .max(SHED_RAIL_LOW_SECS_MAX)
          .describe('How long the rail must stay below railLowVolts to trigger. Default 15.')
          .optional(),
        escalateDwellSecs: z
          .number()
          .int()
          .min(SHED_ESCALATE_DWELL_SECS_MIN)
          .max(SHED_ESCALATE_DWELL_SECS_MAX)
          .describe(
            'Trailing window (seconds) evaluated for escalation to the next rung ' +
              '(no-live → bridge-only). Default 60.',
          )
          .optional(),
        // Phase 6: escalate when the supply was bad for this % of the trailing
        // dwell window. 100 = the old continuous-trigger rule.
        escalateDutyPct: z
          .number()
          .int()
          .min(SHED_ESCALATE_DUTY_PCT_MIN)
          .max(SHED_ESCALATE_DUTY_PCT_MAX)
          .describe(
            'Escalate when the supply was bad (shed trigger, or an individual undervoltage/' +
              'low-rail sample) for at least this percentage of the trailing escalateDwellSecs ' +
              'window. Default 70; 100 requires a continuously bad supply, which a noisy rail ' +
              'never provides.',
          )
          .optional(),
        // Thermal arm (power_management_improvements plan, Phase 1): shed live
        // streaming once the SoC has sat at/above cpuTempC for cpuTempSecs,
        // restore only below cpuTempRestoreC.
        cpuTempC: z
          .number()
          .min(SHED_CPU_TEMP_C_MIN)
          .max(SHED_CPU_TEMP_C_MAX)
          .describe(
            'Thermal arm trigger: shed live streaming once the SoC has been at/above this for ' +
              'cpuTempSecs. Default 80 (5 °C below the Pi hard throttle).',
          )
          .optional(),
        cpuTempRestoreC: z
          .number()
          .min(SHED_CPU_TEMP_RESTORE_C_MIN)
          .max(SHED_CPU_TEMP_RESTORE_C_MAX)
          .describe(
            'Thermal restore threshold: the SoC must be below this for the restore timer to ' +
              'run. Default 70 (a 10 °C anti-flap margin).',
          )
          .optional(),
        cpuTempSecs: z
          .number()
          .int()
          .min(SHED_CPU_TEMP_SECS_MIN)
          .max(SHED_CPU_TEMP_SECS_MAX)
          .describe('How long the SoC must hold at/above cpuTempC to arm the shed. Default 15.')
          .optional(),
        restoreSecs: z
          .number()
          .int()
          .min(SHED_RESTORE_SECS_MIN)
          .max(SHED_RESTORE_SECS_MAX)
          .describe(
            'Clean interval (zero undervoltage samples, rail at/above railRestoreVolts) required ' +
              'to restore one rung. Default 120.',
          )
          .optional(),
        railRestoreVolts: z
          .number()
          .min(SHED_RAIL_VOLTS_MIN)
          .max(SHED_RAIL_RESTORE_VOLTS_MAX)
          .describe('Rail must be at/above this for a sample to count as clean. Default 4.95.')
          .optional(),
        maxShedsPerHour: z
          .number()
          .int()
          .min(0)
          .max(SHED_MAX_SHEDS_PER_HOUR_MAX)
          .describe(
            'Shed cycles per rolling hour before the device parks at its shed level (no ' +
              'auto-restore until reboot or a settings change). Default 4.',
          )
          .optional(),
      })
      .strict()
      .describe(
        'Runtime undervoltage + thermal load shedding: when the 5 V rail measurably fails (or ' +
          'the SoC runs hot), the device sheds live streaming first, then video recording ' +
          '(bridge-only), and restores in reverse with hysteresis. Telemetry recording is never ' +
          'shed.',
      )
      .optional(),
    retention: z
      .object({
        maxBytes: z
          .number()
          .int()
          .min(RETENTION_MAX_BYTES_MIN)
          .max(RETENTION_MAX_BYTES_MAX)
          .describe(
            'Local recordings quota in bytes (oldest segments evicted first). Default 10 GiB.',
          )
          .optional(),
        minFreeBytes: z
          .number()
          .int()
          .min(0)
          .max(RETENTION_MIN_FREE_BYTES_MAX)
          .describe(
            'Free-disk floor in bytes; recording evicts/stops before crossing it. Default 2 GiB.',
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RecordingConfig = z.infer<typeof recordingConfigSchema>;

/**
 * Device defaults for this namespace — what the agent resolves when a key is
 * absent (device `src/recording/config.ts` RECORDING_DEFAULTS). Published in
 * `config-contract.json`; the device agent contract test asserts they still
 * match, and the web UI renders them instead of a blank control.
 */
export const RECORDING_DEFAULTS = {
  telemetry: { enabled: false, rateHz: 1 },
  video: {
    enabled: false,
    preset: '720p15-1mbps',
    segmentSeconds: 60,
    bootDefer: 'auto',
    bootDeferMaxSecs: 90,
    bootDeferMinBudgetMa: 5000,
    gpsGate: 'auto',
    gpsGateMaxSecs: 600,
    gpsGateNoProgressSecs: 120,
    spawnStaggerSecs: 4,
    cameras: {},
  },
  upload: { mode: 'auto' },
  retention: { maxBytes: 10 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3 },
  powerShedding: {
    enabled: true,
    uvSamples: 3,
    uvWindowSecs: 30,
    railLowVolts: 4.85,
    railLowSecs: 15,
    escalateDwellSecs: 60,
    escalateDutyPct: 70,
    cpuTempC: 80,
    cpuTempRestoreC: 70,
    cpuTempSecs: 15,
    restoreSecs: 120,
    railRestoreVolts: 4.95,
    maxShedsPerHour: 4,
  },
} as const;

export const recordingNamespace: ConfigNamespaceSpec<RecordingConfig> = {
  key: 'recording',
  title: 'RecordingConfig',
  description:
    'On-device recording settings (`recording` namespace). All fields optional — omitted ' +
    'fields fall back to device defaults. Unknown keys and out-of-range values are rejected. ' +
    'Applied live by the agent (5 s settings poll, and forced on every cloud config message); ' +
    'toggling video recording or changing its preset briefly restarts the live stream.',
  schema: recordingConfigSchema,
  defaults: RECORDING_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: 'recordingConfig',
  legacyPutField: 'recordingConfig',
  kind: 'object',
};
