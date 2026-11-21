import { z } from 'zod';
import { VIDEO_PRESET_NAMES } from '../config-registry/recording';

/**
 * Shape of the camera sensor catalog (plans/support-other-camera-models,
 * DESIGN.md §2 point 2).
 *
 * The catalog is the ONE place that says what a camera sensor is to the
 * platform: which `dtoverlay=` line declares it, which parameters a user may
 * set on that line, what its overlay's rotation default is, which names
 * libcamera and the device tree use for it, how far "the driver bound" can be
 * trusted, and what the OS must carry. `data.ts` holds the entries; this file
 * is only the rules they must satisfy.
 *
 * The emitted artifact (`camera-catalog.json`) is read by three programs that
 * share no code: this backend, the console, and the Rust device agent (which
 * compiles it in). So the shape is deliberately boring: every key is always
 * present (unknown facts are `null`, empty lists are `[]`), and every string
 * that ends up in `/boot/firmware/config.txt` or in a `gst-launch` argv is
 * held to a closed character set HERE, at the source, so no consumer has to
 * decide what is safe to write.
 */

/** Artifact FORMAT version: bump only on a breaking shape change. */
export const CAMERA_CATALOG_SCHEMA_VERSION = 1 as const;

/**
 * Reserved sensor ids that can never be catalog entries.
 *
 * `none` is how a port is declared EMPTY in the `cameraSensors` namespace
 * (Phase 2). It is a value of that namespace, not a sensor: it has no overlay,
 * no options and nothing to detect. The namespace schema adds it beside the
 * catalog's selectable ids; the catalog refuses an entry by that name so the
 * two can never collide.
 */
export const CAMERA_SENSOR_NONE = 'none' as const;
export const RESERVED_SENSOR_IDS: readonly string[] = [CAMERA_SENSOR_NONE];

/** Tokens of a camera `dtoverlay=` line that the line owner writes itself. */
export const LINE_OWNER_PARAMS: readonly string[] = ['cam0', 'cam1', 'rotation'];

