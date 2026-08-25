import { describe, expect, it } from 'vitest';
import {
  deriveHardwareBlock,
  defaultEncoderForPlatform,
  ioCapabilitiesSchema,
  platformFromDtModel,
} from '../src/schemas/capabilities';
import { resolveModel } from '../src/services/model-probe';
import { buildDeviceConfigMessage } from '../src/services/device-config';
import type { DeviceModel } from '../src/db/schema';

/** The live dev/prod CM5 row shape (drifted from the 002 seed), v1. */
const V1_CM5 = {
  schemaVersion: 1,
  media: {
    video: [
      { key: 'cam0', codec: 'h264', label: 'Left', maxWidth: 1280, maxHeight: 720, maxFps: 25 },
      { key: 'cam1', codec: 'h264', label: 'Right', maxWidth: 1280, maxHeight: 720, maxFps: 25 },
    ],
    audio: [{ key: 'audio0', codec: 'opus', sampleRate: 48000, channels: 2 }],
  },
  sensors: {
    imu: {
      accel: ['x', 'y', 'z'],
      quaternion: ['r', 'i', 'j', 'k'],
      euler: ['roll', 'pitch', 'yaw'],
      unit: 'm/s^2',
      rateHz: 10,
    },
  },
  comm: { module: '4g-lte', gps: { fields: ['lat', 'lon'] }, signal: { fields: ['rssi'] } },
  system: { fields: ['cpu_usage', 'cpu_temp', 'rail_5v'] },
};

/** What manual/015 turns the CM5 row into. */
const V2_CM5 = {
  ...V1_CM5,
  schemaVersion: 2,
  media: {
    ...V1_CM5.media,
    video: V1_CM5.media.video.map((v, i) => ({
      ...v,
      connector: `csi${i}`,
      sensor: 'imx290',
    })),
  },
  sensors: { imu: { ...V1_CM5.sensors.imu, model: 'bno085' } },
  system: {
    ...V1_CM5.system,
    platform: 'rpi-cm5',
    encoder: 'sw-h264',
    rails: true,
    statusLed: { r: 12, g: 21, b: 16 },
  },
};

/** What manual/016 seeds. */
const V2_CM4 = {
  schemaVersion: 2,
  system: {
    platform: 'rpi-cm4',
    encoder: 'hw-h264',
    rails: false,
    statusLed: null,
    fields: ['cpu_usage', 'cpu_temp', 'ram_usage', 'disk_usage', 'throttled'],
  },
  sensors: { imu: { model: 'bno085', accel: ['x', 'y', 'z'] } },
  media: {
    audio: [],
    video: [
      {
        key: 'cam0',
        codec: 'h264',
        label: 'Front',
        connector: 'csi0',
        sensor: 'imx290',
        maxWidth: 1280,
        maxHeight: 720,
        maxFps: 25,
      },
    ],
  },
};

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

describe('ioCapabilities schema union', () => {
  it('still accepts the live v1 CM5 document', () => {
    const parsed = ioCapabilitiesSchema.safeParse(V1_CM5);
    expect(parsed.success).toBe(true);
  });

  it('accepts the v2 CM5 and CM4 documents', () => {
    expect(ioCapabilitiesSchema.safeParse(V2_CM5).success).toBe(true);
    expect(ioCapabilitiesSchema.safeParse(V2_CM4).success).toBe(true);
  });

  it('v2 requires system.platform and rejects unknown enums', () => {
    const noPlatform = { ...V2_CM4, system: { ...V2_CM4.system, platform: undefined } };
    expect(ioCapabilitiesSchema.safeParse(noPlatform).success).toBe(false);
    const badEncoder = { ...V2_CM4, system: { ...V2_CM4.system, encoder: 'av1' } };
    expect(ioCapabilitiesSchema.safeParse(badEncoder).success).toBe(false);
    const badPlatform = { ...V2_CM4, system: { ...V2_CM4.system, platform: 'jetson' } };
    expect(ioCapabilitiesSchema.safeParse(badPlatform).success).toBe(false);
  });

  it('v2 video entries require connector + sensor', () => {
    const bare = {
      ...V2_CM4,
      media: { video: [{ key: 'cam0', codec: 'h264' }], audio: [] },
    };
    expect(ioCapabilitiesSchema.safeParse(bare).success).toBe(false);
  });
});

