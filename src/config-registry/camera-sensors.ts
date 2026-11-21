import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';
import { CAMERAS_MAX_KEYS, STREAM_KEY_RE } from './recording';
import {
  CAMERA_CATALOG,
  CAMERA_SENSOR_ID_RE,
  CAMERA_SENSOR_NONE,
  validateSensorChoice,
} from '../camera-catalog';
import { clip, shown } from '../camera-catalog/message';
import { hasAgentCapability, storedAgent } from '../services/device-agent';

/**
 * The `cameraSensors` namespace (plans/support-other-camera-models, DESIGN.md
 * §2 point 1): which image sensor is attached to each camera port of ONE
 * device.
 *
 *     { "cameras": {
 *         "cam0": { "sensor": "imx708" },
 *         "cam1": { "sensor": "imx290", "options": { "clockFrequency": 74250000 } }
 *     } }
 *
 * A device cannot find out by itself what is plugged into a port (Compute
 * Modules have no camera detection, and the `imx290` driver binds to anything),
 * so someone has to say. The model's `media.video[].sensor` stays, as the
 * DEFAULT a new registration starts from; this namespace is the authority for
 * a device that has it.
 *
 * Keyed by stream key (`cam0`, `cam1`, …) exactly like `cameraMount` and
 * `recording.video.cameras`.
 *
 * - `sensor` is an id of the camera catalog (`src/camera-catalog`), or the
 *   reserved `none` for a port declared EMPTY (no overlay line, the stream is
 *   held down, no error).
 * - `options` are the per-board overlay parameters the catalog lists for that
 *   sensor (a clock frequency, a link frequency). `none` takes none.
 * - **An ABSENT port key is UNMANAGED**: the agent leaves that port's
 *   `dtoverlay=` line exactly as it found it. Every device fielded before this
 *   namespace has no key at all, so nothing changes for it. Nothing here ever
 *   defaults a key in.
 *
 * The device applies it by rewriting the port's `dtoverlay=` line in
 * `/boot/firmware/config.txt`; like `cameraMount` it takes effect on the next
 * boot and the agent never reboots by itself.
 *
 * ── Why `sensor` is a string and not an enum ─────────────────────────────────
 * The sensor ids do NOT go into `config-contract.json` (plan owner's ruling,
 * `src/camera-catalog/sensor-choice.ts`): the contract must not move with every
 * sensor, the catalog is the artifact that does. So the shape below types
 * `sensor` as a constrained string and `options` as a bounded record of
 * numbers, and the refinement asks the catalog whether the id exists and the
 * options are ones it lists.
 *
 * ── Who may hold it ──────────────────────────────────────────────────────────
 * Only a real device running the Rust agent, and only while that agent has not
 * said it cannot act on it (`cameraSensorsEligibility`). See the gate section
 * at the bottom of this file.
 */

/** An option key as the catalog writes them (`clockFrequency`). */
const OPTION_KEY_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
/** No sensor has more than a handful; this only bounds the stored document. */
export const CAMERA_SENSOR_OPTIONS_MAX_KEYS = 8;

const cameraSensorEntrySchema = z
  .object({
    sensor: z
      // `none` has the shape of an id, so one pattern covers both.
      .string()
      .regex(CAMERA_SENSOR_ID_RE, 'must be a camera sensor id or "none"')
      .describe(
        'The image sensor on this port: an id of the camera catalog (camera-catalog.json, ' +
          '`sensors[].id`), or "none" for a port declared empty. The catalog, not this ' +
          'schema, is the list of valid ids, so that adding a sensor does not change the ' +
          'config contract. An id the catalog does not list is a 400 naming the ones it does.',
      ),
    options: z
      .record(
        z.string().regex(OPTION_KEY_RE, 'must be an option key'),
        z.number().finite(),
      )
      .refine((m) => Object.keys(m).length <= CAMERA_SENSOR_OPTIONS_MAX_KEYS, {
        message: `at most ${CAMERA_SENSOR_OPTIONS_MAX_KEYS} options`,
      })
      .describe(
        'Per-board overlay parameters of the chosen sensor, by the option keys the catalog ' +
          'lists for it (`sensors[].options[].key`), each set to one of that option\'s ' +
          '`values`. An option left out uses the overlay default. Not allowed with ' +
          '"sensor": "none".',
      )
      .optional(),
  })
  .strict();

/** One port's declaration as stored: `options` only when at least one is set. */
export interface CameraSensorEntry {
  sensor: string;
  options?: Record<string, number>;
}

/**
 * Check every port against the catalog and return the map NORMALIZED (an empty
 * `options` dropped, option keys in catalog order), or the issues.
 *
 * Shared by the namespace schema and the registration's `cameras` field, so a
 * choice made in the Register dialog is judged by exactly the rules a later
 * PATCH is.
 */
