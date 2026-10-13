import { describe, expect, it } from 'vitest';
import {
  OBD_FIELDS,
  deriveHardwareBlock,
  ioCapabilitiesSchema,
  ioCapabilitiesV1Schema,
} from '../src/schemas/capabilities';
import { resolveModel } from '../src/services/model-probe';
import { historyColumnKeys, orderColumnsByModel } from '../src/services/telemetry-columns';
import { missingCapabilities, producibleMetricKeys } from '../src/services/workflow-capabilities';
import type { DeviceModel } from '../src/db/schema';

/**
 * obd2-bluetooth-integration plan, P2 backend (D2, D4, D8): the v2
 * `peripherals.obd` section, its projection onto the hardware block, and the
 * three io_capabilities consumers that turn it into `obd.<field>` metrics.
 */

/** The live XG-RPI-REF-1 row, as read from prod on 2026-10-13. */
const CM5 = {
  schemaVersion: 2,
  comm: {
    gps: { fields: ['lat', 'lon', 'alt', 'speed'] },
    module: '4g-lte',
    signal: { fields: ['rssi', 'quality'] },
  },
  media: {
    audio: [{ key: 'audio0', codec: 'opus', channels: 2, sampleRate: 48000 }],
    video: [
      { key: 'cam0', codec: 'h264', label: 'Left', connector: 'csi0', sensor: 'imx290' },
      { key: 'cam1', codec: 'h264', label: 'Right', connector: 'csi1', sensor: 'imx290' },
    ],
  },
  system: {
    rails: true,
    fields: ['cpu_usage', 'cpu_temp', 'ram_usage'],
    encoder: 'sw-h264',
    platform: 'rpi-cm5',
    statusLed: { b: 16, g: 21, r: 12 },
  },
  sensors: {
    imu: { accel: ['x', 'y', 'z'], euler: ['roll', 'pitch', 'yaw'], model: 'bno085', rateHz: 10 },
  },
};

/** What manual/035 seeds: the CM5 row plus the peripherals section. */
const OBD_SECTION = {
  obd: {
    adapter: 'elm327',
    transport: 'bt-spp',
    rateHz: 1,
    fields: [...OBD_FIELDS],
    info: ['vin', 'cal_ids', 'ecu_names', 'dtcs'],
  },
};
const CM5_OBD = { ...CM5, peripherals: OBD_SECTION };

function model(id: string, caps: unknown): DeviceModel {
  return {
    id,
    name: id,
    sku: id,
    ioCapabilities: caps,
    firmwareChannel: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as DeviceModel;
}

describe('peripherals.obd schema', () => {
  it('accepts the seeded clone and the base row alike', () => {
    expect(ioCapabilitiesSchema.safeParse(CM5).success).toBe(true);
    expect(ioCapabilitiesSchema.safeParse(CM5_OBD).success).toBe(true);
  });

  it('the brief freezes 21 field names, link included', () => {
    expect(OBD_FIELDS).toHaveLength(21);
    expect(OBD_FIELDS).toContain('link');
    expect(new Set(OBD_FIELDS).size).toBe(OBD_FIELDS.length);
  });

  it('is closed: unknown fields, adapters and transports are rejected at their path', () => {
    const badField = {
      ...CM5,
      peripherals: { obd: { ...OBD_SECTION.obd, fields: ['rpm', 'boost'] } },
    };
    const r1 = ioCapabilitiesSchema.safeParse(badField);
    expect(r1.success).toBe(false);
    expect(r1.success ? [] : r1.error.issues[0].path).toEqual(['peripherals', 'obd', 'fields', 1]);

    const badAdapter = {
      ...CM5,
      peripherals: { obd: { ...OBD_SECTION.obd, adapter: 'stn1110' } },
    };
    expect(ioCapabilitiesSchema.safeParse(badAdapter).success).toBe(false);

    const badTransport = {
      ...CM5,
      peripherals: { obd: { ...OBD_SECTION.obd, transport: 'ble' } },
    };
    expect(ioCapabilitiesSchema.safeParse(badTransport).success).toBe(false);

    // An unknown peripheral entry is STRIPPED, not rejected: z.object's
    // default, the same tolerance every other section has for a future key.
    const unknownPeripheral = { ...CM5, peripherals: { j1939: {} } };
    const r2 = ioCapabilitiesSchema.safeParse(unknownPeripheral);
    expect(r2.success).toBe(true);
    expect(r2.success ? r2.data : null).toMatchObject({ peripherals: {} });
    expect(deriveHardwareBlock(unknownPeripheral)!.peripherals).toBeUndefined();
  });

  it('requires adapter, transport and fields; rateHz and info are optional', () => {
    const minimal = {
      ...CM5,
      peripherals: { obd: { adapter: 'elm327', transport: 'usb-serial', fields: ['rpm', 'link'] } },
    };
    expect(ioCapabilitiesSchema.safeParse(minimal).success).toBe(true);
    const noFields = {
      ...CM5,
      peripherals: { obd: { adapter: 'elm327', transport: 'bt-spp' } },
    };
    expect(ioCapabilitiesSchema.safeParse(noFields).success).toBe(false);
  });

  it('v1 is untouched: it has no peripherals key', () => {
    const v1 = { schemaVersion: 1, system: { fields: ['cpu_temp'] }, peripherals: OBD_SECTION };
    // z.object strips unknown keys rather than failing, so v1 parses but the
    // section is dropped: a v1 model can never declare OBD.
    const parsed = ioCapabilitiesV1Schema.safeParse(v1);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'peripherals' in parsed.data).toBe(false);
  });
});

