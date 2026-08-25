import { describe, expect, it } from 'vitest';
import {
  CAMERA_MOUNT_DEFAULTS,
  validateNamespaceValue,
} from '../src/config-registry/index';
import { buildDeviceConfigMessage } from '../src/services/device-config';

const parse = (v: unknown) => validateNamespaceValue('cameraMount', v);

/**
 * The `cameraMount` namespace (cam-sensor-level-rotate plan, Phase 1).
 *
 * The load-bearing cases here are the two the device turns into an EDIT OF
 * /boot/firmware/config.txt plus a reboot request: an absent camera key must
 * stay unmanaged (no edit, no reboot prompt on a device nobody configured),
 * and only 0/180 may ever reach the overlay parameter — anything else the
 * cloud let through would be written verbatim into a boot config.
 */
describe('cameraMount config validation', () => {
  it('accepts a per-camera rotation', () => {
    const v = { cameras: { cam0: { rotationDeg: 180 }, cam1: { rotationDeg: 0 } } };
    expect(parse(v)).toEqual({ value: v });
  });

  it('accepts an empty camera map (nothing managed) and null (revert)', () => {
    expect(parse({ cameras: {} })).toEqual({ value: { cameras: {} } });
    expect(parse(null)).toEqual({ value: null });
    // The defaults are that same "manage nothing" document.
    expect(CAMERA_MOUNT_DEFAULTS).toEqual({ cameras: {} });
  });

  it('rejects the empty object ({} is never an erase — null is)', () => {
    expect(parse({})).toHaveProperty('error');
  });

  it('rejects every rotation but 0 and 180', () => {
    for (const deg of [90, 270, 360, -180, 1, 180.5, '180', null, true]) {
      expect(parse({ cameras: { cam0: { rotationDeg: deg } } }), String(deg)).toHaveProperty(
        'error',
      );
    }
  });

  it('rejects unknown keys at both levels (a silent drop would be a wrong picture)', () => {
    expect(parse({ cameras: { cam0: { rotationDeg: 0, flip: true } } })).toHaveProperty('error');
    expect(parse({ cameras: { cam0: { rotationDeg: 0 } }, enabled: true })).toHaveProperty('error');
    // The rotation is required — a camera key with no rotation says nothing.
    expect(parse({ cameras: { cam0: {} } })).toHaveProperty('error');
  });

  it('rejects a key that is not a stream key, and an absurd camera count', () => {
    expect(parse({ cameras: { 'cam 0': { rotationDeg: 0 } } })).toHaveProperty('error');
    expect(parse({ cameras: { '': { rotationDeg: 0 } } })).toHaveProperty('error');
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`cam${i}`, { rotationDeg: 0 }]),
    );
    expect(parse({ cameras: many })).toHaveProperty('error');
  });

  it('rides the retained config message, and stays absent when unconfigured', () => {
    const doc = { cameraMount: { cameras: { cam0: { rotationDeg: 180 as const } } } };
    expect(buildDeviceConfigMessage(doc, 3, 1)).toMatchObject({
      cameraMount: { cameras: { cam0: { rotationDeg: 180 } } },
    });
    // Absent -> omitted (the device keeps whatever it holds); cleared -> `{}`.
    expect(buildDeviceConfigMessage({}, 3, 1)).not.toHaveProperty('cameraMount');
    expect(buildDeviceConfigMessage({ cameraMount: null }, 3, 1).cameraMount).toEqual({});
  });
});
