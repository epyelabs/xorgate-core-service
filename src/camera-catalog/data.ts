import {
  CAMERA_CATALOG_SCHEMA_VERSION,
  type CameraCatalogInput,
} from './schema';

/**
 * The camera sensor catalog: every sensor the platform knows.
 *
 * ⚠️ Every hardware fact here (overlay names and parameters, rotation
 * defaults, names, identity levels, package files and hashes, field of view)
 * was READ on a bench or in a source tree; none is a guess. The record is
 * `plans/support-other-camera-models/PROGRESS.md` ("Research findings", "Bench
 * session 2 results") and the reports under that plan's `evidence/`. Where a
 * value is a candidate still being measured, the comment beside it says so,
 * with ⚠️. Do not add an entry, an option or a value that has not been seen.
 * Labels, option descriptions and notes are prose for the console.
 *
 * "READ, NOT EXERCISED" beside an option value means: the value is what the
 * overlay's own help text (`dtoverlay -h`) lists, but no bench has booted a
 * line carrying it. Every option DEFAULT has been booted. The non-default
 * values stay selectable (they are the overlay's documented vocabulary); the
 * first board that needs one is its test.
 *
 * Adding a sensor: one entry here, bump `CAMERA_CATALOG_VERSION`,
 * `npm run contract:generate`, update the pin in `test/camera-catalog.test.ts`,
 * a bench run, an agent release.
 *
 * After ANY edit: bump `CAMERA_CATALOG_VERSION` and regenerate. The version is
 * what a device prints when it is handed a sensor its build does not know, so
 * two different catalogs must never share a number.
 */

/** Content version of the catalog. Bump on every change to this file's data. */
export const CAMERA_CATALOG_VERSION = 4;

/**
 * First Rust agent version that compiles a catalog in.
 *
 * It is the `minAgent` of EVERY sensor, the IMX290 included, on purpose: an
 * agent older than the first catalog-aware build cannot apply any managed
 * sensor choice (it does not know the namespace), so a console that disables
 * the picker below this version is right for the IMX290 too. Such a device
 * keeps running its IMX290 exactly as today, unmanaged.
 *
 * ⚠️ WORKING VALUE. The agent is at v0.1.1 and release tags are the owner's;
 * 0.2.0 is the working number from the plan's touch map and stays until the
 * first catalog-aware build is tagged.
 */
const FIRST_CATALOG_AGENT_VERSION = '0.2.0';

/**
 * First Rust agent version whose compiled-in catalog is version 4 (the first
 * to know the IMX662). The released 0.2.0 carries catalog 3: handed `imx662`
 * it refuses the port (`unknown-sensor`) and leaves config.txt alone.
 *
 * ⚠️ WORKING VALUE: the smallest version after 0.2.0. Release tags are the
 * owner's; this must equal the first tagged build that vendors catalog 4, so
 * move it if that tag is not 0.2.1. The console disables the IMX662 for a
 * device that reports a lower release; nothing else reads it.
 */
const CATALOG_V4_AGENT_VERSION = '0.2.1';

const ARDUCAM_RELEASES =
  'https://github.com/ArduCAM/Arducam-Pivariety-V4L2-Driver/releases/download';

