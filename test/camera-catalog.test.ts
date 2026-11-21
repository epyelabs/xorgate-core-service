import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_CATALOG,
  CAMERA_CATALOG_VERSION,
  CAMERA_SENSOR_NONE,
  SELECTABLE_SENSOR_IDS,
  buildCameraCatalog,
  cameraCatalogSchema,
  cameraPackageSet,
  cameraPresetSupport,
  cameraSensor,
  cameraSensorByDtNode,
  cameraSensorByLibcameraName,
  cameraSensorByOverlay,
  plannedCameraSensor,
  serializeCameraCatalog,
} from '../src/camera-catalog';
import { CAMERA_CATALOG_SOURCE } from '../src/camera-catalog/data';
import { VIDEO_PRESET_NAMES } from '../src/config-registry/recording';

const ARTIFACT = join(__dirname, '..', 'src', 'camera-catalog', 'camera-catalog.json');

/**
 * The catalog content this version number stands for.
 *
 * **If this fails, you changed the catalog.** That is fine; do all three:
 *   1. bump `CAMERA_CATALOG_VERSION` in `src/camera-catalog/data.ts`
 *      (a device prints it as "catalog vN" when it is handed a sensor its
 *      build does not know, so two different catalogs must not share a number),
 *   2. `npm run contract:generate` and commit the artifact,
 *   3. set the version and the artifact's sha256 here.
 */
const PINNED = {
  catalogVersion: 2,
  sha256: 'feac4f6802f5e2208d84cbe405c9e723b4fede899620d3f64b1ca615f9367574',
};

/** A deep copy with every object's keys in reverse order (arrays keep theirs). */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

/** The source catalog, deep-copied and edited, for the refusal cases. */
function mutated(edit: (draft: any) => void): unknown {
  const draft = JSON.parse(JSON.stringify(CAMERA_CATALOG_SOURCE));
  edit(draft);
  return draft;
}

function refusal(edit: (draft: any) => void): string {
  const parsed = cameraCatalogSchema.safeParse(mutated(edit));
  if (parsed.success) return '';
  return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
}

describe('camera-catalog.json', () => {
  it('matches the catalog module (run `npm run contract:generate` after editing it)', () => {
    // THE staleness guard: the console imports this artifact and the Rust
    // agent compiles it in. A data edit that never reached it would leave the
    // backend validating against one catalog and devices running another.
    expect(readFileSync(ARTIFACT, 'utf8')).toBe(serializeCameraCatalog());
  });

  it('is stable: same bytes on every run, one trailing newline, valid JSON', () => {
    const text = serializeCameraCatalog();
    expect(serializeCameraCatalog()).toBe(text);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(text)).toEqual(CAMERA_CATALOG);
  });

  it('has a key order that comes from the schema, not from how data.ts is typed', () => {
    const reversed = reverseKeys(CAMERA_CATALOG_SOURCE);
    // The fixture really is in another order ...
    expect(Object.keys(reversed as object)[0]).not.toBe('schemaVersion');
    // ... and still serializes to the same bytes.
    expect(serializeCameraCatalog(buildCameraCatalog(reversed))).toBe(serializeCameraCatalog());
    expect(Object.keys(CAMERA_CATALOG)).toEqual([
      'schemaVersion',
      'catalogVersion',
      'generatedBy',
      'sensors',
      'planned',
      'packageSets',
    ]);
    expect(Object.keys(CAMERA_CATALOG.sensors[0])).toEqual([
      'id',
      'label',
      'tier',
      'minAgent',
      'overlay',
      'options',
      'libcameraNames',
      'dtNodeNames',
      'identity',
      'source',
      'requires',
      'unsupportedPresets',
      'info',
      'notes',
    ]);
  });

  it('carries a content version that moves with the content', () => {
    expect(CAMERA_CATALOG.schemaVersion).toBe(1);
    expect(CAMERA_CATALOG.catalogVersion).toBe(CAMERA_CATALOG_VERSION);
    const sha256 = createHash('sha256').update(readFileSync(ARTIFACT)).digest('hex');
    expect(
      { catalogVersion: CAMERA_CATALOG.catalogVersion, sha256 },
      '\nThe catalog changed. Bump CAMERA_CATALOG_VERSION, regenerate, then update ' +
        'PINNED in this file. See the comment on PINNED.\n',
    ).toEqual(PINNED);
  });

  it('gives every shape the same keys, so a consumer never meets a missing one', () => {
    const keysOf = (items: readonly object[]) => items.map((i) => Object.keys(i).join(','));
    expect(new Set(keysOf(CAMERA_CATALOG.sensors)).size).toBe(1);
    expect(new Set(keysOf(CAMERA_CATALOG.sensors.map((s) => s.info))).size).toBe(1);
    expect(new Set(keysOf(CAMERA_CATALOG.sensors.flatMap((s) => s.options))).size).toBe(1);
  });
});

