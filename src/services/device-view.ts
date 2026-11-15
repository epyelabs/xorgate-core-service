import { schema } from '../db/index';
import { publicConfigDocument, type DeviceConfigDocument } from '../config-registry/index';
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
    config: publicConfigDocument(row.config) as DeviceConfigDocument,
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
