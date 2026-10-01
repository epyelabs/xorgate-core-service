import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `simulation` namespace (plans/xorgate-device-simulator, README §3.3) —
 * which demo scenario a simulated device replays.
 *
 * Accepted ONLY for devices created as simulated (`devices.simulated`, fixed at
 * creation by `POST /device-simulations`): `validateConfigPatch` and the
 * local-change mirror both refuse it for real hardware, which keeps the rule
 * that nothing cloud-writable can turn a fielded device into a simulator. A
 * real agent never sees the key, because nothing can store it on its row.
 *
 * The agent's replay source (`--mode replay`) re-reads it on its 5 s settings
 * poll and on every cloud message; a changed `scenarioId` ends the current lap
 * in place. "Reboot into scenario X" in the console is a PATCH of this
 * namespace followed by a plain `reboot` (README Q5).
 *
 * All three fields are required: the namespace is replaced whole like every
 * other, and a partial would silently reset the other two to defaults.
 */
export const SIMULATION_GAP_SECONDS_MIN = 0;
export const SIMULATION_GAP_SECONDS_MAX = 3600;
export const SIMULATION_SCENARIO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const simulationConfigSchema = z
  .object({
    scenarioId: z
      .string()
      .regex(SIMULATION_SCENARIO_ID_PATTERN)
      .describe('Catalog id of the scenario to replay (demo-assets/v1/<scenarioId>/).'),
    loop: z
      .boolean()
      .describe(
        'Replay the scenario again after the parked gap; false parks at the end of the lap until changed.',
      ),
    gapSeconds: z
      .number()
      .int()
      .min(SIMULATION_GAP_SECONDS_MIN)
      .max(SIMULATION_GAP_SECONDS_MAX)
      .describe('Parked pause between laps, seconds.'),
  })
  .strict();

export type SimulationConfig = z.infer<typeof simulationConfigSchema>;

/** Device defaults when the namespace is absent (agent src/daemon/settings.ts). */
export const SIMULATION_DEFAULTS = {
  scenarioId: 'city-2026-09-27',
  loop: true,
  gapSeconds: 30,
} as const;

export const simulationNamespace: ConfigNamespaceSpec<SimulationConfig> = {
  key: 'simulation',
  title: 'SimulationConfig',
  description:
    'Device-simulator scenario selection (`simulation` namespace). Accepted only for devices ' +
    'created as simulated; a simulated device replays the catalog scenario `scenarioId` from ' +
    '`demo-assets/v1/`, parks for `gapSeconds` between laps, and loops while `loop` is true. ' +
    'Applied live by the replay source (5 s settings poll, and forced on every cloud config ' +
    'message); a changed scenarioId ends the current lap in place.',
  schema: simulationConfigSchema,
  defaults: SIMULATION_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: null,
  legacyPutField: null,
  kind: 'object',
};
