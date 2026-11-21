import { describe, expect, it } from 'vitest';
import {
  CONFIG_NAMESPACE_KEYS,
  OBD_DEFAULTS,
  OBD_ONLY_NAMESPACES,
  namespaceAllowedFor,
  namespaceRefusalMessage,
  obdConfigSchema,
  validateConfigPatch,
  validateNamespaceValue,
} from '../src/config-registry/index';
import { buildConfigContract } from '../src/config-registry/contract';
import { configOpenApiSchemas, configPatchRequestSchema } from '../src/config-registry/openapi';
import { OBD_FIELDS, type DeviceHardwareBlock } from '../src/schemas/capabilities';
import { buildDeviceConfigMessage } from '../src/services/device-config';

/**
 * The `obd` namespace (plans/obd2-bluetooth-integration, P3 backend, D3/D6):
 * the per-vehicle adapter settings that replace the P1 env seam, and the
 * model-gated fence that keeps them off a kit without an OBD reader.
 */

const MAC = '10:21:3E:4F:33:65';
const full = {
  enabled: true,
  adapterMac: MAC,
  pin: '1234',
  pollHz: 1,
  fields: ['rpm', 'speed'],
  powerSource: 'switched',
};

/** A CM5 hardware block with and without the OBD peripheral. */
const PLAIN: DeviceHardwareBlock = {
  v: 2,
  platform: 'rpi-cm5',
  encoder: 'sw-h264',
  connectors: [],
  sensors: [],
  rails: true,
  statusLed: { r: 12, g: 21, b: 16 },
} as unknown as DeviceHardwareBlock;
const OBD: DeviceHardwareBlock = {
  ...PLAIN,
  peripherals: { obd: { adapter: 'elm327', transport: 'bt-spp' } },
};

