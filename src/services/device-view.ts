import { schema } from '../db/index';
import {
  CAMERA_SENSORS_KEY,
  cameraSensorsEligibility,
  publicConfigDocument,
  type ConfigDocument,
  type DeviceConfigDocument,
} from '../config-registry/index';
import { type AgentKind, storedAgent } from './device-agent';

/**
 * The single projection of a `devices` row onto the wire.
 *
 * It lived privately in `handlers/devices.ts` until a second handler
 * (`device-transfer.ts`) had to return a device too. Two copies of this would be
 * two chances to serve a raw `config` document with its cleared-namespace
 * markers in it, so there is one.
 */
export type DeviceRow = typeof schema.devices.$inferSelect;

export type DeviceView = Omit<DeviceRow, 'agent'> & {
  agent: AgentKind;
  firmwareVersion: string | null;
};

/**
 * The config document as served for THIS device.
 *
 * On top of stripping cleared namespaces: `cameraSensors` is served only for a
 * device that may hold it (`cameraSensorsEligibility`). Every client reads a
 * namespace that is present, on a device level on rev, with no status entry, as
 * "applied"; an agent that cannot act on the namespace sends no status entry
 * for it. Nothing stores the key on such a device (PATCH and the local-change
 * mirror refuse it, and the report mirror withdraws a registration's seed the
 * moment an agent proves it cannot act on it), so this only covers the instant
 * between a report landing and that withdrawal, and a withdrawal that lost a
 * race. A device that never held the key is untouched: same object, same keys.
 */
function servedConfigDocument(row: DeviceRow): ConfigDocument {
  const doc = publicConfigDocument(row.config);
  if (!Object.prototype.hasOwnProperty.call(doc, CAMERA_SENSORS_KEY)) return doc;
  if (cameraSensorsEligibility(row).allowed) return doc;
  const { [CAMERA_SENSORS_KEY]: _hidden, ...rest } = doc;
  return rest;
}

/**
 * Cleared config namespaces (`null`, settings_sync_hardening finding 2) are
 * stripped, so every client keeps seeing the two states the OpenAPI contract
 * documents: a namespace is either configured or absent. The marker exists so
 * the PUBLISHER can tell "reverted" from "never configured"; nothing outside
 * this service needs it, and the deployed frontend would read a present-but-null
 * key as "the cloud manages this".
 */
export function deviceResponse(row: DeviceRow): DeviceView {
  return {
    ...row,
    config: servedConfigDocument(row) as DeviceConfigDocument,
    // Which device agent this device runs (dual-agent registration D2/D9). The
    // column is NOT NULL DEFAULT 'js'; normalized so a client only ever sees
    // 'js' or 'rust', and every route that returns a device carries it.
    agent: storedAgent(row.agent),
    // TODO(agent-version-alias): drop `firmwareVersion` once the renamed
    // frontend is deployed (device_update_management, Phase 4). Its zod device
    // schema is strict — `firmwareVersion: z.string().nullable()` with no
    // `.catch` — so serving only the new name would fail the parse for every
    // browser still holding the old bundle, breaking the whole device page.
    firmwareVersion: row.agentVersion,
  };
}
