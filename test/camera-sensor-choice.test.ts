import { describe, expect, it } from 'vitest';
import {
  CAMERA_CATALOG,
  SELECTABLE_SENSOR_IDS,
  resolveSensorOptions,
  validateSensorChoice,
} from '../src/camera-catalog';

const check = (v: unknown, label?: string) => validateSensorChoice(v, label);
const errorOf = (v: unknown, label?: string): string => {
  const out = check(v, label);
  return 'error' in out ? out.error : '';
};

/**
 * `validateSensorChoice` is the catalog half of the `cameraSensors` namespace
 * (Phase 2). What it accepts is written into `/boot/firmware/config.txt` on a
 * device, so the load-bearing cases are the refusals: nothing but a listed
 * sensor with its own listed option values gets through, and each refusal
 * tells the operator what to send instead.
 */
describe('validateSensorChoice', () => {
  it('accepts every selectable sensor with no options', () => {
    for (const id of SELECTABLE_SENSOR_IDS) {
      expect(check({ sensor: id }), id).toEqual({ value: { sensor: id } });
    }
  });

  it('accepts every listed value of every option, and nothing in between', () => {
    for (const sensor of CAMERA_CATALOG.sensors) {
      for (const option of sensor.options) {
        for (const value of option.values) {
          expect(check({ sensor: sensor.id, options: { [option.key]: value } })).toEqual({
            value: { sensor: sensor.id, options: { [option.key]: value } },
          });
        }
        expect(
          errorOf({ sensor: sensor.id, options: { [option.key]: option.values[0] + 1 } }),
          `${sensor.id}.${option.key}`,
        ).toContain(`must be one of ${option.values.join(', ')}`);
      }
    }
  });

  it('returns a canonical value: empty options dropped, an explicit default kept', () => {
    expect(check({ sensor: 'imx708', options: {} })).toEqual({ value: { sensor: 'imx708' } });
    expect(check({ sensor: 'imx708', options: undefined })).toEqual({
      value: { sensor: 'imx708' },
    });
    expect(check({ sensor: 'imx219', options: {} })).toEqual({ value: { sensor: 'imx219' } });
    // Setting the overlay default explicitly is a statement, not noise.
    expect(check({ sensor: 'imx290', options: { clockFrequency: 37125000 } })).toEqual({
      value: { sensor: 'imx290', options: { clockFrequency: 37125000 } },
    });
    // The result is a fresh object, never the caller's.
    const sent = { sensor: 'imx290', options: { clockFrequency: 74250000 } };
    const out = check(sent);
    expect('value' in out && out.value).not.toBe(sent);
    expect('value' in out && out.value.options).not.toBe(sent.options);
  });

  it('names an unknown sensor and lists the known ones', () => {
    expect(errorOf({ sensor: 'imx477' })).toBe(
      'camera.sensor: "imx477" is not a known camera sensor (known: imx290, imx219, imx708, imx335)',
    );
    // Ids are exact: no case folding, no trimming, no overlay-family guessing.
    for (const id of ['IMX290', ' imx290', 'imx290 ', 'imx327', 'imx462', 'imx290,cam0']) {
      expect(errorOf({ sensor: id }), id).toContain('is not a known camera sensor');
    }
  });

  it('says a planned sensor is planned, and what it is waiting for', () => {
    expect(errorOf({ sensor: 'imx662' })).toBe(
      'camera.sensor: "imx662" (Sony IMX662) is planned and cannot be selected yet ' +
        '(it needs a device image on Debian trixie); available: imx290, imx219, imx708, imx335',
    );
    // Options do not change that.
    expect(errorOf({ sensor: 'imx662', options: {} })).toContain('is planned');
  });

  it('does not accept the reserved "none": the namespace handles an empty port itself', () => {
    // Phase 2's namespace schema accepts {sensor: "none"} BEFORE asking the
    // catalog. Here it is simply not a sensor.
    expect(errorOf({ sensor: 'none' })).toContain('"none" is not a known camera sensor');
  });

  it('requires a sensor, as a string', () => {
    for (const v of [{}, { options: {} }, { sensor: '' }, { sensor: null }, { sensor: 290 }]) {
      expect(errorOf(v), JSON.stringify(v)).toBe(
        'camera.sensor: required, one of: imx290, imx219, imx708, imx335',
      );
    }
    expect(errorOf({ sensor: ['imx290'] })).toContain('camera.sensor: required');
  });

  it('refuses a value that is not an object', () => {
    for (const v of [null, undefined, 'imx290', 7, true, ['imx290'], []]) {
      expect(errorOf(v), String(v)).toBe('camera: must be an object like {"sensor": "imx290"}');
    }
  });

  it('refuses unknown keys beside sensor and options', () => {
    expect(errorOf({ sensor: 'imx290', rotationDeg: 180 })).toBe(
      'camera.rotationDeg: unknown key (a camera takes only "sensor" and "options")',
    );
    expect(errorOf({ sensor: 'imx290', option: {} })).toContain('camera.option: unknown key');
  });

  it('refuses an option the sensor does not have, naming the ones it has', () => {
    expect(errorOf({ sensor: 'imx708', options: { clockFrequency: 37125000 } })).toBe(
      'camera.options.clockFrequency: imx708 has no option "clockFrequency" ' +
        '(its options: linkFrequency)',
    );
    // The overlay PARAMETER name is not the option key.
    expect(errorOf({ sensor: 'imx708', options: { 'link-frequency': 450000000 } })).toContain(
      'imx708 has no option "link-frequency"',
    );
    expect(errorOf({ sensor: 'imx219', options: { linkFrequency: 450000000 } })).toBe(
      'camera.options.linkFrequency: imx219 has no option "linkFrequency" ' +
        '(it takes no options, so remove "options")',
    );
    // An unknown key fails even when a known one beside it is fine.
    expect(
      errorOf({ sensor: 'imx290', options: { clockFrequency: 74250000, mono: 1 } }),
    ).toContain('imx290 has no option "mono"');
  });

  it('refuses a value outside the list, saying what was sent', () => {
    expect(errorOf({ sensor: 'imx290', options: { clockFrequency: 24000000 } })).toBe(
      'camera.options.clockFrequency: must be one of 37125000, 74250000 Hz (got 24000000)',
    );
    // Another sensor's valid value is still wrong here.
    expect(errorOf({ sensor: 'imx335', options: { linkFrequency: 450000000 } })).toBe(
      'camera.options.linkFrequency: must be one of 594000000, 445500000 Hz (got 450000000)',
    );
    // No coercion: the value is written verbatim into a boot config.
    for (const v of ['74250000', 74250000.5, null, true, [74250000], { v: 74250000 }, NaN]) {
      expect(
        errorOf({ sensor: 'imx290', options: { clockFrequency: v } }),
        JSON.stringify(v),
      ).toContain('camera.options.clockFrequency: must be one of 37125000, 74250000 Hz (got ');
    }
    expect(errorOf({ sensor: 'imx290', options: { clockFrequency: '74250000' } })).toContain(
      '(got "74250000")',
    );
  });

  it('refuses options that are not an object, with an example', () => {
    for (const v of [null, 'x', 5, [], [74250000]]) {
      expect(errorOf({ sensor: 'imx290', options: v }), JSON.stringify(v)).toBe(
        'camera.options: must be an object of option values, e.g. {"clockFrequency": 37125000}',
      );
    }
    expect(errorOf({ sensor: 'imx219', options: null })).toBe(
      'camera.options: must be an object; imx219 takes no options, so leave it out',
    );
  });

  it('cuts a long sent value or key short instead of echoing it whole', () => {
    const blob = 'x'.repeat(5000);
    for (const v of [
      { sensor: blob },
      { sensor: 'imx290', [blob]: 1 },
      { sensor: 'imx290', options: { [blob]: 1 } },
      { sensor: 'imx290', options: { clockFrequency: blob } },
    ]) {
      const error = errorOf(v);
      expect(error.length).toBeLessThan(260);
      expect(error).toContain('...');
    }
    expect(errorOf({ sensor: 'imx290', options: { clockFrequency: NaN } })).toContain('(got NaN)');
  });

  it('reads own keys only (the value is user input)', () => {
    expect(errorOf(Object.create({ sensor: 'imx290' }))).toContain('camera.sensor: required');
    const inherited = Object.create({ clockFrequency: 74250000 });
    expect(check({ sensor: 'imx290', options: inherited })).toEqual({
      value: { sensor: 'imx290' },
    });
    expect(errorOf(JSON.parse('{"sensor":"imx290","__proto__":{"x":1}}'))).toContain(
      'camera.__proto__: unknown key',
    );
    expect(errorOf({ sensor: 'imx290', options: JSON.parse('{"constructor":1}') })).toContain(
      'imx290 has no option "constructor"',
    );
  });

  it('prefixes the path with the caller\'s label', () => {
    const label = 'cameraSensors.cameras.cam1';
    expect(errorOf({ sensor: 'imx477' }, label)).toMatch(/^cameraSensors\.cameras\.cam1\.sensor: /);
    expect(errorOf({ sensor: 'imx290', options: { clockFrequency: 1 } }, label)).toMatch(
      /^cameraSensors\.cameras\.cam1\.options\.clockFrequency: /,
    );
    expect(errorOf(null, label)).toMatch(/^cameraSensors\.cameras\.cam1: /);
  });

  it('does not depend on the rotation default, so a sensor that cannot flip validates alike', () => {
    // imx335 cannot be rotated and its overlay default is still being
    // measured. A choice of it is judged on id and options only.
    expect(check({ sensor: 'imx335', options: { linkFrequency: 445500000 } })).toEqual({
      value: { sensor: 'imx335', options: { linkFrequency: 445500000 } },
    });
  });
});

describe('resolveSensorOptions', () => {
  it('fills every option with what was set, else the overlay default', () => {
    expect(resolveSensorOptions({ sensor: 'imx290' })).toEqual({ clockFrequency: 37125000 });
    expect(
      resolveSensorOptions({ sensor: 'imx290', options: { clockFrequency: 74250000 } }),
    ).toEqual({ clockFrequency: 74250000 });
    expect(resolveSensorOptions({ sensor: 'imx219' })).toEqual({});
  });

  it('returns null for a sensor that is not selectable', () => {
    expect(resolveSensorOptions({ sensor: 'imx662' })).toBeNull();
    expect(resolveSensorOptions({ sensor: 'none' })).toBeNull();
  });
});