describe('catalog entries (the measured facts, PROGRESS.md)', () => {
  it('lists the v1 sensors in order, and imx662 only as planned', () => {
    expect(SELECTABLE_SENSOR_IDS).toEqual(['imx290', 'imx219', 'imx708', 'imx335']);
    expect(CAMERA_CATALOG.planned.map((s) => s.id)).toEqual(['imx662']);
    expect(cameraSensor('imx662')).toBeUndefined();
    expect(plannedCameraSensor('imx662')).toMatchObject({
      tier: 'planned',
      requires: { os: ['trixie'] },
    });
  });

  it('does not carry the reserved "none", nor the imx290-driver overlays never seen working', () => {
    const everyId = [...SELECTABLE_SENSOR_IDS, ...CAMERA_CATALOG.planned.map((s) => s.id)];
    expect(everyId).not.toContain(CAMERA_SENSOR_NONE);
    expect(everyId).not.toContain('imx327');
    expect(everyId).not.toContain('imx462');
    expect(cameraSensorByOverlay('imx327')).toBeUndefined();
    expect(cameraSensorByOverlay('imx462')).toBeUndefined();
  });

  it('imx290 describes exactly the line every fielded device has', () => {
    const s = cameraSensor('imx290')!;
    // `dtoverlay=imx290,cam0`: default rotation 0 and NO fixed parameter. A
    // change to either would make the line owner rewrite config.txt on the
    // whole fleet.
    expect(s.overlay).toEqual({
      name: 'imx290',
      fixedParams: [],
      defaultRotation: 0,
      canFlip: true,
    });
    expect(s.tier).toBe('supported');
    expect(s.identity).toBe('none');
    expect(s.source.props).toEqual([]);
    expect(s.requires).toEqual({ os: ['bookworm'], packageSet: null });
    expect(s.options).toHaveLength(1);
    expect(s.options[0]).toMatchObject({
      key: 'clockFrequency',
      param: 'clock-frequency',
      values: [37125000, 74250000],
      default: 37125000,
    });
  });

  it('imx219: default rotation 180, chip id, 58.5% of the width at both preset sizes', () => {
    const s = cameraSensor('imx219')!;
    expect(s.overlay).toMatchObject({ name: 'imx219', defaultRotation: 180, canFlip: true });
    expect(s.identity).toBe('chip-id');
    expect(s.options).toEqual([]);
    expect(s.info.sensorWidthPercent).toEqual({ p720: 58.5, p1080: 58.5 });
    expect(s.info.sensorHeightPercent).toEqual({ p720: 43.8, p1080: 43.8 });
    expect(s.unsupportedPresets).toEqual([]);
    expect(s.tier).toBe('supported');
  });

  it('imx708: four libcamera names, link frequency, no lens position set', () => {
    const s = cameraSensor('imx708')!;
    expect(s.overlay).toMatchObject({ name: 'imx708', defaultRotation: 180, canFlip: true });
    expect(s.identity).toBe('chip-id');
    expect(s.libcameraNames).toEqual(['imx708', 'imx708_wide', 'imx708_noir', 'imx708_wide_noir']);
    expect(s.options[0]).toMatchObject({
      key: 'linkFrequency',
      param: 'link-frequency',
      values: [450000000, 447000000, 453000000],
      default: 450000000,
    });
    expect(s.info.sensorWidthPercent).toEqual({ p720: 66.7, p1080: 100 });
    // v1 sets nothing on the source: the lens stays at libcamera's default,
    // and the note must not promise a fixed value.
    expect(s.source.props).toEqual([]);
    expect(s.notes.join(' ')).toContain("Focus stays at the lens's default position");
    expect(s.notes.join(' ')).not.toMatch(/fixed/i);
    expect(s.unsupportedPresets).toEqual([]);
  });

  it('imx335: needs packages, weak identity, cannot flip', () => {
    const s = cameraSensor('imx335')!;
    expect(s.tier).toBe('supported-with-packages');
    expect(s.identity).toBe('weak');
    expect(s.overlay.canFlip).toBe(false);
    expect(s.options[0]).toMatchObject({
      key: 'linkFrequency',
      param: 'link-frequency',
      values: [594000000, 445500000],
      default: 594000000,
    });
    expect(s.requires).toEqual({ os: ['bookworm'], packageSet: 'arducam-libcamera' });
    // Measured on bench 2: no token = device tree 180, and no rotation is possible.
    expect(s.overlay.defaultRotation).toBe(180);
    expect(s.libcameraNames).toEqual(['imx335']);
    expect(s.dtNodeNames).toEqual(['imx335']);
    expect(s.info.nativeAspect).toBe('4:3');
    expect(s.info.sensorWidthPercent).toEqual({ p720: 100, p1080: 98.8 });
    expect(s.info.sensorHeightPercent).toEqual({ p720: 75.9, p1080: 75 });
    expect(s.notes.join(' ')).toContain('Mount the camera the right way up');
  });

  it('imx335 cannot run 1080p30; every other sensor runs all five presets', () => {
    const limited = CAMERA_CATALOG.sensors.filter((s) => s.unsupportedPresets.length > 0);
    expect(limited.map((s) => s.id)).toEqual(['imx335']);
    expect(limited[0].unsupportedPresets.map((u) => u.preset)).toEqual(['1080p30-4mbps']);
    expect(limited[0].unsupportedPresets[0].reason).toMatch(/29\.99 frames per second/);
    // Every listed preset is one of the registry's, by reference.
    for (const s of CAMERA_CATALOG.sensors) {
      for (const u of s.unsupportedPresets) expect(VIDEO_PRESET_NAMES).toContain(u.preset);
    }
  });

  it('only a sensor that needs nothing but the stock image is tier "supported"', () => {
    for (const s of CAMERA_CATALOG.sensors) {
      expect(s.tier === 'supported', s.id).toBe(s.requires.packageSet === null);
    }
  });

  it('the Arducam package set is the two debs of the bench report, pinned', () => {
    const set = cameraPackageSet('arducam-libcamera')!;
    expect(set.aptHold).toBe(true);
    expect(set.notes.join(' ')).toMatch(/apt hold/);
    expect(set.targets).toHaveLength(1);
    const [target] = set.targets;
    expect(target).toMatchObject({ os: 'bookworm', arch: 'arm64' });
    const base =
      'https://github.com/ArduCAM/Arducam-Pivariety-V4L2-Driver/releases/download/libcamera-v0.0.5/';
    expect(target.packages).toEqual([
      {
        name: 'libcamera0.5',
        version: '0.5.2+rpt20250909-1',
        url: `${base}libcamera0.5_0.5.2+rpt20250909-1_arm64.deb`,
        sha256: '85ae12c0f8c2809d97ecd8b0cb7ca641a178f5e5e5b6a1fa81ff61afc43763dd',
        bytes: 527340,
      },
      {
        name: 'libcamera-ipa',
        version: '0.5.2+rpt20250909-1',
        url: `${base}libcamera-ipa_0.5.2+rpt20250909-1_arm64.deb`,
        sha256: '247961da888ab177dfac1ceb8e0e75edf2cd2f8722be2fd46984041e87d12503',
        bytes: 600732,
      },
    ]);
    // Each file is named the Debian way from the fields a device will check.
    for (const p of target.packages) {
      expect(p.url.endsWith(`/${p.name}_${p.version}_${target.arch}.deb`), p.name).toBe(true);
    }
  });

  it('every option default is one of its listed values', () => {
    for (const s of CAMERA_CATALOG.sensors) {
      for (const o of s.options) expect(o.values, `${s.id}.${o.key}`).toContain(o.default);
    }
  });
});