describe('obd namespace — schema', () => {
  it('is registered after simulation, and is the only model-gated namespace', () => {
    // It was the last namespace until `cameraSensors` was appended after it
    // (plans/support-other-camera-models); its own position did not move.
    expect(CONFIG_NAMESPACE_KEYS.indexOf('obd')).toBe(8);
    expect(CONFIG_NAMESPACE_KEYS.indexOf('obd')).toBeGreaterThan(CONFIG_NAMESPACE_KEYS.indexOf('simulation'));
    expect(OBD_ONLY_NAMESPACES).toEqual(['obd']);
  });

  it('accepts the full shape and the published defaults', () => {
    expect(validateNamespaceValue('obd', full)).toEqual({ value: full });
    expect(validateNamespaceValue('obd', { ...OBD_DEFAULTS })).toEqual({ value: OBD_DEFAULTS });
    expect(OBD_DEFAULTS).toEqual({
      enabled: false,
      adapterMac: null,
      pin: '1234',
      pollHz: 1,
      fields: [],
      powerSource: 'switched',
    });
  });

  it('every field is optional (omitted = device default), but {} is still not a write', () => {
    expect(validateNamespaceValue('obd', { enabled: false })).toEqual({ value: { enabled: false } });
    expect(
      validateNamespaceValue('obd', { enabled: true, adapterMac: MAC, powerSource: 'switched' }),
    ).toEqual({ value: { enabled: true, adapterMac: MAC, powerSource: 'switched' } });
    expect(validateNamespaceValue('obd', {})).toHaveProperty('error');
    expect(validateNamespaceValue('obd', null)).toEqual({ value: null });
  });

  it('normalises the adapter MAC to uppercase and rejects anything that is not one', () => {
    expect(validateNamespaceValue('obd', { adapterMac: '10:21:3e:4f:33:65' })).toEqual({
      value: { adapterMac: MAC },
    });
    expect(validateNamespaceValue('obd', { adapterMac: null })).toEqual({ value: { adapterMac: null } });
    for (const bad of ['10-21-3E-4F-33-65', '10:21:3E:4F:33', '10:21:3E:4F:33:65:77', 'OBDII', '', 'ZZ:21:3E:4F:33:65', '10:21:3E:4F:33:65\n']) {
      const r = validateNamespaceValue('obd', { adapterMac: bad });
      expect(r, bad).toHaveProperty('error');
      expect((r as { error: string }).error).toContain('obd.adapterMac');
    }
  });

  it('pins the PIN to 4-6 digits (it is fed to bluetoothctl on the device)', () => {
    for (const pin of ['1234', '0000', '123456']) {
      expect(validateNamespaceValue('obd', { pin })).toEqual({ value: { pin } });
    }
    for (const pin of ['123', '1234567', '12a4', '', '1234\n', 1234]) {
      expect(validateNamespaceValue('obd', { pin }), String(pin)).toHaveProperty('error');
    }
  });

  it('bounds pollHz to 0.2..2', () => {
    for (const pollHz of [0.2, 0.5, 1, 2]) {
      expect(validateNamespaceValue('obd', { pollHz })).toEqual({ value: { pollHz } });
    }
    for (const pollHz of [0, 0.1, 2.5, -1, Number.NaN, '1']) {
      expect(validateNamespaceValue('obd', { pollHz }), String(pollHz)).toHaveProperty('error');
    }
  });

  it('restricts fields to the closed OBD vocabulary, without duplicates; empty = all', () => {
    expect(validateNamespaceValue('obd', { fields: [] })).toEqual({ value: { fields: [] } });
    expect(validateNamespaceValue('obd', { fields: [...OBD_FIELDS] })).toEqual({ value: { fields: [...OBD_FIELDS] } });
    const r = validateNamespaceValue('obd', { fields: ['rpm', 'boost'] });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('obd.fields.1');
    expect(validateNamespaceValue('obd', { fields: ['rpm', 'rpm'] })).toHaveProperty('error');
    expect(validateNamespaceValue('obd', { fields: 'rpm' })).toHaveProperty('error');
  });

  it('closes powerSource to switched | constant', () => {
    expect(validateNamespaceValue('obd', { powerSource: 'constant' })).toEqual({ value: { powerSource: 'constant' } });
    expect(validateNamespaceValue('obd', { powerSource: 'battery' })).toHaveProperty('error');
  });

  it('is strict about unknown keys (no `adapter`, `pids` — the plan\'s earlier names)', () => {
    expect(validateNamespaceValue('obd', { adapter: MAC })).toHaveProperty('error');
    expect(validateNamespaceValue('obd', { pids: ['0C'] })).toHaveProperty('error');
    expect(obdConfigSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
  });
});

describe('obd namespace — OBD-model devices only', () => {
  const patch = { obd: { enabled: true, adapterMac: MAC, powerSource: 'switched' } };

  it('is refused for a device whose model does not declare peripherals.obd, naming the reason', () => {
    const r = validateConfigPatch(patch);
    expect(r).toHaveProperty('error');
    const msg = (r as { error: string }).error;
    expect(msg).toContain('obd');
    expect(msg).toContain('peripherals.obd');
    expect(validateConfigPatch(patch, { obd: false })).toHaveProperty('error');
    expect(validateConfigPatch(patch, { simulated: true })).toHaveProperty('error');
    // Alongside a valid namespace: all-or-nothing.
    expect(validateConfigPatch({ ...patch, timeSync: { offlineSources: false } })).toHaveProperty('error');
    // Clearing it is a write too.
    expect(validateConfigPatch({ obd: null })).toHaveProperty('error');
  });

  it('is accepted for an OBD-model device, with the MAC normalised', () => {
    expect(validateConfigPatch(patch, { obd: true })).toEqual({ value: patch });
    expect(
      validateConfigPatch({ obd: { adapterMac: '10:21:3e:4f:33:65' } }, { obd: true }),
    ).toEqual({ value: { obd: { adapterMac: MAC } } });
    expect(validateConfigPatch({ obd: null }, { obd: true })).toEqual({ value: { obd: null } });
  });

  it('is independent of the simulated fence, and leaves every other namespace alone', () => {
    expect(namespaceAllowedFor('obd', {})).toBe(false);
    expect(namespaceAllowedFor('obd', { simulated: true })).toBe(false);
    expect(namespaceAllowedFor('obd', { obd: true })).toBe(true);
    expect(namespaceAllowedFor('simulation', { obd: true })).toBe(false);
    expect(namespaceAllowedFor('recording', {})).toBe(true);
    expect(namespaceAllowedFor('timeSync', { obd: false })).toBe(true);
    expect(validateConfigPatch({ timeSync: { offlineSources: false } }, { obd: false })).toHaveProperty('value');
  });

  it('reports both fences when a patch trips both', () => {
    const msg = namespaceRefusalMessage(['simulation', 'obd']);
    expect(msg).toContain('simulated devices');
    expect(msg).toContain('peripherals.obd');
  });
});

describe('obd namespace — retained publish', () => {
  const doc = { recording: { video: { cameras: { cam1: false } } }, obd: full };

  it('rides after simulation, in registry order, on a device whose hardware block declares obd', () => {
    const msg = buildDeviceConfigMessage({ ...doc, simulation: null }, 7, 0, null, OBD) as Record<string, unknown>;
    expect(msg.obd).toEqual(full);
    const keys = Object.keys(msg);
    expect(keys.indexOf('obd')).toBeGreaterThan(keys.indexOf('simulation'));
    expect(keys.indexOf('obd')).toBeGreaterThan(keys.indexOf('recording'));
    expect(msg.hardware).toEqual(OBD);
  });

  it('publishes the cleared marker as {} on an OBD device', () => {
    const msg = buildDeviceConfigMessage({ obd: null }, 1, 0, null, OBD) as Record<string, unknown>;
    expect(msg.obd).toEqual({});
  });

  it('is DROPPED for a device whose current hardware block has no obd peripheral (stale value after a model move)', () => {
    const plain = buildDeviceConfigMessage(doc, 1, 0, null, PLAIN) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('obd');
    expect(plain.recording).toEqual(doc.recording);
    // v1 model / no block at all: same answer.
    expect(buildDeviceConfigMessage(doc, 1, 0, null, null)).not.toHaveProperty('obd');
    expect(buildDeviceConfigMessage(doc, 1, 0)).not.toHaveProperty('obd');
    // And a cleared marker is not published either (nothing to revert there).
    expect(buildDeviceConfigMessage({ obd: null }, 1, 0, null, PLAIN)).not.toHaveProperty('obd');
  });

  it('is never published for a document that does not carry it', () => {
    const msg = buildDeviceConfigMessage({}, 1, 0, null, OBD) as Record<string, unknown>;
    expect(msg).not.toHaveProperty('obd');
  });

  it('the simulated fence is not re-applied at publish time (nothing can store it on a real row)', () => {
    const sim = { scenarioId: 'city-2026-09-27', loop: true, gapSeconds: 30 };
    const msg = buildDeviceConfigMessage({ simulation: sim }, 1, 0, null, PLAIN) as Record<string, unknown>;
    expect(msg.simulation).toEqual(sim);
  });
});

describe('obd namespace — contract + OpenAPI', () => {
  it('is in the generated contract with its defaults, bounds and enums', () => {
    const ns = buildConfigContract().namespaces.obd;
    expect(ns.applyClass).toBe('agent-poll');
    expect(ns.kind).toBe('object');
    expect(ns.defaults).toEqual(OBD_DEFAULTS);
    const schema = ns.jsonSchema as {
      additionalProperties: boolean;
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.adapterMac).toMatchObject({ type: 'string', nullable: true });
    expect(schema.properties.adapterMac.pattern).toBeDefined();
    expect(schema.properties.pollHz).toMatchObject({ minimum: 0.2, maximum: 2 });
    expect((schema.properties.fields.items as { enum: string[] }).enum).toEqual([...OBD_FIELDS]);
    expect(schema.properties.powerSource.enum).toEqual(['switched', 'constant']);
  });

  it('appears in the generated OpenAPI blocks like every sibling', () => {
    const schemas = configOpenApiSchemas() as Record<string, { properties?: Record<string, unknown> }>;
    expect(schemas.ObdConfig).toBeDefined();
    expect(schemas.DeviceConfig.properties).toHaveProperty('obd');
    const patch = configPatchRequestSchema() as { properties: Record<string, { nullable: boolean }> };
    expect(patch.properties.obd.nullable).toBe(true);
  });
});
