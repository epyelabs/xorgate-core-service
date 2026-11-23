import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_CATALOG,
  CAMERA_CATALOG_VERSION,
  CAMERA_PACKAGE_HOSTS,
  CAMERA_SENSOR_NONE,
  CONFIG_TXT_LINE_MAX,
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
  catalogVersion: 4,
  sha256: 'd65cde662c5f0b0eeb541c5e79e9559060285af795bc224c916214145b833ffc',
};

/** Catalog 3 (backend e4a6a28), the last Bookworm-only catalog. */
const CATALOG_V3_SHA256 = '812ce3d6c2c4d1de6209c0ec118a9ecbac998b5cf23e5ccf27bd4fbb8c4aafb3';

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

describe('the shared catalog object', () => {
  it('is deeply frozen: a consumer cannot change what the next caller validates against', () => {
    const anyCatalog = CAMERA_CATALOG as any;
    const before = serializeCameraCatalog(CAMERA_CATALOG);
    expect(() => anyCatalog.sensors.push({ id: 'evil' })).toThrow(TypeError);
    expect(() => anyCatalog.sensors[0].options[0].values.push(1)).toThrow(TypeError);
    expect(() => (anyCatalog.sensors[0].overlay.defaultRotation = 180)).toThrow(TypeError);
    expect(() => (anyCatalog.sensors[3].unsupportedPresets.length = 0)).toThrow(TypeError);
    expect(() => anyCatalog.packageSets[0].targets[0].packages.pop()).toThrow(TypeError);
    expect(() => (anyCatalog.catalogVersion = 99)).toThrow(TypeError);
    expect(() => (SELECTABLE_SENSOR_IDS as any).push('evil')).toThrow(TypeError);
    expect(() => (cameraSensor('imx290') as any).libcameraNames.push('imx708')).toThrow(TypeError);
    // Nothing moved, and validation still answers from the original data.
    expect(serializeCameraCatalog(CAMERA_CATALOG)).toBe(before);
    expect(SELECTABLE_SENSOR_IDS).toEqual(['imx290', 'imx219', 'imx708', 'imx335']);
    expect(cameraSensor('evil')).toBeUndefined();
    expect(cameraPresetSupport('imx335', '1080p30-4mbps').supported).toBe(false);
  });

  it('freezes what it builds, not what it was given', () => {
    const built = buildCameraCatalog(CAMERA_CATALOG_SOURCE);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.sensors[0].options[0].values)).toBe(true);
    expect(Object.isFrozen(CAMERA_CATALOG_SOURCE)).toBe(false);
    expect(Object.isFrozen(CAMERA_CATALOG_SOURCE.sensors)).toBe(false);
  });
});

