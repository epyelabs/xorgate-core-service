import { SELECTABLE_SENSOR_IDS, cameraSensor, plannedCameraSensor } from './catalog';
import { shown } from './message';
import type { CameraSensor } from './schema';

/**
 * Validation of one sensor choice against the catalog: the `{ sensor, options }`
 * pair a port of the `cameraSensors` namespace will hold (Phase 2).
 *
 * ── RULING FOR PHASE 2 (plan owner, 2026-11-21): how the namespace uses this ──
 *
 * 1. The sensor ids do NOT go into `config-contract.json` as an enum. The
 *    contract must not change with every sensor (the SDK vendors it by hash,
 *    and the console and the agent pin it); the catalog is the artifact that
 *    moves. So the namespace's zod schema types `sensor` as a CONSTRAINED
 *    STRING (`CAMERA_SENSOR_ID_RE` from `schema.ts`, or the literal `none`)
 *    and `options` as a bounded record of string to number, and its
 *    `superRefine` calls `validateSensorChoice` per camera to check the id
 *    and the options against the catalog.
 *
 * 2. `validateSensorChoice` returns STRUCTURED issues: `{ path, message }`
 *    with `path` relative to the pair (`['sensor']`, `['options', 'x']`, or
 *    `[]` for the pair itself). In a `superRefine` that is
 *
 *        const checked = validateSensorChoice(entry);
 *        if ('issues' in checked) for (const issue of checked.issues) {
 *          ctx.addIssue({
 *            code: z.ZodIssueCode.custom,
 *            path: ['cameras', key, ...issue.path],
 *            message: issue.message,
 *          });
 *        }
 *
 *    and the registry's own formatter then prints
 *    `cameraSensors.cameras.cam0.sensor: …` once. Messages never start with a
 *    path of their own, so nothing is doubled. `formatSensorChoiceIssue` is
 *    only for callers outside a schema.
 *
 * 3. The reserved `sensor: "none"` (a port declared EMPTY) is NOT a catalog
 *    sensor. The namespace schema accepts `{ "sensor": "none" }` BEFORE this
 *    function is called, and `none` carries NO options: `{ "sensor": "none",
 *    "options": … }` is refused by the namespace, whatever `options` holds.
 *    Asked about `none`, this function answers "not a known camera sensor".
 *
 * 4. Also left to the namespace: the stream-key map around the pair, and the
 *    gate on agent kind and version.
 *
 * Every message is written for the operator who sent the value: it says what
 * was sent and lists what would be accepted.
 */

export interface SensorChoice {
  sensor: string;
  /** Present only when at least one option is set. Keys in catalog order. */
  options?: Record<string, number>;
}

export interface SensorChoiceIssue {
  /**
   * Where, relative to the pair: `[]`, `['sensor']`, `['options']` or
   * `['options', <a catalog option key>]`. Never a key taken from the input,
   * so a path is always short and safe to print.
   */
  path: string[];
  /** What is wrong and what would be accepted. Carries no path of its own. */
  message: string;
}

export type SensorChoiceResult = { value: SensorChoice } | { issues: SensorChoiceIssue[] };

