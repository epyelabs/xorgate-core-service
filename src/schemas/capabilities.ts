import { z } from 'zod';

/**
 * Device `io_capabilities` contract (stored on `device_models.io_capabilities` jsonb).
 *
 * Capability-driven: each declared leaf maps to one telemetry `metric` namespace
 * and/or one media stream key. Consumers render/handle only what is declared, so
 * partial-capability devices validate too (every section is optional).
 *
 * Two schema versions coexist (cm4-support plan, D1/D2):
 *
 * - **v1** — telemetry/media declarations only. Every fielded model before the
 *   CM4 work. Devices on a v1 model get NO hardware block: the agent falls back
 *   to its legacy hardcoded CM5 behavior, which is exactly what those devices
 *   are running.
 * - **v2** — adds the platform FACTS the device agent turns into mechanism:
 *   `system.platform` (camera-enumeration strategy + encoder default),
 *   `system.encoder` (pipeline template token), `system.rails` (PMIC 5V-rail
 *   telemetry exists), `system.statusLed` (RGB pin map), `sensors.imu.model`,
 *   and per-video `connector`/`sensor`. Deliberately NOT here: libcamera
 *   identity paths (the agent enumerates them — they are what the kernel calls
 *   a connector *this boot*) and pipeline strings/caps (one wrong caps token
 *   renders a silently-black stream; templates ship tested in the agent).
 */

const videoCapabilitySchema = z.object({
  key: z.string(), // cam0, cam1
  codec: z.string(), // h264
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  maxFps: z.number().positive().optional(),
  label: z.string().optional(),
});

const audioCapabilitySchema = z.object({
  key: z.string(), // audio0
  codec: z.string(), // opus
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
});

const mediaCapabilitiesSchema = z.object({
  video: z.array(videoCapabilitySchema).default([]),
  audio: z.array(audioCapabilitySchema).default([]),
});

const imuSensorSchema = z.object({
  // BNO085-class IMU. `accel` is linear acceleration (gravity removed);
  // `quaternion` is the rotation vector; `euler` are the angles derived from it.
  // Each list names the fields published under the `imu.<prefix>_<field>` metric
  // namespace (e.g. accel ['x','y','z'] -> imu.accel_x). `axes` is retained for
  // back-compat with older accel-only models.
  axes: z.array(z.string()).optional(), // legacy alias for accel, e.g. ['x','y','z']
  accel: z.array(z.string()).optional(), // ['x','y','z']
  quaternion: z.array(z.string()).optional(), // ['r','i','j','k']
  euler: z.array(z.string()).optional(), // ['roll','pitch','yaw']
  unit: z.string().optional(),
  rateHz: z.number().positive().optional(),
});

const sensorsCapabilitiesSchema = z.object({
  imu: imuSensorSchema.optional(),
});

const fieldListSchema = z.object({ fields: z.array(z.string()) });

const commCapabilitiesSchema = z.object({
  module: z.string().optional(), // 4g-lte
  gps: fieldListSchema.optional(),
  signal: fieldListSchema.optional(),
});

export const ioCapabilitiesV1Schema = z.object({
  schemaVersion: z.literal(1),
  media: mediaCapabilitiesSchema.optional(),
  sensors: sensorsCapabilitiesSchema.optional(),
  comm: commCapabilitiesSchema.optional(),
  system: fieldListSchema.optional(),
});

// ---------------------------------------------------------------------------
// schemaVersion 2 — platform facts (cm4-support plan)
// ---------------------------------------------------------------------------

