/**
 * The device-config registry — ONE list that drives cloud-side validation, the
 * retained publish document, the OpenAPI blocks, and the committed
 * `config-contract.json` that the frontend imports and the device agent
 * contract-tests against (design.md §3).
 *
 * Adding a knob:
 *   1. add/extend the zod field in the namespace module (with `.describe()` —
 *      the OpenAPI text is generated from it),
 *   2. add its default to that module's `*_DEFAULTS`,
 *   3. `npm run contract:generate` and commit the artifact (the contract test
 *      fails if you forget),
 *   4. add the UI row.
 * Adding a whole namespace: one new module + one line in CONFIG_NAMESPACES.
 *
 * What used to be needed instead — a new column, a new schema file, a new
 * handler branch, a hand-written docs block and a publish key — is why the
 * thermal-shed keys shipped present in 2 of 5 places.
 */
import type { ConfigNamespaceSpec } from './types';
import { gnssAntBiasNamespace } from './gnss-ant-bias';
import { imuMountNamespace, type ImuMountConfig } from './imu-mount';
import { recordingNamespace, type RecordingConfig } from './recording';
import { lteRecoveryNamespace, type LteRecoveryConfig } from './lte-recovery';
import { timeSyncNamespace, type TimeSyncConfig } from './time-sync';
import { cellularNamespace, type CellularConfig } from './cellular';
import { cameraMountNamespace, type CameraMountConfig } from './camera-mount';
import { simulationNamespace, type SimulationConfig } from './simulation';

export * from './types';
export * from './gnss-ant-bias';
export * from './imu-mount';
export * from './recording';
export * from './lte-recovery';
export * from './time-sync';
export * from './cellular';
export * from './camera-mount';
export * from './simulation';
export * from './ui-prefs';

/**
 * Registry order is the publish order — keep it stable so the retained
 * payload's key order doesn't churn between deploys (it makes journal diffs on
 * the device readable).
 */
export const CONFIG_NAMESPACES: readonly ConfigNamespaceSpec[] = [
  gnssAntBiasNamespace,
  imuMountNamespace,
  recordingNamespace,
  lteRecoveryNamespace,
  timeSyncNamespace,
  cellularNamespace,
  cameraMountNamespace,
  simulationNamespace,
];

export const CONFIG_NAMESPACE_KEYS = CONFIG_NAMESPACES.map((n) => n.key);

export function configNamespace(key: string): ConfigNamespaceSpec | undefined {
  return CONFIG_NAMESPACES.find((n) => n.key === key);
}

/**
 * The stored `devices.config` document — one key per namespace, all optional.
 * Namespace keys are the WIRE keys.
 *
 * THREE states per namespace, not two (settings_sync_hardening, finding 2):
 *
 * - **absent** — never configured from the cloud. Omitted from the published
 *   message, which the device reads as "leave your local value alone". Nothing
 *   is materialized on create, so this is where every device starts.
 * - **a value** — cloud-managed; published and replaced whole.
 * - **`null`** — explicitly CLEARED by `PATCH {ns: null}`. Published as `{}`,
 *   which the device reads as "drop your local key and fall back to defaults".
 *
 * Absent and `null` look identical to every READER (both mean "the cloud
 * manages nothing here" — `legacyConfigColumns` maps both to the column
 * default, and the API strips `null` before it leaves the service). They differ
 * only to the PUBLISHER, and that difference is the whole point: without it,
 * "revert this namespace to device defaults" reverted the cloud and left the
 * device running what it had, with no badge anywhere to say so.
 */
export interface DeviceConfigDocument {
  gnssAntBias?: boolean | null;
  imuMount?: ImuMountConfig | null;
  recording?: RecordingConfig | null;
  lteRecovery?: LteRecoveryConfig | null;
  timeSync?: TimeSyncConfig | null;
  cellular?: CellularConfig | null;
  cameraMount?: CameraMountConfig | null;
  simulation?: SimulationConfig | null;
}

/**
 * The document as PUBLISHED. A cleared namespace travels as `{}` and never as
 * `null` — the device's tolerant parser has always mapped an empty object to
 * "clear this namespace", so the marker needs no new wire vocabulary.
 */
export type PublishedConfigDocument = {
  [K in keyof DeviceConfigDocument]?: NonNullable<DeviceConfigDocument[K]> | Record<string, never>;
};

/**
 * The document as it leaves the API. Cleared namespaces are stripped, so every
 * reader — the settings UI, an operator's script, the OpenAPI contract — keeps
 * seeing exactly two states, and `null` stays an internal publisher detail.
 */