describe('deriveHardwareBlock', () => {
  it('is null for v1, null, and junk documents', () => {
    expect(deriveHardwareBlock(V1_CM5)).toBeNull();
    expect(deriveHardwareBlock(null)).toBeNull();
    expect(deriveHardwareBlock({ additionalProp1: {} })).toBeNull();
  });

  it('projects the CM4 model with its explicit encoder', () => {
    const hw = deriveHardwareBlock(V2_CM4);
    expect(hw).toMatchObject({
      v: 2,
      platform: 'rpi-cm4',
      encoder: 'hw-h264',
      rails: false,
      statusLed: null,
      imu: 'bno085',
    });
    expect(hw!.video).toEqual([
      {
        key: 'cam0',
        connector: 'csi0',
        sensor: 'imx290',
        codec: 'h264',
        label: 'Front',
        maxWidth: 1280,
        maxHeight: 720,
        maxFps: 25,
      },
    ]);
  });

  it('derives the encoder from the platform when omitted', () => {
    const noEncoder = { ...V2_CM4, system: { ...V2_CM4.system, encoder: undefined } };
    expect(deriveHardwareBlock(noEncoder)!.encoder).toBe('hw-h264');
    const cm5NoEncoder = { ...V2_CM5, system: { ...V2_CM5.system, encoder: undefined } };
    expect(deriveHardwareBlock(cm5NoEncoder)!.encoder).toBe('sw-h264');
    expect(defaultEncoderForPlatform('rpi-cm5')).toBe('sw-h264');
    expect(defaultEncoderForPlatform('rpi-cm4')).toBe('hw-h264');
  });

  it('projects the CM5 pin map and rails', () => {
    const hw = deriveHardwareBlock(V2_CM5);
    expect(hw).toMatchObject({
      platform: 'rpi-cm5',
      encoder: 'sw-h264',
      rails: true,
      statusLed: { r: 12, g: 21, b: 16 },
    });
    expect(hw!.video.map((v) => v.connector)).toEqual(['csi0', 'csi1']);
  });
});

describe('platformFromDtModel', () => {
  it('recognizes the bench hardware strings', () => {
    expect(platformFromDtModel('Raspberry Pi Compute Module 4 Rev 1.1')).toBe('rpi-cm4');
    expect(platformFromDtModel('Raspberry Pi Compute Module 5 Rev 1.0')).toBe('rpi-cm5');
    expect(platformFromDtModel('Raspberry Pi 5 Model B Rev 1.0')).toBe('rpi-cm5');
    expect(platformFromDtModel('Raspberry Pi 4 Model B Rev 1.5')).toBe('rpi-cm4');
  });

  it('is null for unknown or absent strings', () => {
    expect(platformFromDtModel('unknown')).toBeNull();
    expect(platformFromDtModel('QEMU Virtual Machine')).toBeNull();
    expect(platformFromDtModel(undefined)).toBeNull();
    expect(platformFromDtModel('')).toBeNull();
  });
});

describe('resolveModel (probe-at-claim)', () => {
  const cm5 = model('cm5', V2_CM5);
  const cm4 = model('cm4', V2_CM4);
  const junk = model('junk', { additionalProp1: {} });
  const v1cm5 = model('v1cm5', V1_CM5);
  const catalog = [junk, v1cm5, cm5, cm4];

  it('maps each bench to its platform row', () => {
    const cm4res = resolveModel(catalog, cm4, {
      dtModel: 'Raspberry Pi Compute Module 4 Rev 1.1',
    });
    expect(cm4res.model.id).toBe('cm4');
    expect(cm4res.needsModel).toBe(false);

    const cm5res = resolveModel(catalog, cm4, {
      dtModel: 'Raspberry Pi Compute Module 5 Rev 1.0',
    });
    expect(cm5res.model.id).toBe('cm5');
    expect(cm5res.needsModel).toBe(false);
  });

  it('flags needs_model on an unrecognized platform, keeping the fallback', () => {
    const res = resolveModel(catalog, cm5, { dtModel: 'unknown' });
    expect(res.model.id).toBe('cm5');
    expect(res.needsModel).toBe(true);
  });

  it('flags needs_model when the platform has no candidate', () => {
    const res = resolveModel([junk, cm5], cm5, {
      dtModel: 'Raspberry Pi Compute Module 4 Rev 1.1',
    });
    expect(res.model.id).toBe('cm5');
    expect(res.needsModel).toBe(true);
  });

  it('narrows an ambiguous platform by camera count when known', () => {
    const cm4dual = model('cm4dual', {
      ...V2_CM4,
      media: {
        audio: [],
        video: [
          { key: 'cam0', codec: 'h264', connector: 'csi0', sensor: 'imx290' },
          { key: 'cam1', codec: 'h264', connector: 'csi1', sensor: 'imx290' },
        ],
      },
    });
    const both = [...catalog, cm4dual];
    const dt = 'Raspberry Pi Compute Module 4 Rev 1.1';

    const withCount = resolveModel(both, cm5, { dtModel: dt, cameras: 2 });
    expect(withCount.model.id).toBe('cm4dual');
    expect(withCount.needsModel).toBe(false);

    // Fresh install: overlays not bound yet, count unknown -> ambiguous.
    const withoutCount = resolveModel(both, cm5, { dtModel: dt, cameras: 0 });
    expect(withoutCount.needsModel).toBe(true);
    expect(withoutCount.model.id).toBe('cm5');
  });
});

describe('config message hardware envelope', () => {
  it('carries the hardware block when supplied and omits it otherwise', () => {
    const hw = deriveHardwareBlock(V2_CM4)!;
    const withHw = buildDeviceConfigMessage({}, 3, 1_700_000_000_000, null, hw);
    expect(withHw.hardware).toEqual(hw);

    const without = buildDeviceConfigMessage({}, 3, 1_700_000_000_000, null, null);
    expect('hardware' in without).toBe(false);

    const legacyCall = buildDeviceConfigMessage({}, 3, 1_700_000_000_000);
    expect('hardware' in legacyCall).toBe(false);
  });
});