// ── character sets ──────────────────────────────────────────────────────────
// An id is a wire value (it is stored in `devices.config` and typed into
// `xorgate-rs set`), so lower-case alphanumerics only.
const SENSOR_ID_RE = /^[a-z][a-z0-9]{1,31}$/;
// The name of an `overlays/<name>.dtbo` file.
const OVERLAY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// The name of one overlay parameter (`link-frequency`, `4lane`).
const OVERLAY_PARAM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// A fixed parameter as written on the line: `name` or `name=value`.
const FIXED_PARAM_RE = /^[a-z0-9][a-z0-9_-]{0,31}(=[A-Za-z0-9._-]{1,32})?$/;
// An option's key in the namespace document (`clockFrequency`).
const OPTION_KEY_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
// A `libcamerasrc` element property as one argv token: `lens-position=0.5`.
const SOURCE_PROP_RE = /^[a-z][a-z0-9-]{0,31}=[A-Za-z0-9._-]{1,32}$/;
// A libcamera sensor name (`imx708_wide_noir`) or a device-tree node name
// without its unit address (`imx708` of `imx708@1a`).
const KERNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_SET_ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
// Debian policy 5.6.1 (package name) and 5.6.12 (version).
const DEB_NAME_RE = /^[a-z0-9][a-z0-9+.-]+$/;
const DEB_VERSION_RE = /^[0-9][A-Za-z0-9.+~:-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

// ── vocabulary ──────────────────────────────────────────────────────────────

/** Debian release codenames a device image may be built on. */
export const CAMERA_OS_RELEASES = ['bookworm', 'trixie'] as const;
export const cameraOsReleaseSchema = z.enum(CAMERA_OS_RELEASES);
export type CameraOsRelease = z.infer<typeof cameraOsReleaseSchema>;

/**
 * Support tier of a SELECTABLE sensor.
 *
 * - `supported` — works on a stock device image.
 * - `supported-with-packages` — works once the entry's `requires.packageSet`
 *   is installed; until then the port reports `requirements-missing`.
 *
 * A third tier, `planned`, exists only on the entries under `planned` (see
 * `plannedSensorSchema`): those are shown, never selectable.
 */
export const SELECTABLE_TIERS = ['supported', 'supported-with-packages'] as const;
export const selectableTierSchema = z.enum(SELECTABLE_TIERS);
export const PLANNED_TIER = 'planned' as const;
export type CameraSensorTier = (typeof SELECTABLE_TIERS)[number] | typeof PLANNED_TIER;

/**
 * How far "the driver bound to this port" proves that THIS sensor is attached.
 *
 * - `chip-id` — the driver reads a real chip ID at probe and fails cleanly on
 *   a mismatch (no camera listed). Bound means present and of this type.
 * - `weak` — the probe checks something a different chip can also satisfy.
 *   Bound means "something answered"; it can be the wrong sensor.
 * - `none` — the probe checks nothing. A camera is listed whatever is (or is
 *   not) attached; only frames arriving proves anything.
 */
export const CAMERA_IDENTITY_LEVELS = ['chip-id', 'weak', 'none'] as const;
export const cameraIdentitySchema = z.enum(CAMERA_IDENTITY_LEVELS);
export type CameraIdentity = z.infer<typeof cameraIdentitySchema>;

/** The only values a camera overlay's `rotation` parameter takes. */
const rotationSchema = z.union([z.literal(0), z.literal(180)]);

// ── one sensor ──────────────────────────────────────────────────────────────

const overlaySchema = z
  .object({
    /** `dtoverlay=<name>,…` — the file `overlays/<name>.dtbo` on the device. */
    name: z.string().regex(OVERLAY_NAME_RE),
    /**
     * Parameters every line for this sensor carries, as written (`name` or
     * `name=value`). Never `cam0`/`cam1`/`rotation` (the line owner writes
     * those) and never a parameter an option controls.
     */
    fixedParams: z.array(z.string().regex(FIXED_PARAM_RE)),
    /**
     * What a line with NO `rotation=` token means for this overlay: the
     * `rotation` property the overlay itself puts on the sensor node.
     * Device-tree rotation = (defaultRotation + cameraMount.rotationDeg) mod 360.
     *
     * Meaningless when `canFlip` is false: the sensor applies no flip whatever
     * the device tree says, so no consumer may derive a picture orientation
     * from this field without checking `canFlip` first.
     */
    defaultRotation: rotationSchema,
    /**
     * Whether a 180° rotation is applied at the sensor (both flips available).
     * False = `rotation=` changes no pixels; the device reports "this sensor
     * cannot be rotated" and the console disables the mounting switch.
     */
    canFlip: z.boolean(),
  })
  .strict();

const optionSchema = z
  .object({
    /** Key in the namespace document: `options.<key>`. A wire name. */
    key: z.string().regex(OPTION_KEY_RE),
    /** Human label for the console's field. */
    label: z.string().min(1),
    /** One sentence saying when a user would change it. */
    description: z.string().min(1),
    /** The overlay parameter it sets: `<param>=<value>` on the line. */
    param: z.string().regex(OVERLAY_PARAM_RE),
    /** Unit of the values, for display (`Hz`), or null. */
    unit: z.string().min(1).nullable(),
    /** The closed set of accepted values. Integers: they are written verbatim. */
    values: z.array(z.number().int().nonnegative().safe()).min(1),
    /**
     * The OVERLAY's own default, i.e. what a line without the parameter means.
     * So "option absent" and "option set to `default`" declare the same thing.
     */
    default: z.number().int().nonnegative().safe(),
  })
  .strict();

const requiresSchema = z
  .object({
    /** OS releases the sensor works on. A device on another release cannot use it. */
    os: z.array(cameraOsReleaseSchema).min(1),
    /** Id of an entry under `packageSets` that must be installed, or null. */
    packageSet: z.string().regex(PACKAGE_SET_ID_RE).nullable(),
  })
  .strict();

const presetSharesSchema = z
  .object({
    p720: z.number().positive().max(100).nullable(),
    p1080: z.number().positive().max(100).nullable(),
  })
  .strict();

/**
 * Informational facts for the console and the docs. Nothing validates or
 * renders a pipeline from these; a `null` means "not measured", never "zero".
 */
const infoSchema = z
  .object({
    /** Aspect ratio of the sensor's full-resolution mode. */
    nativeAspect: z.enum(['16:9', '4:3']).nullable(),
    /** Highest frame rate of the full-resolution mode, frames per second. */
    fullModeMaxFps: z.number().positive().nullable(),
    /**
     * Share of the sensor's WIDTH the picture shows, per preset family, in
     * percent. Below 100 the preset shows a centre crop (a narrower view).
     */
    sensorWidthPercent: presetSharesSchema,
    /** The same for the sensor's HEIGHT. A 4:3 sensor never gives 100 at 16:9. */
    sensorHeightPercent: presetSharesSchema,
  })
  .strict();

/**
 * A video preset that cannot run on a sensor.
 *
 * `preset` is one of the `recording.video.preset` names: the closed list in
 * `config-registry/recording.ts` is the only vocabulary, so a preset renamed
 * or removed there fails the catalog instead of leaving a dead entry here.
 */
const unsupportedPresetSchema = z
  .object({
    preset: z.enum(VIDEO_PRESET_NAMES),
    /** One or two sentences for the operator: why, and what to pick instead. */
    reason: z.string().min(1),
  })
  .strict();

export const cameraSensorSchema = z
  .object({
    /** Wire id: the value of `cameraSensors.cameras.<key>.sensor`. Never renamed. */
    id: z.string().regex(SENSOR_ID_RE),
    label: z.string().min(1),
    tier: selectableTierSchema,
    /** First Rust agent version whose compiled-in catalog knows this sensor. */
    minAgent: z.string().regex(SEMVER_RE),
    overlay: overlaySchema,
    /** Per-board parameters a user may set. Empty = the sensor takes no options. */
    options: z.array(optionSchema),
    /** Every name libcamera may report for this sensor (variants included). */
    libcameraNames: z.array(z.string().regex(KERNEL_NAME_RE)).min(1),
    /** Device-tree node names, without the unit address (`imx708` of `imx708@1a`). */
    dtNodeNames: z.array(z.string().regex(KERNEL_NAME_RE)).min(1),
    identity: cameraIdentitySchema,
    source: z
      .object({
        /** Fixed `libcamerasrc` properties, one argv token each (`name=value`). */
        props: z.array(z.string().regex(SOURCE_PROP_RE)),
      })
      .strict(),
    requires: requiresSchema,
    /**
     * Video presets that cannot run on this sensor, each with the reason.
     * Empty = every preset runs. A preset not listed is supported.
     */
    unsupportedPresets: z.array(unsupportedPresetSchema),
    info: infoSchema,
    /** Plain sentences an operator should read before choosing this sensor. */
    notes: z.array(z.string().min(1)),
  })
  .strict();

export type CameraSensor = z.infer<typeof cameraSensorSchema>;
export type CameraSensorOption = z.infer<typeof optionSchema>;
export type CameraUnsupportedPreset = z.infer<typeof unsupportedPresetSchema>;

/**
 * A sensor the platform intends to support and does not yet.
 *
 * Kept OUT of `sensors` on purpose: everything that iterates `sensors` (the
 * namespace's enum, the agent's lookups, the console's select) is then
 * selectable by construction, and no consumer needs an "is this one real?"
 * check. The console shows these as "not yet available". A planned entry
 * carries no overlay facts because none has been seen working.
 */
export const plannedSensorSchema = z
  .object({
    id: z.string().regex(SENSOR_ID_RE),
    label: z.string().min(1),
    tier: z.literal(PLANNED_TIER),
    requires: z.object({ os: z.array(cameraOsReleaseSchema).min(1) }).strict(),
    notes: z.array(z.string().min(1)),
  })
  .strict();

export type PlannedCameraSensor = z.infer<typeof plannedSensorSchema>;

// ── package sets ────────────────────────────────────────────────────────────

const packageFileSchema = z
  .object({
    /** dpkg package name: what `dpkg-query -W` is asked about. */
    name: z.string().regex(DEB_NAME_RE),
    /** Exact dpkg version that counts as "installed". */
    version: z.string().regex(DEB_VERSION_RE),
    /** Where the `.deb` is fetched from. https only. */
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'must be an https URL')
      .refine((u) => u.endsWith('.deb'), 'must name a .deb file'),
    /** sha256 of the file, lower-case hex. The download is refused on a mismatch. */
    sha256: z.string().regex(SHA256_RE),
    /** Size of the file in bytes. */
    bytes: z.number().int().positive(),
  })
  .strict();