describe('catalog lookups', () => {
  it('finds a sensor by id, overlay, libcamera name and device-tree node', () => {
    expect(cameraSensor('imx708')?.label).toBe('Sony IMX708 (Camera Module 3)');
    expect(cameraSensor('IMX708')).toBeUndefined();
    expect(cameraSensorByOverlay('imx219')?.id).toBe('imx219');
    expect(cameraSensorByLibcameraName('imx708_wide_noir')?.id).toBe('imx708');
    expect(cameraSensorByLibcameraName('imx477')).toBeUndefined();
    // The three spellings a device has of the same node.
    expect(cameraSensorByDtNode('imx708')?.id).toBe('imx708');
    expect(cameraSensorByDtNode('imx219@10')?.id).toBe('imx219');
    expect(cameraSensorByDtNode('/base/soc/i2c0mux/i2c@0/imx708@1a')?.id).toBe('imx708');
    expect(
      cameraSensorByDtNode('/base/axi/pcie@1000120000/rp1/i2c@88000/imx290@1a')?.id,
    ).toBe('imx290');
    expect(cameraSensorByDtNode('')).toBeUndefined();
    expect(cameraSensorByDtNode('/base/soc/i2c0mux/i2c@0/ov5647@36')).toBeUndefined();
  });

  it('never returns a planned sensor from a selectable lookup', () => {
    expect(cameraSensor('imx662')).toBeUndefined();
    expect(cameraSensorByOverlay('imx662')).toBeUndefined();
    expect(cameraSensorByLibcameraName('imx662')).toBeUndefined();
    expect(cameraSensorByDtNode('imx662@1a')).toBeUndefined();
    expect(cameraPackageSet('nope')).toBeUndefined();
  });
});

