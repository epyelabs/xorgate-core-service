import { SELECTABLE_SENSOR_IDS, cameraSensor, plannedCameraSensor } from './catalog';
import type { CameraSensor } from './schema';

/**
 * Validation of one sensor choice against the catalog: the `{ sensor, options }`
 * pair a port of the `cameraSensors` namespace will hold (Phase 2).
 *
 * This is the catalog-dependent half of that namespace's validation, kept here
 * so it can be built and tested before the namespace exists. NOT handled here,
 * on purpose, and left to the namespace schema:
 *   - the reserved `sensor: "none"` (a port declared empty). It is not a
 *     catalog sensor; the namespace accepts it before asking this function.
 *   - the stream-key map around the pair, and the gate on agent kind/version.
 *
 * Every message is written for the operator who sent the value: it names the
 * offending path, says what was sent, and lists what would be accepted.
 */

export interface SensorChoice {
  sensor: string;
  /** Present only when at least one option is set. Keys in catalog order. */
  options?: Record<string, number>;
}

export type SensorChoiceResult = { value: SensorChoice } | { error: string };

const CHOICE_KEYS = ['sensor', 'options'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own keys only: `"constructor" in {}` is true, and these objects are user input. */
function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Cut a sent string short, so a blob cannot flood a 400 or a log line. */
function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** A sent value, as JSON, for a message. */
function shown(value: unknown): string {
  // JSON has no NaN/Infinity (they print as "null", which would mislead).
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  try {
    return clip(JSON.stringify(value) ?? String(value));
  } catch {
    return clip(String(value));
  }
}

function optionKeys(sensor: CameraSensor): string {
  return sensor.options.map((o) => o.key).join(', ');
}

/**
 * Validate `{ sensor, options? }`.
 *
 * Accepted: a selectable catalog id, and for `options` only that sensor's
 * option keys, each set to one of its listed values. `options` may be absent
 * or `{}`. An option left out means the overlay's default.
 *
 * The returned value is canonical: `options` is dropped when empty and its
 * keys follow the catalog's order, so two equivalent choices store and compare
 * the same.
 *
 * `label` prefixes each path, like `validateNamespaceValue`'s
 * (`cameraSensors.cameras.cam0`).
 */
export function validateSensorChoice(input: unknown, label = 'camera'): SensorChoiceResult {
  if (!isPlainObject(input)) {
    return { error: `${label}: must be an object like {"sensor": "${SELECTABLE_SENSOR_IDS[0]}"}` };
  }
  const extra = Object.keys(input).filter((k) => !CHOICE_KEYS.includes(k));
  if (extra.length > 0) {
    return {
      error: `${label}.${clip(extra[0])}: unknown key (a camera takes only "sensor" and "options")`,
    };
  }

  const known = SELECTABLE_SENSOR_IDS.join(', ');
  const id = own(input, 'sensor') ? input.sensor : undefined;
  if (typeof id !== 'string' || id === '') {
    return { error: `${label}.sensor: required, one of: ${known}` };
  }
  const sensor = cameraSensor(id);
  if (!sensor) {
    const planned = plannedCameraSensor(id);
    if (planned) {
      const needs = planned.requires.os.join(' or ');
      return {
        error:
          `${label}.sensor: "${id}" (${planned.label}) is planned and cannot be selected yet ` +
          `(it needs a device image on Debian ${needs}); available: ${known}`,
      };
    }
    return {
      error: `${label}.sensor: ${shown(id)} is not a known camera sensor (known: ${known})`,
    };
  }

  if (!own(input, 'options') || input.options === undefined) return { value: { sensor: id } };
  const sent = input.options;
  if (!isPlainObject(sent)) {
    const hint =
      sensor.options.length > 0
        ? `must be an object of option values, e.g. {"${sensor.options[0].key}": ${sensor.options[0].values[0]}}`
        : `must be an object; ${id} takes no options, so leave it out`;
    return { error: `${label}.options: ${hint}` };
  }
  for (const key of Object.keys(sent)) {
    if (!sensor.options.some((o) => o.key === key)) {
      const accepted =
        sensor.options.length > 0
          ? `its options: ${optionKeys(sensor)}`
          : 'it takes no options, so remove "options"';
      const name = clip(key);
      return { error: `${label}.options.${name}: ${id} has no option "${name}" (${accepted})` };
    }
  }

  const options: Record<string, number> = {};
  for (const option of sensor.options) {
    if (!own(sent, option.key)) continue;
    const value = sent[option.key];
    if (typeof value !== 'number' || !option.values.includes(value)) {
      const unit = option.unit ? ` ${option.unit}` : '';
      return {
        error:
          `${label}.options.${option.key}: must be one of ${option.values.join(', ')}${unit} ` +
          `(got ${shown(value)})`,
      };
    }
    options[option.key] = value;
  }
  return Object.keys(options).length > 0
    ? { value: { sensor: id, options } }
    : { value: { sensor: id } };
}

/**
 * Every option of a VALID choice with its value: what was set, else the
 * overlay default. For display ("clock frequency: 37125000 Hz (default)") and
 * for comparing a stored choice with what a device reports. Returns null for a
 * sensor that is not selectable.
 */
export function resolveSensorOptions(choice: SensorChoice): Record<string, number> | null {
  const sensor = cameraSensor(choice.sensor);
  if (!sensor) return null;
  const out: Record<string, number> = {};
  for (const option of sensor.options) {
    out[option.key] = choice.options?.[option.key] ?? option.default;
  }
  return out;
}