const packageTargetSchema = z
  .object({
    os: cameraOsReleaseSchema,
    /** dpkg architecture. */
    arch: z.enum(['arm64']),
    /** Installed together, in one apt transaction (they may pin each other). */
    packages: z.array(packageFileSchema).min(1),
  })
  .strict();

/**
 * Extra OS packages a sensor needs, modelled so a device can answer both "is
 * it installed?" (every `name` at exactly `version`) and "install it" (fetch
 * each `url`, check `sha256`, install, then hold when `aptHold`).
 */
export const cameraPackageSetSchema = z
  .object({
    id: z.string().regex(PACKAGE_SET_ID_RE),
    label: z.string().min(1),
    /**
     * True = `apt-mark hold` every package after install. Without it a newer
     * stock version replaces the packages on the next upgrade.
     */
    aptHold: z.boolean(),
    notes: z.array(z.string().min(1)),
    /** One entry per OS release and architecture the set exists for. */
    targets: z.array(packageTargetSchema).min(1),
  })
  .strict();

export type CameraPackageSet = z.infer<typeof cameraPackageSetSchema>;
export type CameraPackageFile = z.infer<typeof packageFileSchema>;

// ── the catalog ─────────────────────────────────────────────────────────────

const catalogShape = z
  .object({
    schemaVersion: z.literal(CAMERA_CATALOG_SCHEMA_VERSION),
    /**
     * CONTENT version: bumped on every change to the entries. It is the "vN"
     * a device prints when it is handed a sensor its build does not know.
     */
    catalogVersion: z.number().int().positive(),
    generatedBy: z.string().min(1),
    sensors: z.array(cameraSensorSchema).min(1),
    planned: z.array(plannedSensorSchema),
    packageSets: z.array(cameraPackageSetSchema),
  })
  .strict();