export function checkCameraSensorMap(
  cameras: Record<string, { sensor: string; options?: Record<string, number> }>,
):
  | { value: Record<string, CameraSensorEntry> }
  | { issues: { path: string[]; message: string }[] } {
  const issues: { path: string[]; message: string }[] = [];
  const value: Record<string, CameraSensorEntry> = {};
  for (const [key, entry] of Object.entries(cameras)) {
    if (entry.sensor === CAMERA_SENSOR_NONE) {
      // `none` is a value of the namespace, not a catalog sensor: accepted
      // here, before the catalog is asked, and it carries no options at all.
      if (entry.options !== undefined) {
        issues.push({
          path: [key, 'options'],
          message:
            'a port declared empty ("sensor": "none") takes no options: remove "options"',
        });
        continue;
      }
      value[key] = { sensor: CAMERA_SENSOR_NONE };
      continue;
    }
    const checked = validateSensorChoice(entry);
    if ('issues' in checked) {
      for (const issue of checked.issues) {
        issues.push({
          path: [key, ...issue.path],
          // The catalog lists its sensors; `none` is this namespace's own value.
          message:
            issue.path.length === 1 && issue.path[0] === 'sensor'
              ? `${issue.message}; or "none" for a port with no camera`
              : issue.message,
        });
      }
      continue;
    }
    value[key] = checked.value;
  }
  return issues.length > 0 ? { issues } : { value };
}

/**
 * A port key: a stream key, and never `__proto__`. That name passes the stream
 * key pattern, and zod's record parser assigns its output with `out[key] = …`,
 * which for `__proto__` sets a prototype instead of a key: the entry would
 * vanish and the request would be ACCEPTED with that port silently dropped.
 * Refused at the key, where it is still a key.
 */
const portKeySchema = z
  .string()
  .regex(STREAM_KEY_RE, 'must be a stream key')
  .refine((key) => key !== '__proto__', { message: 'must be a stream key' });

const portMapShape = z
  .record(portKeySchema, cameraSensorEntrySchema)
  .refine((m) => Object.keys(m).length <= CAMERAS_MAX_KEYS, {
    message: `at most ${CAMERAS_MAX_KEYS} cameras`,
  });

/**
 * The per-port map by itself: the namespace's `cameras` value, and the
 * `cameras` field of a device registration. Shape, then the catalog.
 */
export const cameraSensorMapSchema = portMapShape
  .superRefine((cameras, ctx) => {
    const checked = checkCameraSensorMap(cameras);
    if ('issues' in checked) {
      for (const issue of checked.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
      }
    }
  })
  .transform((cameras) => {
    const checked = checkCameraSensorMap(cameras);
    // Unreachable with issues: zod runs a transform only on a clean value.
    return 'value' in checked ? checked.value : cameras;
  });

export const cameraSensorsConfigSchema = z
  .object({
    cameras: portMapShape.describe(
      'Per-port sensor declaration keyed by stream key, e.g. {"cam0": {"sensor": "imx708"}, ' +
        '"cam1": {"sensor": "none"}}. An ABSENT key is UNMANAGED: the device leaves that ' +
        'port\'s camera line in /boot/firmware/config.txt exactly as it found it. A key must ' +
        'be a camera port the device\'s model declares. Takes effect on the next boot: the ' +
        'device reports that a reboot is required and never reboots itself.',
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const checked = checkCameraSensorMap(value.cameras);
    if ('issues' in checked) {
      for (const issue of checked.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cameras', ...issue.path],
          message: issue.message,
        });
      }
    }
  })
  .transform((value) => {
    const checked = checkCameraSensorMap(value.cameras);
    // Unreachable with issues: zod runs a transform only on a clean value.
    return { cameras: 'value' in checked ? checked.value : value.cameras };
  });

export type CameraSensorsConfig = z.infer<typeof cameraSensorsConfigSchema>;

/**
 * Device behaviour with the namespace absent: no port is managed, every camera
 * line is left as found. The same posture as `cameraMount`, for the same
 * reason: a device the cloud has never configured must not have a working
 * `dtoverlay=` line rewritten because a default said so.
 */
export const CAMERA_SENSORS_DEFAULTS = { cameras: {} } as const;

/** The wire key, for the call sites that have to name this one namespace. */
export const CAMERA_SENSORS_KEY = 'cameraSensors';