export function publicConfigDocument(
  doc: DeviceConfigDocument | ConfigDocument | null | undefined,
): ConfigDocument {
  const out: ConfigDocument = {};
  for (const [key, value] of Object.entries(doc ?? {})) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** Loose view of the same document, for generic namespace-keyed manipulation. */
export type ConfigDocument = Record<string, unknown>;

/**
 * Validate one namespace value.
 *
 * - `null`      → revert to device defaults (stored as an explicit cleared
 *                 marker and published as `{}`, which tells the device to drop
 *                 its local key — see `DeviceConfigDocument`).
 * - `{}`        → REJECTED for object namespaces. An empty object is never an
 *                 erase; `null` is. This closes today's ambiguity where an
 *                 all-invalid namespace could erase local device state.
 * - everything else is validated whole (replace-whole-namespace semantics,
 *   matching how the device merges).
 *
 * `label` prefixes the error path so the same validator can serve both
 * `PATCH /config` (`recording.video.preset`) and the transitional PUT body
 * field names (`recordingConfig.video.preset`).
 */
export function validateNamespaceValue(
  key: string,
  value: unknown,
  label = key,
): { value: unknown } | { error: string } {
  const spec = configNamespace(key);
  if (!spec) return { error: `unknown config namespace "${key}"` };
  if (value === null) return { value: null };
  if (
    spec.kind === 'object' &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return {
      error: `${label}: must not be empty — send null to revert this namespace to device defaults`,
    };
  }
  const parsed = spec.schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${label}.${issue.path.join('.')}` : label;
    return { error: `${path}: ${issue?.message ?? 'invalid'}` };
  }
  return { value: parsed.data };
}

/**
 * Namespaces only a simulated device may hold (plans/xorgate-device-simulator).
 * `devices.simulated` is fixed at creation, so this is what keeps "make this
 * device a simulator" out of reach of every cloud write to real hardware: the
 * PATCH route and the device's local-change mirror both ask here first.
 */
export const SIMULATED_ONLY_NAMESPACES: readonly string[] = ['simulation'];

/** False when `key` is simulator-only and the device is not simulated. */
export function namespaceAllowedFor(key: string, opts: { simulated?: boolean }): boolean {
  return opts.simulated === true || !SIMULATED_ONLY_NAMESPACES.includes(key);
}

/**
 * Validate a partial config document (a `PATCH /devices/{id}/config` body).
 * All-or-nothing: the first invalid namespace fails the whole request, so a
 * multi-namespace save can never half-commit.
 */
export function validateConfigPatch(
  body: unknown,
  opts: { simulated?: boolean } = {},
): { value: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a partial config document' };
  }
  const src = body as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length === 0) return { error: 'no config namespaces provided' };
  const unknown = keys.filter((k) => !configNamespace(k));
  if (unknown.length > 0) {
    return {
      error: `unknown config namespace(s): ${unknown.join(', ')} (known: ${CONFIG_NAMESPACE_KEYS.join(', ')})`,
    };
  }
  const refused = keys.filter((k) => !namespaceAllowedFor(k, opts));
  if (refused.length > 0) {
    return {
      error: `config namespace(s) ${refused.join(', ')} apply only to simulated devices`,
    };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const parsed = validateNamespaceValue(key, src[key]);
    if ('error' in parsed) return parsed;
    out[key] = parsed.value;
  }
  return { value: out };
}

/**
 * Apply a validated patch to a stored document: present namespaces replace
 * whole, `null` stores the cleared marker, absent leaves untouched.
 *
 * `null` used to DELETE the key, which made "the operator reverted this" and
 * "this was never configured" the same stored state — and since the publisher
 * omits what it does not have, the device never heard about the revert. Keeping
 * the marker is what lets `buildDeviceConfigMessage` tell those two apart.
 */
export function applyConfigPatch(
  doc: DeviceConfigDocument | ConfigDocument | null | undefined,
  patch: Record<string, unknown>,
): ConfigDocument {
  const next: ConfigDocument = { ...(doc ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value;
  }
  return next;
}

/**
 * The config document a brand-new device starts from. Empty by design: an
 * absent namespace means "device defaults", and materializing defaults into the
 * doc would freeze today's values into every fielded device (a later default
 * change would then never reach them). `POST /devices` still publishes this —
 * a retained `{v:1, rev:1, gnssAntBias:false, …}` message so a device
 * converges on first connect instead of waiting for a first settings save.
 */
export function initialConfigDocument(): ConfigDocument {
  return {};
}
