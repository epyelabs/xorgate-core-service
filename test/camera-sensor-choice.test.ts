import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CAMERA_CATALOG,
  CAMERA_SENSOR_ID_RE,
  SELECTABLE_SENSOR_IDS,
  formatSensorChoiceIssue,
  resolveSensorOptions,
  validateSensorChoice,
  type SensorChoiceIssue,
} from '../src/camera-catalog';

const check = (v: unknown) => validateSensorChoice(v);
const issuesOf = (v: unknown): SensorChoiceIssue[] => {
  const out = check(v);
  return 'issues' in out ? out.issues : [];
};
/** The first issue as text, the way a caller outside a schema prints it. */
const errorOf = (v: unknown, label?: string): string => {
  const [first] = issuesOf(v);
  return first ? formatSensorChoiceIssue(first, label) : '';
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

  it('normalizes: empty options dropped, an explicit default kept', () => {
    expect(check({ sensor: 'imx708', options: {} })).toEqual({ value: { sensor: 'imx708' } });
    expect(check({ sensor: 'imx708', options: undefined })).toEqual({
      value: { sensor: 'imx708' },
    });
    expect(check({ sensor: 'imx219', options: {} })).toEqual({ value: { sensor: 'imx219' } });
    // Setting the overlay default explicitly is a statement, not noise: it is
    // kept, so the stored form is NOT minimal ...
    expect(check({ sensor: 'imx290', options: { clockFrequency: 37125000 } })).toEqual({
      value: { sensor: 'imx290', options: { clockFrequency: 37125000 } },
    });
    // ... and two choices are compared through resolveSensorOptions.
    expect(resolveSensorOptions({ sensor: 'imx290', options: { clockFrequency: 37125000 } })).toEqual(
      resolveSensorOptions({ sensor: 'imx290' }),
    );
    // The result is a fresh object, never the caller's.
    const sent = { sensor: 'imx290', options: { clockFrequency: 74250000 } };
    const out = check(sent);
    expect('value' in out && out.value).not.toBe(sent);
    expect('value' in out && out.value.options).not.toBe(sent.options);
  });

  it('names an unknown sensor and lists the known ones', () => {
    expect(issuesOf({ sensor: 'imx477' })).toEqual([
      {
        path: ['sensor'],
        message:
          '"imx477" is not a known camera sensor (known: imx290, imx219, imx708, imx335, imx662)',
      },
    ]);
    // Ids are exact: no case folding, no trimming, no overlay-family guessing.
    for (const id of ['IMX290', ' imx290', 'imx290 ', 'imx327', 'imx462', 'imx290,cam0']) {
      expect(errorOf({ sensor: id }), id).toContain('is not a known camera sensor');
    }
  });

  it('says a planned sensor is planned, and what it is waiting for', async () => {
    // The shipped catalog has no planned entry since version 4 (the IMX662
    // became a sensor), so the branch is exercised on a catalog that has one.
    vi.resetModules();
    vi.doMock('../src/camera-catalog/data', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/camera-catalog/data')>();
      return {
        ...real,
        CAMERA_CATALOG_SOURCE: {
          ...real.CAMERA_CATALOG_SOURCE,
          planned: [
            {
              id: 'imx678',
              label: 'Sony IMX678',
              tier: 'planned',
              requires: { os: ['trixie'] },
              notes: ['Not available yet.'],
            },
          ],
        },
      };
    });
    try {
      const mocked = await import('../src/camera-catalog/sensor-choice');
      const first = (v: unknown) => {
        const out = mocked.validateSensorChoice(v);
        return 'issues' in out ? mocked.formatSensorChoiceIssue(out.issues[0]) : '';
      };
      expect(first({ sensor: 'imx678' })).toBe(
        'camera.sensor: "imx678" (Sony IMX678) is planned and cannot be selected yet ' +
          '(it needs a device image on Debian trixie); available: imx290, imx219, imx708, ' +
          'imx335, imx662',
      );
      // Options do not change that.
      expect(first({ sensor: 'imx678', options: {} })).toContain('is planned');
    } finally {
      vi.doUnmock('../src/camera-catalog/data');
      vi.resetModules();
    }
  });

  it('accepts the imx662 (catalog 4) with and without its clock frequency', () => {
    expect(check({ sensor: 'imx662' })).toEqual({ value: { sensor: 'imx662' } });
    for (const hz of [24000000, 27000000, 37125000, 72000000, 74250000]) {
      expect(check({ sensor: 'imx662', options: { clockFrequency: hz } }), String(hz)).toEqual({
        value: { sensor: 'imx662', options: { clockFrequency: hz } },
      });
    }
    expect(resolveSensorOptions({ sensor: 'imx662' })).toEqual({ clockFrequency: 24000000 });
    // A clock the overlay does not list: refused in the same sentence as
    // every other option value.
    expect(issuesOf({ sensor: 'imx662', options: { clockFrequency: 25000000 } })).toEqual([
      {
        path: ['options', 'clockFrequency'],
        message:
          'must be one of 24000000, 27000000, 37125000, 72000000, 74250000 Hz (got 25000000)',
      },
    ]);
    // It has no 4lane or link-frequency option in catalog 4.
    expect(errorOf({ sensor: 'imx662', options: { linkFrequency: 594000000 } })).toBe(
      'camera.options: imx662 has no option "linkFrequency" (its options: clockFrequency)',
    );
  });

  it('does not accept the reserved "none": the namespace handles an empty port itself', () => {
    // Phase 2's namespace schema accepts {sensor: "none"} BEFORE asking the
    // catalog, and refuses options beside it. Here it is simply not a sensor.
    expect(errorOf({ sensor: 'none' })).toContain('"none" is not a known camera sensor');
  });

  it('requires a sensor, as a string', () => {
    for (const v of [{}, { options: {} }, { sensor: '' }, { sensor: null }, { sensor: 290 }]) {
      expect(errorOf(v), JSON.stringify(v)).toBe(
        'camera.sensor: required, one of: imx290, imx219, imx708, imx335, imx662',
      );
    }
    expect(errorOf({ sensor: ['imx290'] })).toContain('camera.sensor: required');
  });

  it('refuses a value that is not an object', () => {
    for (const v of [null, undefined, 'imx290', 7, true, ['imx290'], []]) {
      expect(issuesOf(v), String(v)).toEqual([
        { path: [], message: 'must be an object like {"sensor": "imx290"}' },
      ]);
    }
    expect(errorOf(null)).toBe('camera: must be an object like {"sensor": "imx290"}');
  });

  it('refuses unknown keys beside sensor and options', () => {
    expect(errorOf({ sensor: 'imx290', rotationDeg: 180 })).toBe(
      'camera: unknown key "rotationDeg" (a camera takes only "sensor" and "options")',
    );
    expect(errorOf({ sensor: 'imx290', option: {} })).toContain('camera: unknown key "option"');
  });

  it('refuses an option the sensor does not have, naming the ones it has', () => {
    expect(errorOf({ sensor: 'imx708', options: { clockFrequency: 37125000 } })).toBe(
      'camera.options: imx708 has no option "clockFrequency" (its options: linkFrequency)',
    );
    // The overlay PARAMETER name is not the option key.
    expect(errorOf({ sensor: 'imx708', options: { 'link-frequency': 450000000 } })).toContain(
      'imx708 has no option "link-frequency"',
    );
    expect(errorOf({ sensor: 'imx219', options: { linkFrequency: 450000000 } })).toBe(
      'camera.options: imx219 has no option "linkFrequency" ' +
        '(it takes no options, so remove "options")',
    );
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
    expect(errorOf({ sensor: 'imx290', options: { clockFrequency: NaN } })).toContain('(got NaN)');
  });

  it('reports every problem in options at once, unknown keys first', () => {
    expect(
      issuesOf({ sensor: 'imx290', options: { clockFrequency: 1, mono: 1, lanes: 4 } }),
    ).toEqual([
      { path: ['options'], message: 'imx290 has no option "mono" (its options: clockFrequency)' },
      { path: ['options'], message: 'imx290 has no option "lanes" (its options: clockFrequency)' },
      {
        path: ['options', 'clockFrequency'],
        message: 'must be one of 37125000, 74250000 Hz (got 1)',
      },
    ]);
    // An unknown key fails even when the known one beside it is fine.
    expect(issuesOf({ sensor: 'imx290', options: { clockFrequency: 74250000, mono: 1 } })).toEqual([
      { path: ['options'], message: 'imx290 has no option "mono" (its options: clockFrequency)' },
    ]);
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

  it('never puts input into a path, and escapes and cuts what it echoes', () => {
    const blob = 'x'.repeat(5000);
    const cases = [
      { sensor: blob },
      { sensor: 'imx290', [blob]: 1 },
      { sensor: 'imx290', options: { [blob]: 1 } },
      { sensor: 'imx290', options: { clockFrequency: blob } },
    ];
    for (const v of cases) {
      const [issue] = issuesOf(v);
      expect(issue.message.length).toBeLessThan(260);
      expect(issue.message).toContain('...');
      // Paths hold only "sensor", "options" and catalog option keys.
      for (const segment of issue.path) expect(segment).toMatch(/^[A-Za-z]{1,32}$/);
    }
    // A key is echoed like a value: JSON-quoted, control characters escaped.
    const nasty = 'a\nb\u001b[31m"c';
    for (const v of [
      { sensor: 'imx290', [nasty]: 1 },
      { sensor: 'imx290', options: { [nasty]: 1 } },
      { sensor: nasty },
    ]) {
      const [issue] = issuesOf(v);
      expect(issue.message).toContain('"a\\nb\\u001b[31m\\"c"');
      expect(issue.message).not.toMatch(/[\u0000-\u001f]/);
    }
    // The cut never leaves half of a surrogate pair behind.
    const emoji = `${'x'.repeat(55)}${'\u{1F4F7}'.repeat(10)}`; // the pair straddles the cut
    for (const v of [{ sensor: emoji }, { sensor: 'imx290', [emoji]: 1 }]) {
      const [issue] = issuesOf(v);
      expect(issue.message).toContain('...');
      expect(issue.message).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(issue.message).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  it('reads own keys only (the value is user input)', () => {
    expect(errorOf(Object.create({ sensor: 'imx290' }))).toContain('camera.sensor: required');
    const inherited = Object.create({ clockFrequency: 74250000 });
    expect(check({ sensor: 'imx290', options: inherited })).toEqual({
      value: { sensor: 'imx290' },
    });
    expect(errorOf(JSON.parse('{"sensor":"imx290","__proto__":{"x":1}}'))).toContain(
      'camera: unknown key "__proto__"',
    );
    expect(errorOf({ sensor: 'imx290', options: JSON.parse('{"constructor":1}') })).toContain(
      'imx290 has no option "constructor"',
    );
  });

  it('formats an issue under the caller\'s label, once', () => {
    const label = 'cameraSensors.cameras.cam1';
    expect(errorOf({ sensor: 'imx477' }, label)).toMatch(/^cameraSensors\.cameras\.cam1\.sensor: "/);
    expect(errorOf({ sensor: 'imx290', options: { clockFrequency: 1 } }, label)).toMatch(
      /^cameraSensors\.cameras\.cam1\.options\.clockFrequency: must be/,
    );
    expect(errorOf(null, label)).toMatch(/^cameraSensors\.cameras\.cam1: must be an object/);
    // No message carries a path of its own, so a schema that supplies the
    // path cannot print it twice.
    for (const v of [null, {}, { sensor: 'x' }, { sensor: 'imx290', options: { a: 1 } }]) {
      for (const issue of issuesOf(v)) expect(issue.message).not.toMatch(/^camera\b/);
    }
  });

  it('composes with a namespace schema the way Phase 2 will use it', () => {
    // The shape the ruling in sensor-choice.ts describes: `sensor` is a
    // constrained string (NOT an enum of ids, so the published contract does
    // not move with the catalog), `none` is the namespace's own, and the
    // catalog check runs in a superRefine that forwards structured issues.
    const entry = z
      .object({
        sensor: z.union([z.literal('none'), z.string().regex(CAMERA_SENSOR_ID_RE)]),
        options: z.record(z.string(), z.number()).optional(),
      })
      .strict();
    const schema = z
      .object({ cameras: z.record(z.string(), entry) })
      .strict()
      .superRefine((doc, ctx) => {
        for (const [key, value] of Object.entries(doc.cameras)) {
          if (value.sensor === 'none') {
            if (value.options !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['cameras', key, 'options'],
                message: 'an empty port takes no options',
              });
            }
            continue;
          }
          const checked = validateSensorChoice(value);
          if ('issues' in checked) {
            for (const issue of checked.issues) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['cameras', key, ...issue.path],
                message: issue.message,
              });
            }
          }
        }
      });
    // The registry's formatter: `${label}.${path.join('.')}: ${message}`.
    const firstError = (doc: unknown): string => {
      const parsed = schema.safeParse(doc);
      if (parsed.success) return '';
      const issue = parsed.error.issues[0];
      return `cameraSensors.${issue.path.join('.')}: ${issue.message}`;
    };

    expect(
      firstError({
        cameras: {
          cam0: { sensor: 'imx708' },
          cam1: { sensor: 'imx290', options: { clockFrequency: 74250000 } },
          cam2: { sensor: 'none' },
        },
      }),
    ).toBe('');
    expect(firstError({ cameras: { cam0: { sensor: 'imx477' } } })).toBe(
      'cameraSensors.cameras.cam0.sensor: "imx477" is not a known camera sensor ' +
        '(known: imx290, imx219, imx708, imx335, imx662)',
    );
    expect(
      firstError({ cameras: { cam1: { sensor: 'imx290', options: { clockFrequency: 5 } } } }),
    ).toBe(
      'cameraSensors.cameras.cam1.options.clockFrequency: must be one of 37125000, 74250000 Hz (got 5)',
    );
    expect(firstError({ cameras: { cam0: { sensor: 'none', options: {} } } })).toBe(
      'cameraSensors.cameras.cam0.options: an empty port takes no options',
    );
    // The id shape is exported for exactly this, and every catalog id fits it.
    for (const id of SELECTABLE_SENSOR_IDS) expect(id).toMatch(CAMERA_SENSOR_ID_RE);
  });

  it('does not depend on the rotation default, so a sensor that cannot flip validates alike', () => {
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
    expect(resolveSensorOptions({ sensor: 'imx219', options: {} })).toEqual({});
  });

  it('returns null for a sensor that is not selectable', () => {
    expect(resolveSensorOptions({ sensor: 'imx678' })).toBeNull();
    expect(resolveSensorOptions({ sensor: 'none' })).toBeNull();
  });

  it('holds on unvalidated input: null for anything it could not accept, never a throw', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'imx290',
      7,
      [],
      {},
      { sensor: null },
      { sensor: 290 },
      { sensor: ['imx290'] },
      { sensor: 'imx290', options: null },
      { sensor: 'imx290', options: 'x' },
      // A value it does not list is never papered over with the default.
      { sensor: 'imx290', options: { clockFrequency: '74250000' } },
      { sensor: 'imx290', options: { clockFrequency: 1 } },
      { sensor: 'imx290', options: { clockFrequency: NaN } },
      { sensor: 'imx290', options: { mono: 1 } },
      { sensor: 'imx290', extra: true },
      Object.create({ sensor: 'imx290' }),
    ];
    for (const choice of bad) {
      expect(() => resolveSensorOptions(choice)).not.toThrow();
      expect(resolveSensorOptions(choice), JSON.stringify(choice)).toBeNull();
    }
    // Inherited option values are not read.
    expect(
      resolveSensorOptions({
        sensor: 'imx290',
        options: Object.create({ clockFrequency: 74250000 }),
      }),
    ).toEqual({ clockFrequency: 37125000 });
  });
});
