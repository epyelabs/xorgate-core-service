import type { z } from 'zod';

/**
 * How a namespace reaches the hardware once the device has it. Mirrors the
 * device-side apply semantics (design.md §6) so the cloud can say honestly
 * whether "saved" means "already in force".
 *
 * - `modem-poll`  — the sim7600-lte daemon re-reads settings.json on its own
 *                   cadence (~30 s for the antenna bias; at each recovery
 *                   decision for the policy knobs). Never restart that service
 *                   to apply a setting — it drops LTE.
 * - `agent-poll`  — the agent's own pollers pick it up (recording 5 s + forced
 *                   on every cloud message, timeSync ~30 s, imuMount per
 *                   sample).
 * - `agent-restart` — would need the agent to restart. **No namespace uses it
 *                   today** (Q4: `mode` is reported-only and `mediaEnabled` was
 *                   removed as a setting); the class is kept so a future
 *                   restart-applied key has somewhere to declare itself.
 */
export type ApplyClass = 'modem-poll' | 'agent-poll' | 'agent-restart';

/**
 * One entry of the device-config registry — the single source of truth for a
 * wire/settings.json namespace.
 *
 * Everything downstream derives from these entries: PATCH validation, the
 * retained publish document, the OpenAPI blocks in `handlers/docs.ts`, and the
 * committed `config-contract.json` the frontend imports and the device agent
 * contract-tests against. Adding a knob is one edit here plus a UI row — which
 * is the whole point (the thermal-shed keys once shipped missing from three of
 * five hand-maintained places).
 *
 * ⚠️ `key` is the WIRE name and is never renamed: the modem daemon greps these
 * exact paths out of settings.json, and every fielded device already holds
 * them. Human-facing naming is the UI's job (design.md §3).
 */
export interface ConfigNamespaceSpec<T = unknown> {
  /** Wire / settings.json / config-document key. Never renamed. */
  key: string;
  /** Human label used in generated docs. */
  title: string;
  /** Prose for the OpenAPI block. */
  description: string;
  /**
   * Validates the namespace WHOLE (replace-whole-namespace is the write
   * semantics, matching how the device merges). Cloud rejects out-of-range
   * values 4xx; the device clamps the same bounds instead — deliberate
   * asymmetry, see design.md §3.
   */
  schema: z.ZodType<T>;
  /**
   * The device's own defaults for this namespace, as the device resolves them
   * when the key is absent. Copied into `config-contract.json`; the device
   * agent has a contract test asserting its constants still match.
   */
  defaults: unknown;
  applyClass: ApplyClass;
  /**
   * The pre-consolidation `devices` column this namespace is dual-written to
   * during the transition window (Phase 2 keeps them; a follow-up migration
   * drops them). `null` for a namespace that never had its own column.
   */
  legacyColumn: string | null;
  /**
   * The legacy `PUT /devices/{id}` body field that carried this namespace.
   * Still accepted (with a deprecation log) so a pre-Phase-2 client keeps
   * working through the transition window.
   */
  legacyPutField: string | null;
  /**
   * Object namespaces are replaced whole and reject `{}` (an empty object is
   * never an erase — `null` is). Scalar namespaces (`gnssAntBias`) hold a bare
   * value instead.
   */
  kind: 'object' | 'scalar';
}
