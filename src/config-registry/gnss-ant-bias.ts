import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `gnssAntBias` namespace — a bare boolean, deliberately NOT nested.
 *
 * It is what the sim7600-lte daemon greps out of settings.json by exact path
 * (inline python heredoc), and every fielded device already holds it flat, so
 * "tidying" it into `gnss.antBias` would be a cross-fleet migration with a bash
 * component for zero functional gain (design.md §3).
 *
 * true powers an active GPS antenna's LNA via the modem's VDD_AUX LDO
 * (AT+CVAUXV/AT+CVAUXS); false is the hardware-safe passive-antenna state. The
 * daemon asserts it at boot and re-checks on its ~30 s poll, but only while LTE
 * health is OK — so "saved" can lead "applied" by a while on a bad link.
 */
export const gnssAntBiasSchema = z
  .boolean()
  .describe(
    'GPS antenna mode: true powers an active antenna (DC bias over the coax), false (default) ' +
      '= passive antenna, bias off. Applied by the modem daemon on its ~30 s poll.',
  );

export const GNSS_ANT_BIAS_DEFAULT = false;

export const gnssAntBiasNamespace: ConfigNamespaceSpec<boolean> = {
  key: 'gnssAntBias',
  title: 'GnssAntBias',
  description:
    'GPS antenna bias (`gnssAntBias`): true powers an active antenna over the coax, false ' +
    '(default) is the passive/bias-off hardware-safe state.',
  schema: gnssAntBiasSchema,
  defaults: GNSS_ANT_BIAS_DEFAULT,
  applyClass: 'modem-poll',
  legacyColumn: 'gnssAntBias',
  legacyPutField: 'gnssAntBias',
  kind: 'scalar',
};
