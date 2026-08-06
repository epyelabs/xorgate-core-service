import type { ZodTypeAny } from 'zod';
import { CONFIG_NAMESPACES } from './index';
import { namespaceJsonSchema } from './contract';
import { uiPrefsSchema, UI_PREFS_DEFAULTS } from './ui-prefs';

/**
 * OpenAPI blocks GENERATED from the config registry, spliced into
 * `handlers/docs.ts`.
 *
 * The blocks these replace were hand-written and had gone stale: the
 * `powerShedding` block carried `additionalProperties: false` while omitting
 * the three thermal keys the API had accepted and delivered for two releases —
 * so the published contract actively lied about a valid request. Generated
 * blocks cannot drift: the same zod schema validates the request, builds the
 * retained message, and produces this documentation.
 */

/** `components.schemas` entries for every config namespace + the ui-prefs doc. */
export function configOpenApiSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ns of CONFIG_NAMESPACES) {
    out[ns.title] = {
      ...(namespaceJsonSchema(ns.schema as ZodTypeAny) as Record<string, unknown>),
      description: ns.description,
    };
  }
  out.DeviceConfig = {
    type: 'object',
    additionalProperties: false,
    description:
      'The consolidated device config document (`devices.config`). One key per namespace, all ' +
      'optional — an ABSENT namespace means the device uses its own defaults. Namespace keys are ' +
      'the wire/settings.json keys and are never renamed. Published verbatim (plus `v`, `rev`, ' +
      '`uploadBucket`, `ts`) as a retained MQTT message on `xorgate/devices/{id}/config`.',
    properties: Object.fromEntries(
      CONFIG_NAMESPACES.map((ns) => [
        ns.key,
        { allOf: [{ $ref: `#/components/schemas/${ns.title}` }] },
      ]),
    ),
  };
  out.DeviceUiPrefs = {
    ...(namespaceJsonSchema(uiPrefsSchema) as Record<string, unknown>),
    description:
      'Cloud-only presentation preferences (`devices.ui_prefs`). NEVER delivered to the device ' +
      'and never bumps `configRev`. Absent keys fall back to ' +
      `${JSON.stringify(UI_PREFS_DEFAULTS)}.`,
  };
  return out;
}

/**
 * `PATCH /devices/{id}/config` request body: the same document, but each
 * namespace additionally accepts `null` — "revert this namespace to device
 * defaults" (the key is deleted from the stored doc and omitted from the
 * published message). An empty object is rejected; it is never an erase.
 */
export function configPatchRequestSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    description:
      'Partial config document. Present namespaces are validated and replaced WHOLE (matching ' +
      'how the device merges); `null` reverts a namespace to device defaults; absent namespaces ' +
      'are untouched; `{}` is rejected. All-or-nothing: any invalid namespace fails the whole ' +
      'request, so a multi-namespace save can never half-commit.',
    properties: Object.fromEntries(
      CONFIG_NAMESPACES.map((ns) => [
        ns.key,
        {
          allOf: [{ $ref: `#/components/schemas/${ns.title}` }],
          nullable: true,
          description: `${ns.description} Apply class: \`${ns.applyClass}\`. null reverts to device defaults.`,
        },
      ]),
    ),
  };
}

/** `PATCH /devices/{id}/ui-prefs` request body (each key nullable = reset). */
export function uiPrefsPatchRequestSchema(): Record<string, unknown> {
  const base = namespaceJsonSchema(uiPrefsSchema) as {
    properties: Record<string, Record<string, unknown>>;
  };
  return {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    description:
      'Partial ui-prefs document. `null` resets a pref to its default. Cloud-only: nothing here ' +
      'is delivered to the device, and `configRev` is not bumped.',
    properties: Object.fromEntries(
      Object.entries(base.properties).map(([key, value]) => [key, { ...value, nullable: true }]),
    ),
  };
}