type CatalogShape = z.infer<typeof catalogShape>;

/** Rules that span entries. Each failure names the entry it is about. */
function crossCheck(catalog: CatalogShape, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const seenIds = new Map<string, string>();
  const claim = (id: string, path: (string | number)[]) => {
    if (RESERVED_SENSOR_IDS.includes(id)) {
      issue(path, `"${id}" is reserved and cannot be a catalog sensor`);
    }
    const first = seenIds.get(id);
    if (first) issue(path, `duplicate sensor id "${id}" (also at ${first})`);
    else seenIds.set(id, path.join('.'));
  };

  const packageSetIds = new Set(catalog.packageSets.map((p) => p.id));
  const usedPackageSets = new Set<string>();
  // Lookups by these three names return ONE sensor, so each must be owned by
  // exactly one entry.
  const owners = {
    overlay: new Map<string, string>(),
    libcameraNames: new Map<string, string>(),
    dtNodeNames: new Map<string, string>(),
  };
  const own = (
    kind: keyof typeof owners,
    name: string,
    sensorId: string,
    path: (string | number)[],
  ) => {
    const other = owners[kind].get(name);
    if (other && other !== sensorId) {
      issue(path, `"${name}" is already claimed by sensor "${other}"`);
    } else {
      owners[kind].set(name, sensorId);
    }
  };

  catalog.sensors.forEach((sensor, i) => {
    const at = ['sensors', i];
    claim(sensor.id, [...at, 'id']);
    own('overlay', sensor.overlay.name, sensor.id, [...at, 'overlay', 'name']);

    for (const field of ['libcameraNames', 'dtNodeNames'] as const) {
      if (!unique(sensor[field])) issue([...at, field], 'names must be unique');
      sensor[field].forEach((name, n) => own(field, name, sensor.id, [...at, field, n]));
    }

    // The line: fixed parameters, options and the owner's tokens must not overlap.
    const fixedNames = sensor.overlay.fixedParams.map((p) => p.split('=')[0]);
    if (!unique(fixedNames)) issue([...at, 'overlay', 'fixedParams'], 'parameters must be unique');
    fixedNames.forEach((name, n) => {
      if (LINE_OWNER_PARAMS.includes(name)) {
        issue(
          [...at, 'overlay', 'fixedParams', n],
          `"${name}" is written by the line owner and cannot be a fixed parameter`,
        );
      }
    });
    if (!unique(sensor.options.map((o) => o.key))) {
      issue([...at, 'options'], 'option keys must be unique');
    }
    if (!unique(sensor.options.map((o) => o.param))) {
      issue([...at, 'options'], 'option parameters must be unique');
    }
    sensor.options.forEach((option, n) => {
      const optAt = [...at, 'options', n];
      if (LINE_OWNER_PARAMS.includes(option.param)) {
        issue([...optAt, 'param'], `"${option.param}" is written by the line owner`);
      }
      if (fixedNames.includes(option.param)) {
        issue([...optAt, 'param'], `"${option.param}" is also a fixed parameter`);
      }
      if (new Set(option.values).size !== option.values.length) {
        issue([...optAt, 'values'], 'values must be unique');
      }
      if (!option.values.includes(option.default)) {
        issue([...optAt, 'default'], 'the default must be one of the values');
      }
    });

    const propNames = sensor.source.props.map((p) => p.split('=')[0]);
    if (!unique(propNames)) issue([...at, 'source', 'props'], 'properties must be unique');
    if (propNames.includes('camera-name')) {
      issue([...at, 'source', 'props'], '"camera-name" is set by the agent per port');
    }

    if (!unique(sensor.unsupportedPresets.map((u) => u.preset))) {
      issue([...at, 'unsupportedPresets'], 'a preset may be listed once');
    }

    if (!unique(sensor.requires.os)) issue([...at, 'requires', 'os'], 'releases must be unique');
    const setId = sensor.requires.packageSet;
    const needsPackages = sensor.tier === 'supported-with-packages';
    if (needsPackages && setId === null) {
      issue([...at, 'requires', 'packageSet'], 'tier supported-with-packages needs a package set');
    }
    if (!needsPackages && setId !== null) {
      issue([...at, 'tier'], 'a sensor with a package set must be tier supported-with-packages');
    }
    if (setId !== null) {
      usedPackageSets.add(setId);
      if (!packageSetIds.has(setId)) {
        issue([...at, 'requires', 'packageSet'], `unknown package set "${setId}"`);
      } else {
        const set = catalog.packageSets.find((p) => p.id === setId);
        for (const os of sensor.requires.os) {
          if (!set?.targets.some((t) => t.os === os)) {
            issue(
              [...at, 'requires', 'os'],
              `package set "${setId}" has no files for ${os}, which this sensor claims to support`,
            );
          }
        }
      }
    }
  });

  catalog.planned.forEach((sensor, i) => {
    claim(sensor.id, ['planned', i, 'id']);
    if (!unique(sensor.requires.os)) {
      issue(['planned', i, 'requires', 'os'], 'releases must be unique');
    }
  });

  if (!unique(catalog.packageSets.map((p) => p.id))) {
    issue(['packageSets'], 'package set ids must be unique');
  }
  catalog.packageSets.forEach((set, i) => {
    const at = ['packageSets', i];
    if (!usedPackageSets.has(set.id)) {
      issue([...at, 'id'], `package set "${set.id}" is not required by any sensor`);
    }
    if (!unique(set.targets.map((t) => `${t.os}/${t.arch}`))) {
      issue([...at, 'targets'], 'one target per OS release and architecture');
    }
    set.targets.forEach((target, t) => {
      if (!unique(target.packages.map((p) => p.name))) {
        issue([...at, 'targets', t, 'packages'], 'package names must be unique');
      }
    });
  });
}

export const cameraCatalogSchema = catalogShape.superRefine(crossCheck);

export type CameraCatalog = z.infer<typeof cameraCatalogSchema>;
/** What `data.ts` is written as: the same shape before validation. */
export type CameraCatalogInput = z.input<typeof cameraCatalogSchema>;