export const CAMERA_CATALOG_SOURCE: CameraCatalogInput = {
  schemaVersion: CAMERA_CATALOG_SCHEMA_VERSION,
  catalogVersion: CAMERA_CATALOG_VERSION,
  generatedBy: 'backend/xorgate-core-service: npm run contract:generate',

  sensors: [
    // ── IMX290 ──────────────────────────────────────────────────────────────
    // The sensor of every device in the field. Its entry must describe exactly
    // today's line (`dtoverlay=imx290,cam0`): default rotation 0, no fixed
    // parameter.
    //
    // The `imx327` and `imx462` overlays are served by the same `imx290`
    // driver and node name. They are NOT entries and NOT aliases here: neither
    // board has been on a bench, each is its own overlay (so its own line),
    // and what libcamera names them is unverified. They become separate
    // entries when one is seen working; the "one owner per overlay / node
    // name" rule in the schema then has to admit a shared node name.
    //
    // The overlay's `mono` and `4lane` parameters are left out for the same
    // reason: never exercised.
    {
      id: 'imx290',
      label: 'Sony IMX290',
      tier: 'supported',
      minAgent: FIRST_CATALOG_AGENT_VERSION,
      overlay: { name: 'imx290', fixedParams: [], defaultRotation: 0, canFlip: true },
      options: [
        {
          key: 'clockFrequency',
          label: 'Clock frequency',
          description:
            'Frequency of the crystal on the camera board. Most boards use 37.125 MHz; ' +
            'some use 74.25 MHz. The sensor cannot report it.',
          param: 'clock-frequency',
          unit: 'Hz',
          // 37.125 MHz: every bench and fielded device.
          // 74.25 MHz: READ, NOT EXERCISED (no such board has been on a bench).
          values: [37125000, 74250000],
          default: 37125000,
        },
      ],
      libcameraNames: ['imx290'],
      dtNodeNames: ['imx290'],
      // The probe does no I2C at all: a camera is listed whatever is attached.
      identity: 'none',
      source: { props: [] },
      // Trixie: overlay name, `clock-frequency` and rotation default READ
      // unchanged in the 6.18.60 kernel package; ⚠️ not yet on a Trixie bench.
      requires: { os: ['bookworm', 'trixie'], packageSet: null },
      unsupportedPresets: [], // today's baseline: every preset runs on it
      info: {
        nativeAspect: '16:9', // 1920x1080
        fullModeMaxFps: null, // not recorded
        // Not measured. (Inferred from the driver: a 720p request gets the
        // sensor's own 1280x720 mode.)
        sensorWidthPercent: { p720: null, p1080: null },
        sensorHeightPercent: { p720: null, p1080: null },
      },
      notes: [
        'The device cannot tell whether an IMX290 is really attached: this driver lists a ' +
          'camera for whatever is on the port. A wrong choice shows only as a camera that ' +
          'delivers no picture.',
      ],
    },

    // ── IMX219 ──────────────────────────────────────────────────────────────
    // Streaming on bench 2 (CM5, CAM1) with no agent change, 2026-11-21.
    {
      id: 'imx219',
      label: 'Sony IMX219',
      tier: 'supported',
      minAgent: FIRST_CATALOG_AGENT_VERSION,
      // No token = 180: device tree `00 00 00 b4`, both flips on (measured).
      overlay: { name: 'imx219', fixedParams: [], defaultRotation: 180, canFlip: true },
      options: [],
      libcameraNames: ['imx219'],
      dtNodeNames: ['imx219'], // …/i2c@70000/imx219@10
      identity: 'chip-id', // `chip id mismatch: 219!=…`, no camera listed
      source: { props: [] },
      // Trixie: streaming through agent 0.2.0 on stock libcamera 0.8.0, bench 2
      // (CM5), 2026-11-23 (evidence/2026-11-23-trixie-upgrade).
      requires: { os: ['bookworm', 'trixie'], packageSet: null },
      unsupportedPresets: [], // all five started at the capture front end (bench 2)
      info: {
        nativeAspect: '4:3', // 3280x2464
        fullModeMaxFps: 21, // 3280x2464@21 (driver source)
        // Measured: all five presets use the 1920x1080 centre crop,
        // (688,700)/1920x1080 of 3280x2464.
        sensorWidthPercent: { p720: 58.5, p1080: 58.5 },
        sensorHeightPercent: { p720: 43.8, p1080: 43.8 },
      },
      notes: [
        'The 720p and 1080p presets both show the centre 58.5% of the sensor width: a ' +
          'narrower view than the lens gives at full resolution.',
        'A board with a non-stock lens can show a colour cast, because the stock tuning ' +
          'file is made for the Camera Module 2 lens.',
      ],
    },

    // ── IMX708 ──────────────────────────────────────────────────────────────
    // Streaming on the CM4 bench (CAM0) with no agent change, 2026-11-21.
    {
      id: 'imx708',
      label: 'Sony IMX708 (Camera Module 3)',
      tier: 'supported',
      minAgent: FIRST_CATALOG_AGENT_VERSION,
      // No token = 180: device tree `00 00 00 b4`, both flips on (measured).
      overlay: { name: 'imx708', fixedParams: [], defaultRotation: 180, canFlip: true },
      options: [
        {
          key: 'linkFrequency',
          label: 'Link frequency',
          description:
            'CSI-2 link frequency. Change it only if the camera interferes with a GPS ' +
            'receiver beside it: Camera Module 3 can radiate at a harmonic near GPS L1.',
          param: 'link-frequency',
          unit: 'Hz',
          // 450 MHz: the CM4 bench.
          // 447 and 453 MHz: READ, NOT EXERCISED.
          values: [450000000, 447000000, 453000000],
          default: 450000000,
        },
      ],
      // Standard, wide, NoIR and wide NoIR modules each report their own name.
      libcameraNames: ['imx708', 'imx708_wide', 'imx708_noir', 'imx708_wide_noir'],
      dtNodeNames: ['imx708'], // …/i2c@0/imx708@1a
      identity: 'chip-id', // `chip id mismatch: 708!=…`, no camera listed
      // No lens position is set in v1 (plan owner's ruling, 2026-11-21): the
      // agent passes nothing and the lens stays where libcamera puts it, 1.0
      // dioptre, about 1 m (measured). The two bench sessions proposed 0.5 and
      // then 0.75, each with low-to-moderate confidence and nothing beyond
      // about 4 m in view (evidence/2026-11-21-cm4-imx708-focus). A value
      // chosen later goes here as `lens-position=<dioptres>`.
      source: { props: [] },
      // Trixie: overlay name, `link-frequency` and rotation default READ
      // unchanged in the 6.18.60 kernel package; ⚠️ not yet on a Trixie bench.
      requires: { os: ['bookworm', 'trixie'], packageSet: null },
      unsupportedPresets: [], // all five started at the capture front end (CM4)
      info: {
        nativeAspect: '16:9', // 4608x2592
        fullModeMaxFps: 14, // 4608x2592@14 (driver source)
        // Measured: 720p uses the 1536x864 crop mode (the centre 3072x1728 of
        // the array), 1080p the full-view 2304x1296 binned mode.
        sensorWidthPercent: { p720: 66.7, p1080: 100 },
        sensorHeightPercent: { p720: 66.7, p1080: 100 },
      },
      notes: [
        'The 720p presets show the centre 66.7% of the sensor width; the 1080p presets ' +
          'show the full width. The view changes with the preset.',
        "Focus stays at the lens's default position. There is no autofocus setting.",
      ],
    },

    // ── IMX335 ──────────────────────────────────────────────────────────────
    // Stock libcamera has no camera helper for it, on any platform; Arducam's
    // two packages add one, install over stock and leave the other port's
    // IMX219 working (bench 2, evidence/2026-11-21-bench2-arducam-libcamera).
    //
    // With those packages it runs through the unmodified agent beside the
    // IMX219: bound on 18 of 18 boots in both line orders, both captures up
    // for 10 minutes (bench 2, evidence/2026-11-21-bench2-imx335-live). One
    // unit, one afternoon: it was electrically silent until then.
    {
      id: 'imx335',
      label: 'Sony IMX335 (Arducam)',
      tier: 'supported-with-packages',
      minAgent: FIRST_CATALOG_AGENT_VERSION,
      overlay: {
        name: 'imx335',
        fixedParams: [],
        // Measured: a line with no token gives device tree `00 00 00 b4`
        // (180). The overlay's help text ("default 0") is wrong.
        // It decides NOTHING for the picture, see `canFlip`. No consumer may
        // derive an orientation from this value for this sensor.
        defaultRotation: 180,
        // Measured: `rotation=0`, `rotation=180` and no token give the same
        // picture. The sensor has a vertical flip only (no horizontal-flip
        // control exists), so a 180° turn at the sensor is impossible and
        // libcamera applies none.
        canFlip: false,
      },
      options: [
        {
          key: 'linkFrequency',
          label: 'Link frequency',
          description:
            'CSI-2 link frequency of the camera board. 594 MHz is the overlay default; ' +
            'use 445.5 MHz only if the board vendor says so.',
          param: 'link-frequency',
          unit: 'Hz',
          // 594 MHz: bench 2 (`Using a link rate of 1188 Mbps`).
          // 445.5 MHz: READ, NOT EXERCISED.
          values: [594000000, 445500000],
          default: 594000000,
        },
      ],
      // `0 : imx335 [2624x1944 12-bit RGGB] (…/i2c@88000/imx335@1a)`.
      libcameraNames: ['imx335'],
      dtNodeNames: ['imx335'],
      // The probe expects 0x00 at register 0x3912. Another chip can pass: on
      // the CM4 this driver bound to an IMX708 with no kernel error.
      identity: 'weak',
      source: { props: [] },
      // Trixie: stock libcamera 0.8.0 still has no IMX335 helper (the port
      // reads `requirements-missing`); with Arducam's 0.8.0 pair (the trixie
      // target below) it is listed and streams beside an IMX219, bench 2
      // (CM5), 2026-11-23 (evidence/2026-11-23-trixie-upgrade, Part D).
      requires: { os: ['bookworm', 'trixie'], packageSet: 'arducam-libcamera' },
      // Measured, 5 of 5 attempts: `framerate=30/1` cannot be negotiated on
      // the full mode (`streaming stopped, reason not-negotiated`), the
      // process exits at once. The other four presets start and hold rate.
      unsupportedPresets: [
        {
          preset: '1080p30-4mbps',
          reason:
            "The IMX335's full-resolution mode tops out at 29.99 frames per second, so a " +
            '30 fps 1080p stream cannot start. Use 1080p15-2mbps or a 720p preset.',
        },
      ],
      info: {
        nativeAspect: '4:3', // 2592x1944 active (listed as 2624x1944)
        // Measured on bench 2: the full mode tops out at 29.99 (the driver
        // source says 2592x1944@30), which is why `framerate=30/1` is never
        // negotiated and 1080p30 is in `unsupportedPresets`.
        fullModeMaxFps: 29.99,
        // Measured: 720p uses the binned 1312x972 mode (full width, 75.9% of
        // the height), 1080p the full mode (98.8% of the width, 75% of the
        // height). So both sizes show practically the same view.
        sensorWidthPercent: { p720: 100, p1080: 98.8 },
        sensorHeightPercent: { p720: 75.9, p1080: 75 },
      },
      notes: [
        "Needs Arducam's libcamera packages. Until they are installed the port reports " +
          'that its requirements are missing.',
        'This sensor cannot be rotated: the camera mounting setting has no effect on it. ' +
          'Mount the camera the right way up; turning the picture in software is not offered.',
      ],
    },

    // ── IMX662 ──────────────────────────────────────────────────────────────
    // Sony STARVIS 2, 2 MP. Was the one `planned` entry until catalog 4.
    //
    // ⚠️ NOT YET ON A BENCH. Every value below was READ from the shipped
    // Trixie packages (`linux-image-6.18.60+rpt-rpi-2712`, its overlay README,
    // and `libcamera-ipa_0.8.0+rpt20261104-1`) and from the overlay and
    // driver sources on `rpi-6.18.y` (phase-6/research-trixie.md §3), and the
    // driver, both overlays and the tuning file were seen present on bench 2
    // after its Trixie upgrade (evidence/2026-11-23-trixie-upgrade, C4). No
    // IMX662 has been attached yet.
    //
    // Bookworm (kernel 6.12) has no driver, overlay or helper at all. The
    // driver (`sony-starvis2`, raspberrypi/linux PR #7615) is first packaged
    // in kernel 6.18.60; the 2026-10-06 Trixie Lite image ships 6.18.50,
    // which lacks it. libcamera carries the helper and the tuning for both
    // pipelines (CM5 `pisp`, CM4 `vc4`) from 0.8.0 (and in 0.7.2+rpt builds
    // from 2026-08). The catalog cannot express a minimum kernel or libcamera
    // version, so the first note says it; a device on an older kernel shows
    // the camera as not detected.
    {
      id: 'imx662',
      label: 'Sony IMX662',
      tier: 'supported',
      minAgent: CATALOG_V4_AGENT_VERSION,
      overlay: {
        // `imx662-overlay.dts` is a one-line include of `starvis2-overlay.dts`.
        name: 'imx662',
        fixedParams: [],
        // ⚠️ AWAITS A HARDWARE CHECK. `starvis2.dtsi` sets `rotation = <180>`;
        // the overlay README says 0. The same disagreement existed for the
        // IMX335, where the dtsi was right (measured), so 180 here. The
        // agent always writes `rotation=` explicitly, so a wrong value here
        // turns the picture the wrong way, it breaks nothing else.
        defaultRotation: 180,
        // The driver has both the horizontal and the vertical flip control.
        canFlip: true,
      },
      options: [
        {
          key: 'clockFrequency',
          label: 'Clock frequency',
          description:
            'Frequency of the crystal on the camera board. The overlay default is 24 MHz; ' +
            'check the board vendor for others. The sensor cannot report it, and the driver ' +
            'refuses a rate it does not support.',
          param: 'clock-frequency',
          unit: 'Hz',
          // 24 MHz: the overlay default. Every value READ, NOT EXERCISED (the
          // overlay README lists all five; no IMX662 has been on a bench).
          values: [24000000, 27000000, 37125000, 72000000, 74250000],
          default: 24000000,
        },
      ],
      // The overlay's `4lane` flag is left out: an option here is an integer
      // parameter (`<param>=<value>`), and the catalog has no flag kind. Its
      // `link-frequency` (README 445.5 MHz, dtsi 594 MHz: they disagree) is
      // left out until a bench needs it.
      //
      // The driver names the subdevice after the variant, so libcamera lists
      // `imx662`; the device-tree NODE is `starvis2@1a`, not `imx662@1a`.
      // (If another STARVIS 2 sensor served by the same driver becomes an
      // entry, the "one owner per node name" rule in the schema has to admit
      // a shared node name.)
      libcameraNames: ['imx662'],
      dtNodeNames: ['starvis2'],
      // The probe reads a real chip ID (register 0x4d1c, mask 0x3ff, value
      // 0x296; colour or mono detected) and fails with "No Starvis2 camera
      // found" on anything else.
      identity: 'chip-id',
      source: { props: [] },
      requires: { os: ['trixie'], packageSet: null },
      // As for the IMX290, the other 1920x1080-class sensor: no preset is
      // known not to run. ⚠️ Not measured.
      unsupportedPresets: [],
      info: {
        nativeAspect: '16:9', // 1936x1096 active
        fullModeMaxFps: null, // not recorded
        sensorWidthPercent: { p720: null, p1080: null }, // not measured
        sensorHeightPercent: { p720: null, p1080: null }, // not measured
      },
      notes: [
        'Needs Debian Trixie with kernel 6.18.60 or later and libcamera 0.8.0 or later: run ' +
          'sudo apt full-upgrade on the device first. On an older kernel the camera is not ' +
          'detected.',
        'Not yet tested on a bench by xorgate. The driver and the tuning files ship with ' +
          'Raspberry Pi OS for both the CM5 and the CM4.',
      ],
    },
  ],

  // Empty since catalog 4 (the IMX662 became a sensor). The mechanism stays:
  // the next announced sensor goes here.
  planned: [],

  packageSets: [
    // Bench 2, 2026-11-21 (evidence/2026-11-21-bench2-arducam-libcamera):
    // these two debs, 1.1 MB, are the smallest set that carries the IMX335
    // helper. Arducam's own install script is NOT the recipe (it adds 202
    // packages and sources unpinned remote text as bash).
    // The hashes match the digests GitHub's API publishes for the assets.
    {
      id: 'arducam-libcamera',
      label: "Arducam's libcamera build (adds the IMX335 camera helper)",
      aptHold: true,
      notes: [
        'Replaces the stock libcamera0.5 and libcamera-ipa packages of the same name. ' +
          'Nothing else changes; the stock GStreamer plugin keeps working against them.',
        'Needs an apt hold on both packages: a newer stock libcamera would otherwise ' +
          'replace them on an upgrade and remove the IMX335 helper. The hold also keeps ' +
          'later stock libcamera fixes off that device.',
        "Fetched from Arducam's GitHub release and checked against the pinned sha256. " +
          'Release assets can be replaced upstream; a file that no longer matches is refused.',
        // Added in catalog 4; the first note above is about Bookworm and is
        // kept byte for byte.
        'On Debian Trixie the pair is libcamera0.8 and libcamera-ipa 0.8.0, Arducam\'s ' +
          'build of the stock 0.8.0. The two releases cannot share files: each OS has its ' +
          'own pinned pair.',
      ],
      targets: [
        {
          os: 'bookworm',
          arch: 'arm64',
          packages: [
            {
              name: 'libcamera0.5',
              version: '0.5.2+rpt20250909-1',
              url: `${ARDUCAM_RELEASES}/libcamera-v0.0.5/libcamera0.5_0.5.2+rpt20250909-1_arm64.deb`,
              sha256: '85ae12c0f8c2809d97ecd8b0cb7ca641a178f5e5e5b6a1fa81ff61afc43763dd',
              bytes: 527340,
            },
            {
              name: 'libcamera-ipa',
              version: '0.5.2+rpt20250909-1',
              url: `${ARDUCAM_RELEASES}/libcamera-v0.0.5/libcamera-ipa_0.5.2+rpt20250909-1_arm64.deb`,
              sha256: '247961da888ab177dfac1ceb8e0e75edf2cd2f8722be2fd46984041e87d12503',
              bytes: 600732,
            },
          ],
        },
        // The same GitHub release, uploaded 2026-11-12: Arducam's build of the
        // stock Trixie libcamera 0.8.0 with the IMX335 helper added (build
        // string `v0.8.0+rpt20261104+25-3838bd38-dirty`; t64 dependencies,
        // libc6 >= 2.38). The library package is `libcamera0.8` here, not
        // `libcamera0.5`: each target carries its own package list.
        // Sizes and sha256 checked against the downloaded files on bench 2,
        // where the pair installed over stock 0.8.0 in one transaction (only
        // these two upgraded), the stock GStreamer plugin kept loading, and
        // the IMX335 streamed beside an IMX219 (2026-11-23,
        // evidence/2026-11-23-trixie-upgrade, D1/D3-D4). Installed by hand
        // there, so the agent's own install of this target is ⚠️ not yet run.
        {
          os: 'trixie',
          arch: 'arm64',
          packages: [
            {
              name: 'libcamera0.8',
              version: '0.8.0+rpt20261106-2',
              url: `${ARDUCAM_RELEASES}/libcamera-v0.0.5/libcamera0.8_0.8.0+rpt20261106-2_arm64.deb`,
              sha256: '8f591a09c3faf866821eb421c4f601a1ff9029ff36baa8aeb32de3467b7728eb',
              bytes: 591404,
            },
            {
              name: 'libcamera-ipa',
              version: '0.8.0+rpt20261106-2',
              url: `${ARDUCAM_RELEASES}/libcamera-v0.0.5/libcamera-ipa_0.8.0+rpt20261106-2_arm64.deb`,
              sha256: '5145f1961c195f1bf782e7f1233afb605c1afe97ceae79888ec5557ddfd26ccc',
              bytes: 659076,
            },
          ],
        },
      ],
    },
  ],
};
