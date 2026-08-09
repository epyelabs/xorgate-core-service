import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `cellular` namespace (manage_sim_card_info plan, Phase 2) — the modem's
 * data-context APN, applied by the sim7600-lte daemon with apply-and-confirm
 * rollback (a wrong APN on an LTE-only device would otherwise strand it: the
 * fix can only travel over the link the mistake just broke).
 *
 * Named `cellular`, not `apn`: the key is the wire name and is never renamed,
 * and APN username/password/auth-type belong in this same namespace later.
 *
 * SAFETY CONTRACT (README §5): the namespace being ABSENT — and `apn` being
 * empty — must leave the modem's stored APN untouched. Every fielded device
 * today has a working APN in modem NV and no `cellular` namespace; a default
 * that resolved to a written value would take out the fleet on first deploy.
 * The daemon issues no `AT+CGDCONT` write unless a non-empty APN differs from
 * the one the modem is applying.
 */
export const cellularConfigSchema = z
  .object({
    apn: z
      .string()
      .max(100) // 3GPP TS 23.003 caps an APN at 100 octets
      // Hostname-ish charset. Not cosmetic: the value is interpolated into an
      // AT command string on the device, so quotes, CR/LF and anything that
      // could terminate the command or inject a second one are rejected here
      // AND in the daemon (which must not trust settings.json either).
      .regex(/^[A-Za-z0-9.-]*$/, 'letters, digits, dots and hyphens only')
      .describe(
        'Access Point Name for the cellular data context. EMPTY or ABSENT leaves the ' +
          "modem's stored APN untouched — the safe default for every existing device. " +
          'A change is applied with confirm-and-rollback: the device proves real data ' +
          'flows over the new APN within a bounded window, or restores the previous one ' +
          'by itself.',
      )
      .optional(),
  })
  .strict();

export type CellularConfig = z.infer<typeof cellularConfigSchema>;

/**
 * Device/daemon defaults when the namespace is absent. `apn: ''` means "do not
 * touch the modem's stored APN" — it is a no-op marker, never a written value.
 */
export const CELLULAR_DEFAULTS = { apn: '' } as const;

export const cellularNamespace: ConfigNamespaceSpec<CellularConfig> = {
  key: 'cellular',
  title: 'CellularConfig',
  description:
    'Cellular data-context settings (`cellular` namespace). `apn` empty or absent leaves the ' +
    "modem's stored APN untouched (the safe default). A non-empty APN is applied by the modem " +
    'daemon with apply-and-confirm rollback: real traffic must flow over the modem interface ' +
    'within a bounded window or the previous APN is restored automatically. Read live from ' +
    'settings.json by the modem daemon — never restart it to apply a setting.',
  schema: cellularConfigSchema,
  defaults: CELLULAR_DEFAULTS,
  applyClass: 'modem-poll',
  legacyColumn: null, // never had a column -> no migration
  legacyPutField: null,
  kind: 'object',
};
