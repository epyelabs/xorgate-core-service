import type { WorkflowDefinition } from '../schemas/workflows';
import { capabilityTokensForNode, getNodeType } from '../workflows/catalog/index';
import { upgradeDefinition } from '../workflows/compat';

/**
 * Capability compatibility between a workflow definition and a device model.
 *
 * A template declares abstract input needs (video, specific telemetry metrics)
 * derived from its node graph; an attachment binds it to a concrete device.
 * Required tokens are computed from the catalog's declarative `requires` rules
 * (v1 definitions are upgraded first, so PoC node types resolve through their
 * compat aliases), then checked against the device model's `io_capabilities`
 * (see src/schemas/capabilities.ts and the FE capability-metrics.ts, which this
 * mirrors). Token vocabulary:
 *   "video"            — the graph consumes a device camera stream
 *   "gps" / "imu"      — legacy group tokens (still satisfiable, no longer emitted)
 *   "metric:<key>"     — a telemetry source names a specific metric key
 */

// Loose structural view of the stored jsonb (may predate the current schema).
type Caps = {
  media?: { video?: Array<{ key?: string }> | null } | null;
  sensors?: {
    imu?: {
      axes?: string[] | null;
      accel?: string[] | null;
      quaternion?: string[] | null;
      euler?: string[] | null;
    } | null;
  } | null;
  comm?: {
    gps?: { fields?: string[] | null } | null;
    signal?: { fields?: string[] | null } | null;
  } | null;
  system?: { fields?: string[] | null } | null;
} | null | undefined;

/** Distinct capability tokens a definition requires, in a stable order. */
export function computeRequiredCapabilities(def: WorkflowDefinition): string[] {
  const upgraded = upgradeDefinition(def);
  const reqs = new Set<string>();
  for (const node of upgraded.nodes) {
    const typeDef = getNodeType(node.type);
    if (!typeDef) continue; // unknown types are a publish-validation concern
    for (const token of capabilityTokensForNode(typeDef, node.data?.config ?? {})) {
      reqs.add(token);
    }
  }
  return [...reqs].sort();
}

function nonEmpty(arr: readonly string[] | null | undefined): boolean {
  return Array.isArray(arr) && arr.length > 0;
}

function hasVideo(caps: Caps): boolean {
  return (caps?.media?.video?.length ?? 0) > 0;
}

function hasGps(caps: Caps): boolean {
  return nonEmpty(caps?.comm?.gps?.fields);
}

function hasImu(caps: Caps): boolean {
  const imu = caps?.sensors?.imu;
  if (!imu) return false;
  return (
    nonEmpty(imu.accel) || nonEmpty(imu.axes) || nonEmpty(imu.quaternion) || nonEmpty(imu.euler)
  );
}

/** All `<group>.<field>` metric keys a device model can produce (mirrors capability-metrics.ts). */
export function producibleMetricKeys(caps: Caps): Set<string> {
  const keys = new Set<string>();
  for (const f of caps?.comm?.gps?.fields ?? []) keys.add(`gps.${f}`);
  for (const f of caps?.comm?.signal?.fields ?? []) keys.add(`lte.${f}`);
  for (const f of caps?.system?.fields ?? []) keys.add(`system.${f}`);
  const imu = caps?.sensors?.imu;
  for (const a of imu?.accel ?? imu?.axes ?? []) keys.add(`imu.accel_${a}`);
  for (const q of imu?.quaternion ?? []) keys.add(`imu.quat_${q}`);
  for (const e of imu?.euler ?? []) keys.add(`imu.euler_${e}`);
  return keys;
}

function isSatisfied(token: string, caps: Caps, metricKeys: Set<string>): boolean {
  if (token === 'video') return hasVideo(caps);
  if (token === 'gps') return hasGps(caps);
  if (token === 'imu') return hasImu(caps);
  if (token.startsWith('metric:')) return metricKeys.has(token.slice('metric:'.length));
  return true; // unknown token — do not block
}

/** Required tokens the model cannot satisfy (empty = compatible). */
export function missingCapabilities(required: string[], ioCapabilities: unknown): string[] {
  const caps = ioCapabilities as Caps;
  const metricKeys = producibleMetricKeys(caps);
  return required.filter((token) => !isSatisfied(token, caps, metricKeys));
}