export const cameraSensorsNamespace: ConfigNamespaceSpec<CameraSensorsConfig> = {
  key: CAMERA_SENSORS_KEY,
  title: 'CameraSensorsConfig',
  description:
    'Camera sensor per port (`cameraSensors` namespace): which image sensor is attached to ' +
    'each camera port of this device, keyed by stream key. `sensor` is an id of the camera ' +
    'catalog or "none" for an empty port; `options` are that sensor\'s per-board overlay ' +
    'parameters. The agent makes the port\'s `dtoverlay=` line in /boot/firmware/config.txt ' +
    'match. ⚠️ Applies on the NEXT BOOT: the agent edits the boot config and reports that a ' +
    'reboot is required; it never reboots the device itself. An absent port key is unmanaged ' +
    '(the line is left as found). Accepted only for a real (not simulated) device running ' +
    'the Rust agent that either has not reported yet or advertises the `camera.sensors` ' +
    'capability; otherwise a 400 naming the agent version needed. Replaced WHOLE on write, ' +
    'so send every port you want to keep managed.',
  schema: cameraSensorsConfigSchema as unknown as z.ZodType<CameraSensorsConfig>,
  defaults: CAMERA_SENSORS_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: null, // born into `devices.config` -> no column, no migration
  legacyPutField: null,
  kind: 'object',
};

// ─────────────────────────────────────────────────────────────────────────────
// The gate: which device may hold the namespace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The capability string the Rust agent advertises in
 * `effective.agent.capabilities` once it can act on this namespace. Exactly
 * this string, on both sides.
 */
export const CAMERA_SENSORS_CAPABILITY = 'camera.sensors';

/** What a refusal names when the catalog lists no sensor at all. */
const CAMERA_SENSORS_MIN_AGENT_FALLBACK = '0.2.0';

function semverLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/**
 * The lowest `minAgent` of a list of catalog sensors.
 *
 * Never throws: an EMPTY list answers the fallback. This runs while the module
 * loads, in every Lambda that imports the registry, so a catalog with no
 * selectable sensor must not stop them from starting. With no sensor to select
 * there is no version to name anyway, and the answer is only ever message text.
 */
export function lowestMinAgent(sensors: readonly { minAgent: string }[]): string {
  let lowest: string | null = null;
  for (const { minAgent } of sensors) {
    if (lowest === null || semverLess(minAgent, lowest)) lowest = minAgent;
  }
  return lowest ?? CAMERA_SENSORS_MIN_AGENT_FALLBACK;
}

/**
 * The first Rust agent version that knows the namespace: the lowest `minAgent`
 * in the catalog (an agent that knows any catalog sensor knows the namespace).
 * It is what a refusal tells the operator to update to.
 */
export const CAMERA_SENSORS_MIN_AGENT: string = lowestMinAgent(CAMERA_CATALOG.sensors);

/** The row fields the gate reads. Any `devices` row satisfies it. */
export interface CameraSensorsDeviceFacts {
  /** `devices.agent`. */
  agent: unknown;
  /** `devices.simulated`. */
  simulated: unknown;
  /** `devices.reported_config`; null/undefined = the device has never reported. */
  reportedConfig: unknown;
  /** `devices.agent_version`, only to name the build in a refusal. */
  agentVersion?: unknown;
}

export type CameraSensorsRefusal = 'simulated' | 'agent-kind' | 'agent-version';

export interface CameraSensorsRefused {
  allowed: false;
  reason: CameraSensorsRefusal;
  /** The 400 text: what the device lacks and which agent version is needed. */
  message: string;
}

export type CameraSensorsEligibility = { allowed: true } | CameraSensorsRefused;

/**
 * May this device hold `cameraSensors`?
 *
 * Yes when it is a real device, its agent is the Rust one, and it either has
 * NEVER reported or its last report advertises `camera.sensors`.
 *
 * - The JS agent has no code for the namespace and never will (it is frozen).
 * - A simulator has no camera ports.
 * - A Rust agent older than `CAMERA_SENSORS_MIN_AGENT` ignores the key, and a
 *   device that is level on rev with no status entry reads as "applied" in the
 *   console: the setting would be shown as in force on an agent that never
 *   looked at it. Hence the capability.
 * - "Never reported" is allowed because that is every device between its claim
 *   and its first connect, which is when the registration's choice has to be
 *   stored. If the first report then shows an agent without the capability,
 *   the stored value is withdrawn (`handlers/device-config-report.ts`).
 *
 * Fails CLOSED on anything it cannot read.
 */