/** Platforms the agent has an enumeration strategy + encoder default for. */
export const PLATFORMS = ['rpi-cm5', 'rpi-cm4'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Encoder tokens — each names one TESTED pipeline template shipped in the
 * agent (bridged KVS .gst, direct .gst, recording argv all render from it).
 * `hw-h264` = v4l2h264enc with constrained-baseline caps (README Appendix A);
 * `sw-h264` = today's x264enc lines, byte-for-byte.
 */
export const ENCODERS = ['sw-h264', 'hw-h264'] as const;
export type EncoderToken = (typeof ENCODERS)[number];

/** The CM5 has no hardware H.264 encoder (D4) — software is a SoC fact there. */
export function defaultEncoderForPlatform(platform: Platform): EncoderToken {
  return platform === 'rpi-cm4' ? 'hw-h264' : 'sw-h264';
}

const statusLedSchema = z.object({
  r: z.number().int().nonnegative(),
  g: z.number().int().nonnegative(),
  b: z.number().int().nonnegative(),
});

/**
 * v2 `system`: the v1 telemetry field list PLUS the platform facts. `fields`
 * is kept (not replaced) so the telemetry-history column builder and the
 * frontend's capability-metrics keep reading `system.fields` untouched on
 * either version.
 */
const systemV2Schema = z.object({
  platform: z.enum(PLATFORMS),
  /** Omitted → derived from `platform` (defaultEncoderForPlatform). */
  encoder: z.enum(ENCODERS).optional(),
  /** PMIC 5V-rail/PSU telemetry exists (CM5 carrier yes, bare CM4 no). */
  rails: z.boolean().default(false),
  /** RGB status LED GPIO pin map; null = no LED wired. */
  statusLed: statusLedSchema.nullable().default(null),
  fields: z.array(z.string()).default([]),
});

/**
 * v2 video entries carry the connector + sensor so the agent can emit the
 * right device-tree overlays and pair enumerated cameras to stream keys in
 * stable connector order — never a libcamera path, which is enumerated.
 */
const videoCapabilityV2Schema = videoCapabilitySchema.extend({
  connector: z.string().min(1), // csi0, csi1
  sensor: z.string().min(1), // imx290
});

/**
 * v2 IMU keeps the v1 field lists (telemetry columns render from them) and
 * adds the part `model`. Declared = expected-if-present; the collector still
 * self-gates when the part is absent from the bus.
 */
const imuSensorV2Schema = imuSensorSchema.extend({
  model: z.string().optional(), // bno085
});

// ---------------------------------------------------------------------------
// v2 `peripherals` — external devices the kit attaches to (obd2 plan, D2)
// ---------------------------------------------------------------------------

/**
 * Every field the OBD helper can decode, i.e. the closed vocabulary of
 * `obd.<field>` metric names (obd2-bluetooth-integration plan, phase-1 brief,
 * "Frozen contract 2"). A model's `peripherals.obd.fields` is a subset of this
 * list; the device emits the intersection with what the vehicle actually
 * supports (an unsupported PID is never polled and never emitted, no nulls).
 * `link` is the health code (0 no adapter, 1 adapter only, 2 ECU answering)
 * and is always emitted while the collector exists.
 *
 * Torque (POST_INTEGRATION 2026-10-16, appended after `link` so existing
 * model rows only grow at the end): `engine_torque_pct` = PID 62 actual
 * engine torque, % of reference (A - 125); `reference_torque` = PID 63, Nm
 * (A*256 + B); `engine_torque` = derived Nm (pct / 100 * reference), emitted
 * only when both PIDs answered in the same poll cycle.
 */
export const OBD_FIELDS = [
  'rpm',
  'speed',
  'coolant_temp',
  'engine_load',
  'throttle',
  'pedal',
  'intake_temp',
  'ambient_temp',
  'intake_map',
  'baro',
  'fuel_level',
  'fuel_rate',
  'module_voltage',
  'adapter_voltage',
  'run_time',
  'odometer',
  'gear',
  'distance_since_clear',
  'mil',
  'dtc_count',
  'link',
  'engine_torque_pct',
  'reference_torque',
  'engine_torque',
] as const;
export type ObdField = (typeof OBD_FIELDS)[number];

/** ELM327-class adapters the helper speaks to. */
export const OBD_ADAPTERS = ['elm327'] as const;
/** How the adapter is reached: Bluetooth SPP (RFCOMM) or a USB serial port. */
export const OBD_TRANSPORTS = ['bt-spp', 'usb-serial'] as const;

/**
 * An OBD-II reader attached to the kit. The adapter MAC is NOT here: it is per
 * vehicle, so it is a device setting (the `obd` config namespace), while this
 * section says only that an adapter is EXPECTED on every device of the model.
 * `info` names the string items (VIN, calibration ids, ECU names, DTC codes)
 * that travel via the config report rather than telemetry (C1: metrics are
 * numbers only); declared but unused in v1.
 */
const obdPeripheralSchema = z.object({
  adapter: z.enum(OBD_ADAPTERS),
  transport: z.enum(OBD_TRANSPORTS),
  rateHz: z.number().positive().optional(),
  fields: z.array(z.enum(OBD_FIELDS)),
  info: z.array(z.string()).optional(),
});

/**
 * `peripherals` is generic on purpose (like `comm`/`media`/`sensors`/`system`):
 * later entries could be `j1939`, `modbus`, `ble`, `tpms`. Only `obd` exists.
 */
const peripheralsCapabilitiesSchema = z.object({
  obd: obdPeripheralSchema.optional(),
});

export const ioCapabilitiesV2Schema = z.object({
  schemaVersion: z.literal(2),
  media: z
    .object({
      video: z.array(videoCapabilityV2Schema).default([]),
      audio: z.array(audioCapabilitySchema).default([]),
    })
    .optional(),
  sensors: z.object({ imu: imuSensorV2Schema.optional() }).optional(),
  comm: commCapabilitiesSchema.optional(),
  system: systemV2Schema,
  peripherals: peripheralsCapabilitiesSchema.optional(),
});

export const ioCapabilitiesSchema = z.discriminatedUnion('schemaVersion', [
  ioCapabilitiesV1Schema,
  ioCapabilitiesV2Schema,
]);

export type IoCapabilities = z.infer<typeof ioCapabilitiesSchema>;
export type IoCapabilitiesV2 = z.infer<typeof ioCapabilitiesV2Schema>;
export type ObdPeripheralCapability = z.infer<typeof obdPeripheralSchema>;

// ---------------------------------------------------------------------------
// The hardware block — what a device is TOLD about its own hardware
// ---------------------------------------------------------------------------

/**
 * The projection of a v2 model the device actually receives: embedded in the
 * claim response (installed as /etc/xorgate/hardware.json) and carried live on
 * the retained config message's envelope (`hardware` key) so a model
 * correction in the console reaches fielded devices with no re-provision.
 *
 * The agent validates this against its own copy of the schema; an unknown
 * enum fails loudly there and falls back to legacy CM5/sw-h264 behavior.
 */
export interface DeviceHardwareBlock {
  v: 2;
  platform: Platform;
  encoder: EncoderToken;
  rails: boolean;
  statusLed: { r: number; g: number; b: number } | null;
  /** IMU part number, or null when the model declares no IMU. */
  imu: string | null;
  video: Array<{
    key: string;
    connector: string;
    sensor: string;
    codec: string;
    label?: string;
    maxWidth?: number;
    maxHeight?: number;
    maxFps?: number;
  }>;
  /**
   * External devices the model expects attached. Present ONLY when the model
   * declares `peripherals` (absent, not null, otherwise): an agent that
   * predates the key ignores it, and a model without it yields a block that is
   * byte-for-byte what it was before. Field lists and rates stay on the model;
   * the device only needs to know WHAT to drive and over which transport.
   */
  peripherals?: {
    obd?: { adapter: ObdAdapter; transport: ObdTransport };
  };
}

export type ObdAdapter = (typeof OBD_ADAPTERS)[number];
export type ObdTransport = (typeof OBD_TRANSPORTS)[number];

/**
 * Derive the device-facing hardware block from a model's `io_capabilities`.
 * Returns null for v1 documents and anything unparseable — the delivery paths
 * then simply omit the block, and the agent keeps its legacy behavior.
 */
export function deriveHardwareBlock(caps: unknown): DeviceHardwareBlock | null {
  const parsed = ioCapabilitiesV2Schema.safeParse(caps);
  if (!parsed.success) return null;
  const c = parsed.data;
  const imu = c.sensors?.imu;
  const obd = c.peripherals?.obd;
  return {
    v: 2,
    platform: c.system.platform,
    encoder: c.system.encoder ?? defaultEncoderForPlatform(c.system.platform),
    rails: c.system.rails,
    statusLed: c.system.statusLed,
    // Declared IMU without an explicit part number defaults to the fleet's
    // BNO085 — every shipped carrier uses it.
    imu: imu ? (imu.model ?? 'bno085') : null,
    video: (c.media?.video ?? []).map((v) => ({
      key: v.key,
      connector: v.connector,
      sensor: v.sensor,
      codec: v.codec,
      ...(v.label !== undefined ? { label: v.label } : {}),
      ...(v.maxWidth !== undefined ? { maxWidth: v.maxWidth } : {}),
      ...(v.maxHeight !== undefined ? { maxHeight: v.maxHeight } : {}),
      ...(v.maxFps !== undefined ? { maxFps: v.maxFps } : {}),
    })),
    ...(obd ? { peripherals: { obd: { adapter: obd.adapter, transport: obd.transport } } } : {}),
  };
}

/**
 * Map a device's `/proc/device-tree/model` string (sent by install.sh with the
 * claim — D3 probe) to a platform. Null when unrecognizable; the claim then
 * keeps the registration's model and flags the device `needs_model`.
 */
export function platformFromDtModel(dtModel: string | null | undefined): Platform | null {
  if (!dtModel) return null;
  const s = dtModel.toLowerCase();
  if (s.includes('compute module 5') || s.includes('raspberry pi 5')) return 'rpi-cm5';
  if (s.includes('compute module 4') || s.includes('raspberry pi 4')) return 'rpi-cm4';
  return null;
}

/** Canonical media stream keys used for KVS channels and S3 segment paths. */
export const STREAM_KEYS = ['cam0', 'cam1', 'audio0'] as const;
export type StreamKey = (typeof STREAM_KEYS)[number];