describe('catalog entries (the measured facts, PROGRESS.md)', () => {
  it('lists the v1 sensors in order, and imx662 only as planned', () => {
    expect(SELECTABLE_SENSOR_IDS).toEqual(['imx290', 'imx219', 'imx708', 'imx335']);
    expect(CAMERA_CATALOG.planned.map((s) => s.id)).toEqual(['imx662']);
    expect(cameraSensor('imx662')).toBeUndefined();
    // Dropped 2026-11-23 (the one board tried never answered on I2C); what was
    // learned is in its notes, the only free field a planned entry has.
    expect(plannedCameraSensor('imx662')).toEqual({
      id: 'imx662',
      label: 'Sony IMX662',
      tier: 'planned',
      requires: { os: ['trixie'] },
      notes: [
        'Not available. The one board tried did not answer on its I2C bus, so nothing ' +
          'about this sensor has been verified.',
        'It would need Debian Trixie with kernel 6.18.60 or later. Its overlay is imx662; ' +
          'the device-tree node is starvis2, and the default rotation is 180 (read in the ' +
          'device tree).',
      ],
    });
  });

  it('every sensor needs only the first catalog-aware agent (0.2.0)', () => {
    // Nothing in catalog 4 needs a newer agent: it adds an OS release and a
    // package target, which the released 0.2.0 parser already reads.
    for (const s of CAMERA_CATALOG.sensors) expect(s.minAgent, s.id).toBe('0.2.0');
  });

  it('the four sensors run on Bookworm and on Trixie', () => {
    const os = Object.fromEntries(CAMERA_CATALOG.sensors.map((s) => [s.id, s.requires.os]));
    expect(os).toEqual({
      imx290: ['bookworm', 'trixie'],
      imx219: ['bookworm', 'trixie'],
      imx708: ['bookworm', 'trixie'],
      imx335: ['bookworm', 'trixie'],
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
    expect(s.requires).toEqual({ os: ['bookworm', 'trixie'], packageSet: null });
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
    expect(s.label).toBe('Sony IMX219');
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
    expect(s.requires).toEqual({ os: ['bookworm', 'trixie'], packageSet: 'arducam-libcamera' });
    // Measured on bench 2: no token = device tree 180, and no rotation is possible.
    expect(s.overlay.defaultRotation).toBe(180);
    expect(s.libcameraNames).toEqual(['imx335']);
    expect(s.dtNodeNames).toEqual(['imx335']);
    expect(s.info.nativeAspect).toBe('4:3');
    // The measured ceiling of the full mode, the same number its reason quotes.
    expect(s.info.fullModeMaxFps).toBe(29.99);
    expect(s.unsupportedPresets[0].reason).toContain('29.99');
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
    expect(set.targets.map((t) => `${t.os}/${t.arch}`)).toEqual(['bookworm/arm64', 'trixie/arm64']);
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

  it('the Arducam set has a Trixie target: its own pair, libcamera0.8 not libcamera0.5', () => {
    const trixie = cameraPackageSet('arducam-libcamera')!.targets.find((t) => t.os === 'trixie')!;
    expect(trixie).toBeDefined();
    expect(trixie.arch).toBe('arm64');
    // Same host and release path as the Bookworm pair: a device accepts only
    // an exact catalog URL on github.com.
    const base =
      'https://github.com/ArduCAM/Arducam-Pivariety-V4L2-Driver/releases/download/libcamera-v0.0.5/';
    expect(trixie.packages).toEqual([
      {
        name: 'libcamera0.8',
        version: '0.8.0+rpt20261106-2',
        url: `${base}libcamera0.8_0.8.0+rpt20261106-2_arm64.deb`,
        sha256: '8f591a09c3faf866821eb421c4f601a1ff9029ff36baa8aeb32de3467b7728eb',
        bytes: 591404,
      },
      {
        name: 'libcamera-ipa',
        version: '0.8.0+rpt20261106-2',
        url: `${base}libcamera-ipa_0.8.0+rpt20261106-2_arm64.deb`,
        sha256: '5145f1961c195f1bf782e7f1233afb605c1afe97ceae79888ec5557ddfd26ccc',
        bytes: 659076,
      },
    ]);
    for (const p of trixie.packages) {
      expect(p.url.endsWith(`/${p.name}_${p.version}_${trixie.arch}.deb`), p.name).toBe(true);
    }
  });

  it('catalog 4 is catalog 3 plus Trixie: every other value is byte-identical', () => {
    // Undo exactly the catalog-4 additions on the emitted artifact, re-emit it
    // the generator's way, and the bytes must be catalog 3's. So nothing that
    // a Bookworm device (or a console) read in catalog 3 changed.
    const v4 = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
    const back = JSON.parse(JSON.stringify(v4));
    back.catalogVersion = 3;
    for (const s of back.sensors) s.requires.os = s.requires.os.filter((o: string) => o !== 'trixie');
    // The one revised value: the planned imx662's notes (what the bench
    // learned); its id, label, tier and OS are catalog 3's.
    expect(back.planned.map((p: any) => p.id)).toEqual(['imx662']);
    back.planned[0].notes = ['Not available yet. It needs a device image built on Debian Trixie.'];
    const set = back.packageSets[0];
    expect(set.notes.pop()).toMatch(/^On Debian Trixie the pair is libcamera0\.8/);
    expect(set.targets.pop().os).toBe('trixie');
    const text = `${JSON.stringify(back, null, 2)}\n`;
    expect(createHash('sha256').update(text).digest('hex')).toBe(CATALOG_V3_SHA256);
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
    expect(cameraSensorByDtNode('starvis2@1a')).toBeUndefined();
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

  it('holds on unvalidated input: fails closed, never throws', () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    const junk: unknown[] = [
      null,
      undefined,
      0,
      NaN,
      true,
      [],
      ['imx335'],
      {},
      { id: 'imx335' },
      cyclic,
      Symbol('imx335'),
      10n,
      () => 'imx335',
      Object.create(null),
    ];
    for (const value of junk) {
      for (const [id, preset] of [
        [value, '720p15-1mbps'],
        ['imx290', value],
        [value, value],
      ]) {
        let out: ReturnType<typeof cameraPresetSupport> | undefined;
        expect(() => (out = cameraPresetSupport(id, preset))).not.toThrow();
        expect(out?.supported).toBe(false);
        expect(out && 'reason' in out && out.reason.length).toBeGreaterThan(0);
      }
    }
    // An array or an object that prints like an id is still not an id.
    expect(cameraPresetSupport(['imx290'], '720p15-1mbps')).toEqual({
      supported: false,
      reason: '["imx290"] is not a selectable camera sensor',
    });
    expect(cameraPresetSupport('imx290', ['720p15-1mbps'])).toMatchObject({ supported: false });
    // Inherited names are not ids or presets.
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(cameraPresetSupport(name, '720p15-1mbps').supported).toBe(false);
      expect(cameraPresetSupport('imx290', name).supported).toBe(false);
    }
    // The lookups share the rule.
    for (const value of junk) {
      expect(() => cameraSensor(value as any)).not.toThrow();
      expect(cameraSensor(value as any)).toBeUndefined();
      expect(cameraSensorByDtNode(value as any)).toBeUndefined();
      expect(cameraSensorByOverlay(value as any)).toBeUndefined();
      expect(cameraSensorByLibcameraName(value as any)).toBeUndefined();
      expect(plannedCameraSensor(value as any)).toBeUndefined();
      expect(cameraPackageSet(value as any)).toBeUndefined();
    }
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
    expect(refusal((c) => c.packageSets[0].targets.pop())).toMatch(/has no files for trixie/);
    expect(refusal((c) => c.sensors[3].requires.os.push('trixie'))).toMatch(
      /releases must be unique/,
    );
    expect(refusal((c) => (c.sensors[0].tier = 'planned'))).not.toBe('');
  });

  it('refuses a package that cannot be verified or fetched safely', () => {
    const pkg = (c: any) => c.packageSets[0].targets[0].packages[0];
    expect(refusal((c) => (pkg(c).url = pkg(c).url.replace('https://', 'http://')))).toMatch(
      /https/,
    );
    expect(refusal((c) => (pkg(c).url = 'https://github.com/x/install.sh'))).toMatch(/\.deb/);
    expect(refusal((c) => (pkg(c).sha256 = pkg(c).sha256.toUpperCase()))).not.toBe('');
    expect(refusal((c) => (pkg(c).sha256 = 'abc'))).not.toBe('');
    expect(refusal((c) => (pkg(c).version = ''))).not.toBe('');
    expect(refusal((c) => (pkg(c).name = 'lib camera; rm -rf /'))).not.toBe('');
    expect(refusal((c) => (pkg(c).bytes = 0))).not.toBe('');
    // Bounds: nothing absurd, nothing that is not an exact integer.
    expect(refusal((c) => (pkg(c).bytes = 2 ** 40))).toMatch(/bytes/);
    expect(refusal((c) => (pkg(c).bytes = 1.5))).toMatch(/bytes/);
    expect(refusal((c) => (pkg(c).name = `lib${'x'.repeat(200)}`))).toMatch(/name/);
    expect(refusal((c) => (pkg(c).version = `1.${'0'.repeat(100)}`))).toMatch(/version/);
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

  it('holds a package URL to https://<allowed host>/<plain path>/<name>_<version>_<arch>.deb', () => {
    const pkg = (c: any) => c.packageSets[0].targets[0].packages[0];
    const good: string = pkg(CAMERA_CATALOG_SOURCE).url;
    const file = good.slice(good.lastIndexOf('/') + 1);
    const withUrl = (url: unknown) => refusal((c) => (pkg(c).url = url));
    const urlIssue = /packageSets\.0\.targets\.0\.packages\.0\.url/;

    expect(CAMERA_PACKAGE_HOSTS).toEqual(['github.com']);
    expect(withUrl(good)).toBe('');

    // Anything that would need quoting in a shell, a log line or an apt source.
    const hostile = [
      `https://github.com/$(reboot)/${file}`,
      `https://github.com/a\nb/${file}`,
      `https://github.com/a b/${file}`,
      `https://github.com/a"b/${file}`,
      `https://github.com/a'b/${file}`,
      `https://github.com/a;b/${file}`,
      `https://github.com/a\`id\`/${file}`,
      `https://github.com/a%20b/${file}`,
      `https://github.com/a\\b/${file}`,
      `https://user:pass@github.com/a/${file}`,
      `https://github.com:8443/a/${file}`,
      `https://github.com/a/${file}?x=.deb`,
      `https://github.com/a/x?x=${file}`,
      `https://github.com/a/${file}#frag`,
      `https://github.com/a//${file}`,
      `https://github.com/${file}/`,
      `https://github.com`,
      `https://github.com/`,
      `https:///a/${file}`,
      ` ${good}`,
      `${good}\n`,
      `${good} `,
      `HTTPS://github.com/a/${file}`,
      `https://GitHub.com/a/${file}`,
      `ftp://github.com/a/${file}`,
      `file:///a/${file}`,
      `//github.com/a/${file}`,
      `github.com/a/${file}`,
      '',
      7,
      null,
    ];
    for (const url of hostile) expect(withUrl(url), JSON.stringify(url)).toMatch(urlIssue);

    // A length cap, and it is the cap that answers (not the pattern).
    const long = `https://github.com/${'a'.repeat(5000)}/${file}`;
    expect(withUrl(long)).toMatch(/at most 300 characters/);

    // Well-formed, but not somewhere a device may install from.
    for (const host of ['example.com', 'github.com.evil.example', 'evilgithub.com', 'raw.github.com']) {
      expect(withUrl(`https://${host}/a/${file}`), host).toMatch(/is not an allowed package host/);
    }
    expect(withUrl(`https://github.com/a/../${file}`)).toMatch(/path segments/);
    expect(withUrl(`https://github.com/./a/${file}`)).toMatch(/path segments/);

    // The file name is derived from the fields a device verifies against.
    expect(withUrl('https://github.com/a/libcamera0.5_0.5.2+rpt20250909-2_arm64.deb')).toMatch(
      /the file name must be "libcamera0\.5_0\.5\.2\+rpt20250909-1_arm64\.deb"/,
    );
    expect(withUrl('https://github.com/a/other_0.5.2+rpt20250909-1_arm64.deb')).toMatch(
      /the file name must be/,
    );
    expect(withUrl('https://github.com/a/libcamera0.5_0.5.2+rpt20250909-1_armhf.deb')).toMatch(
      /the file name must be/,
    );
    expect(refusal((c) => (pkg(c).version = '0.5.3'))).toMatch(/the file name must be/);
    expect(refusal((c) => (pkg(c).name = 'libcamera0.6'))).toMatch(/the file name must be/);
    // An epoch is part of the version, never of the file name.
    expect(refusal((c) => (pkg(c).version = `1:${pkg(c).version}`))).toBe('');
  });

  it('refuses a sensor whose longest overlay line would not fit in config.txt', () => {
    expect(CONFIG_TXT_LINE_MAX).toBe(98);
    // Every entry as written fits with room to spare.
    for (const s of CAMERA_CATALOG.sensors) {
      const line = [
        `dtoverlay=${s.overlay.name}`,
        'cam0',
        ...s.overlay.fixedParams,
        'rotation=180',
        ...s.options.map((o) => `${o.param}=${Math.max(...o.values)}`),
      ].join(',');
      expect(line.length, line).toBeLessThanOrEqual(CONFIG_TXT_LINE_MAX);
    }
    const tooLong = refusal((c) =>
      c.sensors[2].overlay.fixedParams.push('a'.repeat(30), 'b'.repeat(30)),
    );
    expect(tooLong).toMatch(
      /sensors\.2\.overlay: sensor "imx708": its longest config\.txt line would be \d+ characters, over the 98/,
    );
    // Exactly at the limit is fine; one wider option value tips it over.
    expect(refusal((c) => c.sensors[1].overlay.fixedParams.push('a'.repeat(32)))).toBe('');
    expect(
      refusal((c) => {
        c.sensors[0].overlay.fixedParams.push('a'.repeat(32), 'b'.repeat(5));
      }),
    ).toBe('');
    expect(
      refusal((c) => {
        c.sensors[0].overlay.fixedParams.push('a'.repeat(32), 'b'.repeat(5));
        c.sensors[0].options[0].values.push(4294967295);
      }),
    ).toMatch(/sensor "imx290": its longest config\.txt line/);
  });

  it('bounds numbers to what their consumers can hold', () => {
    // An overlay integer is one device-tree cell.
    expect(refusal((c) => c.sensors[0].options[0].values.push(4294967295))).toBe('');
    expect(refusal((c) => c.sensors[0].options[0].values.push(4294967296))).toMatch(/values/);
    expect(refusal((c) => c.sensors[0].options[0].values.push(-1))).toMatch(/values/);
    expect(refusal((c) => (c.sensors[0].options[0].default = 2 ** 53))).toMatch(/default/);
    for (const v of [0, -1, 1.5, 1_000_001, 2 ** 53, '3', null]) {
      expect(refusal((c) => (c.catalogVersion = v)), String(v)).toMatch(/catalogVersion/);
    }
    expect(refusal((c) => (c.catalogVersion = 1_000_000))).toBe('');
  });

  it('refuses control characters and unbounded prose in every free-text field', () => {
    const fields: Array<[string, (c: any, text: string) => void]> = [
      ['sensor label', (c, t) => (c.sensors[0].label = t)],
      ['sensor note', (c, t) => (c.sensors[0].notes[0] = t)],
      ['option label', (c, t) => (c.sensors[0].options[0].label = t)],
      ['option description', (c, t) => (c.sensors[0].options[0].description = t)],
      ['option unit', (c, t) => (c.sensors[0].options[0].unit = t)],
      ['preset reason', (c, t) => (c.sensors[3].unsupportedPresets[0].reason = t)],
      ['planned label', (c, t) => (c.planned[0].label = t)],
      ['planned note', (c, t) => (c.planned[0].notes[0] = t)],
      ['package set label', (c, t) => (c.packageSets[0].label = t)],
      ['package set note', (c, t) => (c.packageSets[0].notes[0] = t)],
      ['generatedBy', (c, t) => (c.generatedBy = t)],
    ];
    for (const [name, set] of fields) {
      for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u001b[31mb', 'a\u007fb', 'a\u0085b', 'a\u2028b', '']) {
        expect(refusal((c) => set(c, bad)), `${name} ${JSON.stringify(bad)}`).not.toBe('');
      }
      expect(refusal((c) => set(c, 'x'.repeat(5000))), `${name} long`).not.toBe('');
      // Ordinary prose, punctuation and non-ASCII letters are fine.
      expect(refusal((c) => set(c, "Caméra 3: it's ok".slice(0, 16))), name).toBe('');
    }
  });

  it('refuses an option key that would shadow an object\'s own machinery', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'prototype', 'hasOwnProperty', 'valueOf']) {
      expect(refusal((c) => (c.sensors[0].options[0].key = key)), key).toMatch(
        /sensors\.0\.options\.0\.key/,
      );
    }
    expect(refusal((c) => (c.sensors[0].options[0].key = 'clockHz'))).toBe('');
  });

  it('names the entry when a bad catalog is built', () => {
    expect(() => buildCameraCatalog(mutated((c) => (c.sensors[2].options[0].default = 7)))).toThrow(
      /camera catalog is invalid:\n\s+sensors\.2\.options\.0\.default: the default must be one of the values/,
    );
  });
});