export function cameraSensorsEligibility(device: CameraSensorsDeviceFacts): CameraSensorsEligibility {
  const need = CAMERA_SENSORS_MIN_AGENT;
  if (device.simulated !== false) {
    return {
      allowed: false,
      reason: 'simulated',
      message:
        `config namespace ${CAMERA_SENSORS_KEY} does not apply to simulated devices: ` +
        'a simulator has no camera ports',
    };
  }
  if (storedAgent(device.agent) !== 'rust') {
    return {
      allowed: false,
      reason: 'agent-kind',
      message:
        `config namespace ${CAMERA_SENSORS_KEY} needs the Rust device agent, version ${need} or ` +
        'newer; this device runs the JS agent, which does not manage camera sensors',
    };
  }
  const neverReported = device.reportedConfig === null || device.reportedConfig === undefined;
  if (neverReported || hasAgentCapability(device.reportedConfig, CAMERA_SENSORS_CAPABILITY)) {
    return { allowed: true };
  }
  const build =
    typeof device.agentVersion === 'string' && device.agentVersion.trim() !== ''
      ? `agent build ${shown(device.agentVersion.trim())}`
      : 'an agent';
  return {
    allowed: false,
    reason: 'agent-version',
    message:
      `config namespace ${CAMERA_SENSORS_KEY} needs Rust agent ${need} or newer; this device last ` +
      `reported ${build} that does not support it (no "${CAMERA_SENSORS_CAPABILITY}" ` +
      'capability). Update the agent on the device, then save again',
  };
}

/** The refusal when the caller supplied no facts at all (a gate must fail closed). */
export const CAMERA_SENSORS_UNPROVEN: CameraSensorsRefused = {
  allowed: false,
  reason: 'agent-version',
  message:
    `config namespace ${CAMERA_SENSORS_KEY} applies only to devices running Rust agent ` +
    `${CAMERA_SENSORS_MIN_AGENT} or newer`,
};

/**
 * True when a report PROVES the agent cannot act on the namespace: it carries
 * an `effective.agent.capabilities` list and `camera.sensors` is not in it.
 *
 * Stricter than "does not advertise it". A report with no `agent` block at all
 * (the agent builds one only when it knows its mode) proves nothing, and the
 * caller of this function REMOVES a stored value on a true.
 *
 * DELIBERATE (review N3): that leaves a "stored but hidden" state. A Rust row
 * whose last report has no capability list is not eligible (PATCH 400, not
 * published, not served) and not withdrawn either; the value is served again
 * when a capable report lands. Shipped agents always send the list with the
 * `agent` block, so it is not reachable today, and deleting on mere absence
 * would be the worse error.
 */
export function reportDisprovesCameraSensors(report: unknown): boolean {
  if (!report || typeof report !== 'object') return false;
  const effective = (report as { effective?: unknown }).effective;
  if (!effective || typeof effective !== 'object') return false;
  const agent = (effective as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object') return false;
  const capabilities = (agent as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) && !capabilities.includes(CAMERA_SENSORS_CAPABILITY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ports: a key must be a camera the device's model declares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The camera stream keys a device's hardware block declares, in model order.
 * `null` when there is no block (a schemaVersion-1 model, or a model that does
 * not parse): the ports are then UNKNOWN and `cameraSensorsPortError` refuses
 * every value but the cleared marker.
 */
export function declaredCameraPorts(
  hardware: { video: { key: string }[] } | null | undefined,
): string[] | null {
  if (!hardware) return null;
  return hardware.video.map((v) => v.key);
}

/** The refusal for a device whose model declares no camera ports at all. */
export const CAMERA_SENSORS_NO_PORTS_MESSAGE =
  "this device's model declares no camera ports, so camera sensors cannot be set per port";

/** A key as it may appear in a message: cut at 64 characters. */
function shortKey(key: string): string {
  return clip(key, 67);
}

/**
 * Bound a value by the device's camera ports: every key must be a stream key
 * the device's model declares.
 *
 * FAILS CLOSED when the ports are unknown (`ports` null/undefined: no v2
 * hardware block, see `declaredCameraPorts`, or a caller that supplied none):
 * the value is refused whole. Without a port list the only check left on a key
 * is the stream-key pattern, which `constructor` and `toString` pass, and the
 * value goes to an agent that edits the boot config as root. A device on such
 * a model has no per-port hardware description for the agent to act on anyway.
 *
 * `null` (the cleared marker) is always accepted: clearing writes no key, and
 * it is the way out for a value left behind by a model reassignment.
 *
 * Returns the error text, or null. `value` is a namespace value that has
 * already passed the schema (or `null`).
 */
export function cameraSensorsPortError(
  value: unknown,
  ports: readonly string[] | null | undefined,
  label: string = CAMERA_SENSORS_KEY,
): string | null {
  if (value === null || value === undefined) return null;
  if (!ports) return `${label}: ${CAMERA_SENSORS_NO_PORTS_MESSAGE}`;
  if (typeof value !== 'object') return null;
  const cameras = (value as { cameras?: unknown }).cameras;
  if (!cameras || typeof cameras !== 'object') return null;
  for (const key of Object.keys(cameras)) {
    if (ports.includes(key)) continue;
    const allowed =
      ports.length > 0
        ? `its camera ports: ${ports.join(', ')}`
        : 'its model declares no camera ports';
    return (
      `${label}.cameras.${shortKey(key)}: this device's model has no camera port ` +
      `${shown(key)} (${allowed})`
    );
  }
  return null;
}
