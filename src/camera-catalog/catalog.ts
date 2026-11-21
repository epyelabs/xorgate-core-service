import { VIDEO_PRESET_NAMES } from '../config-registry/recording';
import { CAMERA_CATALOG_SOURCE } from './data';
import {
  cameraCatalogSchema,
  type CameraCatalog,
  type CameraPackageSet,
  type CameraSensor,
  type PlannedCameraSensor,
} from './schema';

/**
 * `camera-catalog.json` — the cross-package artifact of the sensor catalog.
 *
 * Emitted by `npm run contract:generate` (the rail that emits
 * `config-contract.json`) and COMMITTED in:
 *   backend  src/camera-catalog/camera-catalog.json           (source of truth)
 *   web      src/lib/camera-catalog.json                      (labels, option fields, notes)
 *   device   crates/xorgate-core/data/camera-catalog.json     (compiled into the Rust agent)
 *
 * It is its own artifact and not a key of `config-contract.json` because the
 * agent reads the contract only in tests but needs the catalog at RUNTIME, and
 * because the catalog changes with every sensor while the contract must not
 * move for it (the SDK vendors the contract by hash).
 *
 * `test/camera-catalog.test.ts` regenerates it in memory and diffs it against
 * the committed copy, so editing `data.ts` without regenerating fails CI.
 */

/**
 * Validate a catalog and return it in CANONICAL key order.
 *
 * zod builds an object's output by walking the schema's keys, so the result's
 * key order is the schema's, whatever order the source literal was typed in.
 * That is what makes the serialized artifact independent of how `data.ts` is
 * laid out (a test feeds it a key-reversed copy to prove it).
 *
 * Throws on an invalid catalog, naming the entry: a bad catalog must never be
 * emitted, and must fail the build rather than a device.
 */
export function buildCameraCatalog(source: unknown = CAMERA_CATALOG_SOURCE): CameraCatalog {
  const parsed = cameraCatalogSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(catalog)'}: ${issue.message}`,
    );
    throw new Error(`camera catalog is invalid:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Stable serialization: two-space JSON plus one trailing newline. */
export function serializeCameraCatalog(catalog: CameraCatalog = buildCameraCatalog()): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** The validated catalog. Import this, never `data.ts`. */
export const CAMERA_CATALOG: CameraCatalog = buildCameraCatalog();

/**
 * Ids a device may be told to use, in catalog order. This is the set the
 * `cameraSensors` namespace builds its enum from (plus the reserved `none`).
 * Planned sensors are not in it.
 */
export const SELECTABLE_SENSOR_IDS: readonly string[] = CAMERA_CATALOG.sensors.map((s) => s.id);

/** A selectable sensor by id. Undefined for a planned or unknown id. */
export function cameraSensor(id: string): CameraSensor | undefined {
  return CAMERA_CATALOG.sensors.find((s) => s.id === id);
}

/** A planned (shown, not selectable) sensor by id. */
export function plannedCameraSensor(id: string): PlannedCameraSensor | undefined {
  return CAMERA_CATALOG.planned.find((s) => s.id === id);
}

/** The sensor whose overlay is `dtoverlay=<name>,…`. */
export function cameraSensorByOverlay(name: string): CameraSensor | undefined {
  return CAMERA_CATALOG.sensors.find((s) => s.overlay.name === name);
}

/** The sensor libcamera reports under `name` (variants included: `imx708_wide`). */
export function cameraSensorByLibcameraName(name: string): CameraSensor | undefined {
  return CAMERA_CATALOG.sensors.find((s) => s.libcameraNames.includes(name));
}

/**
 * The sensor behind a device-tree node. Accepts the bare name (`imx708`), the
 * node with its unit address (`imx708@1a`) or a whole libcamera camera path
 * (`/base/soc/i2c0mux/i2c@0/imx708@1a`).
 */
export function cameraSensorByDtNode(node: string): CameraSensor | undefined {
  const last = node.split('/').pop() ?? '';
  const name = last.split('@')[0];
  if (!name) return undefined;
  return CAMERA_CATALOG.sensors.find((s) => s.dtNodeNames.includes(name));
}

export function cameraPackageSet(id: string): CameraPackageSet | undefined {
  return CAMERA_CATALOG.packageSets.find((p) => p.id === id);
}

export type CameraPresetSupport = { supported: true } | { supported: false; reason: string };

/**
 * Can `preset` (a `recording.video.preset` name) run on the sensor `sensorId`?
 *
 * Supported unless the sensor's entry lists it under `unsupportedPresets`; the
 * reason then is the catalog's own sentence, ready to show an operator.
 *
 * Fails CLOSED on what it cannot judge: a sensor that is not selectable
 * (unknown, planned, or the reserved `none`) and a name that is not a preset
 * both answer "not supported", with a reason saying which. A caller with a
 * port that has no declared sensor has nothing to ask here.
 */
export function cameraPresetSupport(sensorId: string, preset: string): CameraPresetSupport {
  // Echoed names are cut short: either may be unvalidated input.
  const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}...` : text);
  const sensor = cameraSensor(sensorId);
  if (!sensor) {
    return { supported: false, reason: `"${clip(sensorId)}" is not a selectable camera sensor` };
  }
  if (!(VIDEO_PRESET_NAMES as readonly string[]).includes(preset)) {
    return {
      supported: false,
      reason: `"${clip(preset)}" is not a video preset (presets: ${VIDEO_PRESET_NAMES.join(', ')})`,
    };
  }
  const entry = sensor.unsupportedPresets.find((u) => u.preset === preset);
  return entry ? { supported: false, reason: entry.reason } : { supported: true };
}
