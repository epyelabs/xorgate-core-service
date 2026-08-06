import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { CONFIG_NAMESPACES } from './index';
import { UI_PREFS_DEFAULTS, uiPrefsSchema } from './ui-prefs';

/**
 * `config-contract.json` — the cross-package artifact (design.md §3).
 *
 * Emitted from the registry by `npm run contract:generate` and COMMITTED in all
 * three packages:
 *   backend  src/config-registry/config-contract.json  (source of truth)
 *   web      src/lib/config-contract.json              (imported by the UI)
 *   device   test/config-contract.json                 (contract test only)
 *
 * There is no runtime coupling between the packages — the artifact plus one
 * test per package is what keeps them honest, which is exactly what nothing did
 * when the thermal-shed keys drifted.
 *
 * The backend test regenerates this in-memory and diffs it against the
 * committed copy, so editing the registry without regenerating fails CI.
 */

/**
 * JSON Schema (OpenAPI 3 flavour) for one namespace, derived from its zod
 * schema — bounds, enums, `additionalProperties:false` from `.strict()`, and
 * the field prose from `.describe()`.
 *
 * The cast sidesteps zod-to-json-schema's fully-generic return type, which
 * tsc cannot instantiate for schemas this deeply nested (TS2589). Only the
 * signature is erased; the runtime call is unchanged.
 */
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: ZodTypeAny,
  options: Record<string, unknown>,
) => Record<string, unknown>;

export function namespaceJsonSchema(schema: ZodTypeAny): unknown {
  const out = toJsonSchema(schema, {
    target: 'openApi3',
    // Inline everything: these blocks are spliced straight into
    // components.schemas, so a "definitions" wrapper or a $schema key would
    // leak zod's own structure into the published contract.
    $refStrategy: 'none',
  });
  delete out.$schema;
  return out;
}

export interface ConfigContract {
  /** Artifact format version — bump only on a breaking shape change. */
  version: 1;
  generatedBy: string;
  /**
   * Wire message version carried on `xorgate/devices/{id}/config`. Still 1:
   * Phase 2 only ADDS `rev` (old agents ignore unknown keys, new agents treat a
   * missing rev as 0).
   */
  wireVersion: 1;
  namespaces: Record<
    string,
    {
      applyClass: string;
      kind: 'object' | 'scalar';
      description: string;
      /** Device defaults when the namespace is absent from the doc. */
      defaults: unknown;
      /** Bounds + enums, as JSON Schema. */
      jsonSchema: unknown;
    }
  >;
  /** Cloud-only presentation prefs — never published to a device. */
  uiPrefs: {
    defaults: unknown;
    jsonSchema: unknown;
  };
}

export function buildConfigContract(): ConfigContract {
  const namespaces: ConfigContract['namespaces'] = {};
  for (const ns of CONFIG_NAMESPACES) {
    namespaces[ns.key] = {
      applyClass: ns.applyClass,
      kind: ns.kind,
      description: ns.description,
      defaults: ns.defaults,
      jsonSchema: namespaceJsonSchema(ns.schema as ZodTypeAny),
    };
  }
  return {
    version: 1,
    generatedBy: 'backend/xorgate-core-service: npm run contract:generate',
    wireVersion: 1,
    namespaces,
    uiPrefs: {
      defaults: UI_PREFS_DEFAULTS,
      jsonSchema: namespaceJsonSchema(uiPrefsSchema),
    },
  };
}

/** Stable serialization — the diff test compares text, so formatting matters. */
export function serializeConfigContract(contract: ConfigContract = buildConfigContract()): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