describe('cameraPresetSupport', () => {
  it('answers for every sensor and every preset, from the catalog', () => {
    for (const sensor of CAMERA_CATALOG.sensors) {
      for (const preset of VIDEO_PRESET_NAMES) {
        const listed = sensor.unsupportedPresets.find((u) => u.preset === preset);
        expect(cameraPresetSupport(sensor.id, preset), `${sensor.id} ${preset}`).toEqual(
          listed ? { supported: false, reason: listed.reason } : { supported: true },
        );
      }
    }
  });

  it('says why 1080p30 cannot run on the imx335, and what to use instead', () => {
    expect(cameraPresetSupport('imx335', '1080p30-4mbps')).toEqual({
      supported: false,
      reason:
        "The IMX335's full-resolution mode tops out at 29.99 frames per second, so a " +
        '30 fps 1080p stream cannot start. Use 1080p15-2mbps or a 720p preset.',
    });
    for (const preset of ['1080p15-2mbps', '720p30-2mbps', '720p15-2mbps', '720p15-1mbps']) {
      expect(cameraPresetSupport('imx335', preset), preset).toEqual({ supported: true });
    }
    for (const id of ['imx290', 'imx219', 'imx708']) {
      expect(cameraPresetSupport(id, '1080p30-4mbps'), id).toEqual({ supported: true });
    }
  });

  it('fails closed on a sensor that is not selectable or a name that is not a preset', () => {
    for (const id of ['imx662', 'none', 'imx477', '', 'IMX335']) {
      expect(cameraPresetSupport(id, '720p15-1mbps'), id).toEqual({
        supported: false,
        reason: `"${id}" is not a selectable camera sensor`,
      });
    }
    expect(cameraPresetSupport('imx290', '1080p60-8mbps')).toEqual({
      supported: false,
      reason:
        '"1080p60-8mbps" is not a video preset (presets: 1080p30-4mbps, 1080p15-2mbps, ' +
        '720p30-2mbps, 720p15-2mbps, 720p15-1mbps)',
    });
    expect(cameraPresetSupport('imx290', '')).toMatchObject({ supported: false });
    // The unknown sensor is reported first, and a long name is not echoed whole.
    const both = cameraPresetSupport('x'.repeat(5000), 'nope');
    expect(both).toMatchObject({ supported: false });
    expect('reason' in both && both.reason.length).toBeLessThan(120);
  });
});

