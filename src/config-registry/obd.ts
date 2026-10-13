import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';
import { OBD_FIELDS } from '../schemas/capabilities';

/**
 * The `obd` namespace (plans/obd2-bluetooth-integration, D3/D6, P3) — which
 * ELM327 Bluetooth adapter a device reads its vehicle through, and how.
 *
 * The adapter is per VEHICLE, so it is a device setting; whether a kit has an
 * OBD reader at all is a model fact (`peripherals.obd` in io_capabilities v2,
 * P2). The namespace is therefore gated the way `simulation` is gated on
 * `devices.simulated`: `validateConfigPatch` and the local-change mirror both
 * refuse it for a device whose model does not declare `peripherals.obd`, and
 * the retained publish omits it for such a device even if a model
 * reassignment left a stale value on the row.
 *
 * Replaces the P1 env seam (`XORGATE_OBD_ADAPTER`, `_PIN`, `_POLL_HZ`,
 * `_FIELDS`, `_POWER_SOURCE`). The agent's OBD collector re-reads it on its
 * settings poll and on every cloud config message (`agent-poll`); a changed
 * adapter restarts the helper against the new MAC.
 *
 * Safety: the MAC and PIN are interpolated into `bluetoothctl` input on the
 * device, so both are closed-alphabet here AND re-checked by the helper. The
 * adapter is never auto-picked by name (decision 5): an operator supplies the
 * MAC from the label or from an `obd_scan` candidate list.
 */
export const OBD_MAC_PATTERN = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/;
export const OBD_PIN_PATTERN = /^[0-9]{4,6}$/;
export const OBD_POLL_HZ_MIN = 0.2;
export const OBD_POLL_HZ_MAX = 2;
export const OBD_POWER_SOURCES = ['switched', 'constant'] as const;

export const obdConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        'OBD polling kill switch. false (default) keeps the helper stopped and the vehicle ' +
          'card in its "not configured" state; true starts polling once an adapter is set.',
      )
      .optional(),
    adapterMac: z
      .string()
      .regex(OBD_MAC_PATTERN, 'Bluetooth MAC address, AA:BB:CC:DD:EE:FF')
      .transform((mac) => mac.toUpperCase())
      .nullable()
      .describe(
        'Bluetooth MAC of the ELM327 adapter (AA:BB:CC:DD:EE:FF, stored uppercase). null = no ' +
          'adapter configured; the device never pairs by name, so this is the only way it learns ' +
          'which dongle is its own.',
      )
      .optional(),
    pin: z
      .string()
      .regex(OBD_PIN_PATTERN, '4 to 6 digits')
      .describe('Pairing PIN for a legacy-pairing adapter, 4 to 6 digits (default 1234). Ignored by SSP adapters.')
      .optional(),
    pollHz: z
      .number()
      .min(OBD_POLL_HZ_MIN)
      .max(OBD_POLL_HZ_MAX)
      .describe('Poll cycles per second, 0.2 to 2 (default 1). One cycle reads every configured field once.')
      .optional(),
    fields: z
      .array(z.enum(OBD_FIELDS))
      .max(OBD_FIELDS.length)
      .refine((fields) => new Set(fields).size === fields.length, 'duplicate field')
      .describe(
        'Fields to poll, a subset of the model\'s declared `peripherals.obd.fields`. Empty ' +
          '(default) = every field the model declares. The device skips any field the vehicle ' +
          'does not support regardless.',
      )
      .optional(),
    powerSource: z
      .enum(OBD_POWER_SOURCES)
      .describe(
        'How the tracker device itself is powered, NOT the adapter (the vehicle\'s OBD port powers ' +
          'the adapter either way). "switched" (default): the device sits on a 12 V socket that dies ' +
          'with the ignition, so polling simply ends when the device loses power; the helper only ' +
          'needs to stop cleanly when the ECU goes silent. "constant": the device is hardwired, ' +
          'always on; the helper stops polling when the ECU goes silent and additionally pauses ' +
          'below 11.8 V, resuming above 12.4 V, so it can never drain the battery.',
      )
      .optional(),
  })
  .strict();

export type ObdConfig = z.infer<typeof obdConfigSchema>;

/** Device defaults when the namespace is absent (agent collector, P1 env seam defaults). */
export const OBD_DEFAULTS = {
  enabled: false,
  adapterMac: null,
  pin: '1234',
  pollHz: 1,
  fields: [],
  powerSource: 'switched',
} as const satisfies ObdConfig;

export const obdNamespace: ConfigNamespaceSpec<ObdConfig> = {
  key: 'obd',
  title: 'ObdConfig',
  description:
    'Vehicle OBD-II adapter settings (`obd` namespace). Accepted only for devices whose model ' +
    'declares `peripherals.obd` (400 otherwise). Every field is optional and an omitted field ' +
    'falls back to the device default, but the namespace is replaced WHOLE on write (send the ' +
    'fields you want to keep). `adapterMac` names the ELM327 Bluetooth adapter the device pairs with ' +
    '(stored uppercase; the device never pairs by name), `enabled` is the polling kill switch, ' +
    '`fields` narrows the polled set below the model\'s declared list (empty = all), and ' +
    '`powerSource` says how the tracker device (not the adapter) is powered, which selects the ' +
    'battery policy. Applied live by the agent\'s OBD collector on its ' +
    'settings poll and on every cloud config message; a changed adapter restarts the helper. ' +
    'Pairing outcome, probe profile and scan candidates come back in the config report under ' +
    '`effective.obd`.',
  schema: obdConfigSchema,
  defaults: OBD_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: null, // never had a column -> no migration
  legacyPutField: null,
  kind: 'object',
};