describe('deriveHardwareBlock with peripherals', () => {
  it('projects adapter + transport only, and only when declared', () => {
    const hw = deriveHardwareBlock(CM5_OBD)!;
    expect(hw.peripherals).toEqual({ obd: { adapter: 'elm327', transport: 'bt-spp' } });
    // Nothing else moves: the base model's block is byte-identical.
    const { peripherals: _p, ...rest } = hw;
    expect(rest).toEqual(deriveHardwareBlock(CM5));
  });

  it('omits the key entirely (absent, not null) when the model has no peripherals', () => {
    const hw = deriveHardwareBlock(CM5)!;
    expect('peripherals' in hw).toBe(false);
    expect(JSON.stringify(hw)).not.toContain('peripherals');
  });

  it('omits the key when peripherals is declared but empty', () => {
    const hw = deriveHardwareBlock({ ...CM5, peripherals: {} })!;
    expect('peripherals' in hw).toBe(false);
  });
});

describe('obd.* metrics from peripherals.obd.fields', () => {
  it('history columns gain obd.<field> after gps, in declared order', () => {
    const base = historyColumnKeys(CM5);
    const withObd = historyColumnKeys(CM5_OBD);
    expect(withObd.slice(0, base.length)).toEqual(base);
    expect(withObd.slice(base.length)).toEqual(OBD_FIELDS.map((f) => `obd.${f}`));
    expect(withObd.at(-1)).toBe('obd.link');
  });

  it('a declared subset yields exactly that subset', () => {
    const subset = {
      ...CM5,
      peripherals: { obd: { adapter: 'elm327', transport: 'bt-spp', fields: ['speed', 'rpm'] } },
    };
    const cols = historyColumnKeys(subset);
    expect(cols.filter((c) => c.startsWith('obd.'))).toEqual(['obd.speed', 'obd.rpm']);
  });

  it('orderColumnsByModel ranks obd columns like any other declared metric', () => {
    expect(orderColumnsByModel(['obd.rpm', 'gps.lat', 'obd.link'], CM5_OBD)).toEqual([
      'gps.lat',
      'obd.rpm',
      'obd.link',
    ]);
  });

  it('producibleMetricKeys lists every obd.<field> so a metric:obd.* trigger attaches', () => {
    const keys = producibleMetricKeys(CM5_OBD as never);
    for (const f of OBD_FIELDS) expect(keys.has(`obd.${f}`)).toBe(true);
    expect(producibleMetricKeys(CM5 as never).has('obd.rpm')).toBe(false);
    expect(missingCapabilities(['metric:obd.rpm', 'metric:gps.lat'], CM5_OBD)).toEqual([]);
    expect(missingCapabilities(['metric:obd.rpm'], CM5)).toEqual(['metric:obd.rpm']);
  });
});

describe('probe-at-claim with the OBD clone in the catalog (C12)', () => {
  it('is ambiguous with the base model: same platform, same camera count', () => {
    const base = model('base', CM5);
    const clone = model('clone', CM5_OBD);
    const res = resolveModel([base, clone], base, {
      dtModel: 'Raspberry Pi Compute Module 5 Rev 1.0',
      cameras: 2,
    });
    // Deliberately unchanged semantics: the registration pins the model for the
    // pilot (modelPinned), or the operator resolves needs_model in the console.
    expect(res.needsModel).toBe(true);
    expect(res.model.id).toBe('base');
    expect(res.reason).toContain('ambiguous: 2 rpi-cm5 models match');
  });
});