describe('catalog schema (what an entry may not be)', () => {
  it('accepts the catalog as written', () => {
    expect(cameraCatalogSchema.safeParse(CAMERA_CATALOG_SOURCE).success).toBe(true);
    expect(() => buildCameraCatalog(CAMERA_CATALOG_SOURCE)).not.toThrow();
  });

  it('refuses the reserved id and a duplicate id, across both lists', () => {
    expect(refusal((c) => (c.sensors[0].id = 'none'))).toMatch(/reserved/);
    expect(refusal((c) => (c.planned[0].id = 'none'))).toMatch(/reserved/);
    expect(refusal((c) => (c.sensors[1].id = 'imx290'))).toMatch(/duplicate sensor id "imx290"/);
    expect(refusal((c) => (c.planned[0].id = 'imx708'))).toMatch(/duplicate sensor id "imx708"/);
  });

  it('refuses an unknown key anywhere (a typo must not ship as a silent no-op)', () => {
    expect(refusal((c) => (c.extra = 1))).not.toBe('');
    expect(refusal((c) => (c.sensors[0].canFlip = true))).not.toBe('');
    expect(refusal((c) => (c.sensors[0].overlay.rotation = 0))).not.toBe('');
    expect(refusal((c) => (c.packageSets[0].targets[0].packages[0].md5 = 'x'))).not.toBe('');
  });

  it('refuses a rotation default that is not 0 or 180', () => {
    for (const deg of [90, 270, '180', null]) {
      expect(refusal((c) => (c.sensors[0].overlay.defaultRotation = deg)), String(deg)).toMatch(
        /sensors\.0\.overlay\.defaultRotation/,
      );
    }
  });

  it('refuses line tokens the line owner writes, and overlapping parameters', () => {
    for (const token of ['cam0', 'cam1', 'rotation=180']) {
      expect(refusal((c) => c.sensors[0].overlay.fixedParams.push(token)), token).toMatch(
        /written by the line owner/,
      );
    }
    expect(refusal((c) => (c.sensors[0].options[0].param = 'rotation'))).toMatch(
      /written by the line owner/,
    );
    expect(
      refusal((c) => c.sensors[0].overlay.fixedParams.push('clock-frequency=74250000')),
    ).toMatch(/also a fixed parameter/);
    expect(refusal((c) => c.sensors[0].options.push(c.sensors[0].options[0]))).toMatch(
      /option keys must be unique/,
    );
  });

  it('refuses anything that is unsafe to write into config.txt or a gst-launch argv', () => {
    const unsafe = ['4lane\ndtoverlay=evil', 'a b', 'x,cam0', 'x;y', 'X=1', 'a=$(id)', ''];
    for (const bad of unsafe) {
      expect(refusal((c) => c.sensors[0].overlay.fixedParams.push(bad)), bad).not.toBe('');
      expect(refusal((c) => (c.sensors[0].overlay.name = bad)), bad).not.toBe('');
      expect(refusal((c) => (c.sensors[0].options[0].param = bad)), bad).not.toBe('');
    }
    for (const bad of ['lens-position', 'lens-position=0.5 ! fakesink', 'a=b=c', '=1', 'x=$(id)']) {
      expect(refusal((c) => c.sensors[2].source.props.push(bad)), bad).not.toBe('');
    }
    expect(refusal((c) => c.sensors[2].source.props.push('camera-name=x'))).toMatch(/camera-name/);
    // A well-formed property is accepted (the field stays usable) ...
    expect(refusal((c) => c.sensors[2].source.props.push('lens-position=0.5'))).toBe('');
    // ... once.
    expect(
      refusal((c) => c.sensors[2].source.props.push('lens-position=0.5', 'lens-position=1.0')),
    ).toMatch(/properties must be unique/);
  });

  it('refuses an option whose default is not one of its values, or with no values', () => {
    expect(refusal((c) => (c.sensors[0].options[0].default = 1))).toMatch(
      /the default must be one of the values/,
    );
    expect(refusal((c) => (c.sensors[0].options[0].values = []))).not.toBe('');
    expect(refusal((c) => (c.sensors[0].options[0].values = [37125000, 37125000]))).toMatch(
      /values must be unique/,
    );
    expect(refusal((c) => (c.sensors[0].options[0].values = [37125000.5]))).not.toBe('');
  });

  it('refuses two sensors claiming one overlay, libcamera name or node name', () => {
    expect(refusal((c) => (c.sensors[1].overlay.name = 'imx290'))).toMatch(
      /already claimed by sensor "imx290"/,
    );
    expect(refusal((c) => c.sensors[1].libcameraNames.push('imx708_wide'))).toMatch(
      /already claimed by sensor "imx219"|already claimed by sensor "imx708"/,
    );
    expect(refusal((c) => c.sensors[1].dtNodeNames.push('imx290'))).toMatch(
      /already claimed by sensor "imx290"/,
    );
    expect(refusal((c) => (c.sensors[0].libcameraNames = []))).not.toBe('');
    expect(refusal((c) => (c.sensors[0].dtNodeNames = []))).not.toBe('');
  });

  it('keeps tier and package set consistent', () => {
    expect(refusal((c) => (c.sensors[3].requires.packageSet = null))).toMatch(
      /needs a package set/,
    );
    expect(refusal((c) => (c.sensors[0].requires.packageSet = 'arducam-libcamera'))).toMatch(
      /must be tier supported-with-packages/,
    );
    expect(refusal((c) => (c.sensors[3].requires.packageSet = 'missing-set'))).toMatch(
      /unknown package set "missing-set"/,
    );
    // A set nothing requires is dead data a device would never install.
    expect(
      refusal((c) => {
        c.sensors[3].tier = 'supported';
        c.sensors[3].requires.packageSet = null;
      }),
    ).toMatch(/not required by any sensor/);
    // A sensor may not claim an OS its package set has no files for.
    expect(refusal((c) => c.sensors[3].requires.os.push('trixie'))).toMatch(
      /has no files for trixie/,
    );
    expect(refusal((c) => (c.sensors[0].tier = 'planned'))).not.toBe('');
  });

  it('refuses a package that cannot be verified or fetched safely', () => {
    const pkg = (c: any) => c.packageSets[0].targets[0].packages[0];
    expect(refusal((c) => (pkg(c).url = pkg(c).url.replace('https://', 'http://')))).toMatch(
      /https/,
    );
    expect(refusal((c) => (pkg(c).url = 'https://example.com/install.sh'))).toMatch(/\.deb/);
    expect(refusal((c) => (pkg(c).sha256 = pkg(c).sha256.toUpperCase()))).not.toBe('');
    expect(refusal((c) => (pkg(c).sha256 = 'abc'))).not.toBe('');
    expect(refusal((c) => (pkg(c).version = ''))).not.toBe('');
    expect(refusal((c) => (pkg(c).name = 'lib camera; rm -rf /'))).not.toBe('');
    expect(refusal((c) => (pkg(c).bytes = 0))).not.toBe('');
    expect(refusal((c) => (c.packageSets[0].targets = []))).not.toBe('');
    expect(
      refusal((c) => c.packageSets[0].targets.push(c.packageSets[0].targets[0])),
    ).toMatch(/one target per OS release and architecture/);
  });

  it('takes unsupported presets only from the recording preset list, once each, with a reason', () => {
    const add = (entry: unknown) => (c: any) => c.sensors[0].unsupportedPresets.push(entry);
    for (const preset of VIDEO_PRESET_NAMES) {
      expect(refusal(add({ preset, reason: 'because' })), preset).toBe('');
    }
    for (const preset of ['1080p60-8mbps', '1080p30', '1080P30-4MBPS', '', 30, null]) {
      expect(refusal(add({ preset, reason: 'because' })), String(preset)).toMatch(
        /sensors\.0\.unsupportedPresets\.0\.preset/,
      );
    }
    expect(refusal(add({ preset: '720p30-2mbps', reason: '' }))).toMatch(/reason/);
    expect(refusal(add({ preset: '720p30-2mbps' }))).toMatch(/reason/);
    expect(refusal(add({ preset: '720p30-2mbps', reason: 'x', since: '0.2.0' }))).not.toBe('');
    expect(refusal(add('720p30-2mbps'))).not.toBe('');
    expect(
      refusal((c) =>
        c.sensors[3].unsupportedPresets.push({ preset: '1080p30-4mbps', reason: 'again' }),
      ),
    ).toMatch(/a preset may be listed once/);
    expect(refusal((c) => delete c.sensors[0].unsupportedPresets)).toMatch(/unsupportedPresets/);
  });

  it('names the entry when a bad catalog is built', () => {
    expect(() => buildCameraCatalog(mutated((c) => (c.sensors[2].options[0].default = 7)))).toThrow(
      /camera catalog is invalid:\n\s+sensors\.2\.options\.0\.default: the default must be one of the values/,
    );
  });
});