const CHOICE_KEYS = ['sensor', 'options'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own keys only: `"constructor" in {}` is true, and these objects are user input. */
function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function optionKeys(sensor: CameraSensor): string {
  return sensor.options.map((o) => o.key).join(', ');
}

const fail = (path: string[], message: string): SensorChoiceResult => ({
  issues: [{ path, message }],
});

/**
 * Validate `{ sensor, options? }`.
 *
 * Accepted: a selectable catalog id, and for `options` only that sensor's
 * option keys, each set to one of its listed values. `options` may be absent
 * or `{}`. An option left out means the overlay's default.
 *
 * The returned value is normalized, not minimal: an empty `options` is
 * dropped and the keys follow the catalog's order, but an option explicitly
 * set to its default is KEPT (it is a statement by the operator). So
 * `{sensor}` and `{sensor, options: {<key>: <default>}}` are both valid, mean
 * the same line, and do not compare equal as stored. To compare two choices
 * (stored against reported, say), compare `resolveSensorOptions` of each.
 *
 * On failure, `issues` has at least one entry. The pair itself and the sensor
 * are judged first and stop at the first problem; every problem in `options`
 * is then reported, unknown keys first.
 */
export function validateSensorChoice(input: unknown): SensorChoiceResult {
  if (!isPlainObject(input)) {
    return fail([], `must be an object like {"sensor": "${SELECTABLE_SENSOR_IDS[0]}"}`);
  }
  const extra = Object.keys(input).filter((k) => !CHOICE_KEYS.includes(k));
  if (extra.length > 0) {
    return fail(
      [],
      `unknown key ${shown(extra[0])} (a camera takes only "sensor" and "options")`,
    );
  }

  const known = SELECTABLE_SENSOR_IDS.join(', ');
  const id = own(input, 'sensor') ? input.sensor : undefined;
  if (typeof id !== 'string' || id === '') {
    return fail(['sensor'], `required, one of: ${known}`);
  }
  const sensor = cameraSensor(id);
  if (!sensor) {
    const planned = plannedCameraSensor(id);
    if (planned) {
      const needs = planned.requires.os.join(' or ');
      return fail(
        ['sensor'],
        `"${id}" (${planned.label}) is planned and cannot be selected yet ` +
          `(it needs a device image on Debian ${needs}); available: ${known}`,
      );
    }
    return fail(['sensor'], `${shown(id)} is not a known camera sensor (known: ${known})`);
  }

  if (!own(input, 'options') || input.options === undefined) return { value: { sensor: id } };
  const sent = input.options;
  if (!isPlainObject(sent)) {
    return fail(
      ['options'],
      sensor.options.length > 0
        ? `must be an object of option values, e.g. {"${sensor.options[0].key}": ${sensor.options[0].values[0]}}`
        : `must be an object; ${id} takes no options, so leave it out`,
    );
  }

  const issues: SensorChoiceIssue[] = [];
  for (const key of Object.keys(sent)) {
    if (sensor.options.some((o) => o.key === key)) continue;
    const accepted =
      sensor.options.length > 0
        ? `its options: ${optionKeys(sensor)}`
        : 'it takes no options, so remove "options"';
    issues.push({ path: ['options'], message: `${id} has no option ${shown(key)} (${accepted})` });
  }
  const options: Record<string, number> = {};
  for (const option of sensor.options) {
    if (!own(sent, option.key)) continue;
    const value = sent[option.key];
    if (typeof value !== 'number' || !option.values.includes(value)) {
      const unit = option.unit ? ` ${option.unit}` : '';
      issues.push({
        path: ['options', option.key],
        message: `must be one of ${option.values.join(', ')}${unit} (got ${shown(value)})`,
      });
      continue;
    }
    options[option.key] = value;
  }
  if (issues.length > 0) return { issues };
  return Object.keys(options).length > 0
    ? { value: { sensor: id, options } }
    : { value: { sensor: id } };
}

/**
 * One issue as a line of text, for a caller that is not a zod schema:
 * `<label>.<path>: <message>`, the registry's own style
 * (`cameraSensors.cameras.cam0.sensor: …`).
 */
export function formatSensorChoiceIssue(issue: SensorChoiceIssue, label = 'camera'): string {
  return `${[label, ...issue.path].join('.')}: ${issue.message}`;
}

/**
 * Every option of a choice with its value: what was set, else the overlay
 * default. For display ("clock frequency: 37125000 Hz (default)") and for
 * COMPARING two choices: `{sensor}` and `{sensor, options: {<key>: <default>}}`
 * resolve to the same map.
 *
 * Takes anything. A choice that `validateSensorChoice` would refuse (not an
 * object, a sensor that is not selectable, an option or value the sensor does
 * not list) resolves to `null`; it never throws and never fills in a default
 * for a value it could not accept.
 */
export function resolveSensorOptions(choice: unknown): Record<string, number> | null {
  const checked = validateSensorChoice(choice);
  if (!('value' in checked)) return null;
  const sensor = cameraSensor(checked.value.sensor);
  if (!sensor) return null;
  const out: Record<string, number> = {};
  for (const option of sensor.options) {
    out[option.key] = checked.value.options?.[option.key] ?? option.default;
  }
  return out;
}
