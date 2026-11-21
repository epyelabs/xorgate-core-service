import {
  CAMERA_CATALOG_SCHEMA_VERSION,
  PLANNED_TIER,
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
 * Adding a sensor: one entry here, bump `CAMERA_CATALOG_VERSION`,
 * `npm run contract:generate`, update the pin in `test/camera-catalog.test.ts`,
 * a bench run, an agent release.
 *
 * After ANY edit: bump `CAMERA_CATALOG_VERSION` and regenerate. The version is
 * what a device prints when it is handed a sensor its build does not know, so
 * two different catalogs must never share a number.
 */

/** Content version of the catalog. Bump on every change to this file's data. */
export const CAMERA_CATALOG_VERSION = 1;

/**
 * First Rust agent version that compiles a catalog in.
 *
 * ⚠️ UNCONFIRMED. The agent is at v0.1.1 and release tags are the owner's;
 * 0.2.0 is the working number from the plan's touch map. Set it to the real
 * tag before any console logic compares a device's build against `minAgent`.
 */
const FIRST_CATALOG_AGENT_VERSION = '0.2.0';

/**
 * The one fixed lens position the IMX708 is driven to, in dioptres
 * (0.0 = infinity, 1.0 = about 1 m, which is where libcamera leaves the lens
 * when nothing is set).
 *
 * ⚠️ UNCONFIRMED CANDIDATE. 0.5 is the first bench session's proposal with
 * low-to-moderate confidence: that scene had nothing beyond 0.5 m, so far
 * focus could not be judged. A second session the same day
 * (evidence/2026-11-21-cm4-imx708-focus) found surfaces at 3-4 m sharpest at
 * 0.9-1.0 and recommends 0.75, also with low-to-moderate confidence; nothing
 * beyond about 4 m was in view, so infinity is still extrapolated. The value
 * here stays the candidate this entry was specified with until the plan owner
 * picks one. This constant is the single place to change it (then bump
 * `CAMERA_CATALOG_VERSION` and regenerate).
 */
const IMX708_LENS_POSITION_DIOPTRES = 0.5;

/** `lens-position=0.5`; a whole number keeps one decimal (`0.0`) for a float property. */
function lensPositionProp(dioptres: number): string {
  const text = Number.isInteger(dioptres) ? dioptres.toFixed(1) : String(dioptres);
  return `lens-position=${text}`;
}

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
          values: [37125000, 74250000],
          default: 37125000,
        },
      ],
      libcameraNames: ['imx290'],
      dtNodeNames: ['imx290'],
      // The probe does no I2C at all: a camera is listed whatever is attached.
      identity: 'none',
      source: { props: [] },
      requires: { os: ['bookworm'], packageSet: null },
      info: {
        nativeAspect: '16:9', // 1920x1080
        fullModeMaxFps: null, // not recorded
        // Not measured. (Inferred from the driver: a 720p request gets the
        // sensor's own 1280x720 mode.)
        sensorWidthPercent: { p720: null, p1080: null },
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
      label: 'Sony IMX219 (Camera Module 2)',
      tier: 'supported',
      minAgent: FIRST_CATALOG_AGENT_VERSION,
      // No token = 180: device tree `00 00 00 b4`, both flips on (measured).
      overlay: { name: 'imx219', fixedParams: [], defaultRotation: 180, canFlip: true },
      options: [],
      libcameraNames: ['imx219'],
      dtNodeNames: ['imx219'], // …/i2c@70000/imx219@10
      identity: 'chip-id', // `chip id mismatch: 219!=…`, no camera listed
      source: { props: [] },
      requires: { os: ['bookworm'], packageSet: null },
      info: {
        nativeAspect: '4:3', // 3280x2464
        fullModeMaxFps: 21, // 3280x2464@21 (driver source)
        // Measured: all five presets use the 1920x1080 centre crop,
        // (688,700)/1920x1080 of 3280x2464.
        sensorWidthPercent: { p720: 58.5, p1080: 58.5 },
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
          values: [450000000, 447000000, 453000000],
          default: 450000000,
        },
      ],
      // Standard, wide, NoIR and wide NoIR modules each report their own name.
      libcameraNames: ['imx708', 'imx708_wide', 'imx708_noir', 'imx708_wide_noir'],
      dtNodeNames: ['imx708'], // …/i2c@0/imx708@1a
      identity: 'chip-id', // `chip id mismatch: 708!=…`, no camera listed
      source: { props: [lensPositionProp(IMX708_LENS_POSITION_DIOPTRES)] },
      requires: { os: ['bookworm'], packageSet: null },
      info: {
        nativeAspect: '16:9', // 4608x2592
        fullModeMaxFps: 14, // 4608x2592@14 (driver source)
        // Measured: 720p uses the 1536x864 crop mode, 1080p the full-view
        // 2304x1296 binned mode.
        sensorWidthPercent: { p720: 66.7, p1080: 100 },
      },
      notes: [
        'The 720p presets show the centre 66.7% of the sensor width; the 1080p presets ' +
          'show the full width. The view changes with the preset.',
        'Focus is fixed at one lens position. There is no autofocus setting.',
      ],
    },

    // ── IMX335 ──────────────────────────────────────────────────────────────
    // Stock libcamera has no camera helper for it, on any platform; Arducam's
    // two packages add one, install over stock and leave the other port's
    // IMX219 working (bench 2, evidence/2026-11-21-bench2-arducam-libcamera).
    //
    // ⚠️ THIN EVIDENCE. The bench unit was electrically silent until the
    // afternoon of 2026-11-21. It then bound, listed and delivered frames on
    // bench 2 with those packages (evidence/2026-11-21-bench2-imx335-live);
    // that session's report was not yet written when this entry was, so the
    // facts below marked "live" were read from its raw files.
    {
      id: 'imx335',
      label: 'Sony IMX335 (Arducam)',
      tier: 'supported-with-packages',
      minAgent: FIRST_CATALOG_AGENT_VERSION,
      overlay: {
        name: 'imx335',
        fixedParams: [],
        // ⚠️ BEING MEASURED (the bench session is still open). The overlay's
        // help text says 0; the overlay binary carries `rotation = <0xb4>`
        // (180) on the sensor node, and the live device tree of a line with
        // no token read `00 00 00 b4`. So 180.
        // It decides NOTHING: the sensor has a vertical flip only, so
        // libcamera applies no flip and `rotation=` changes no pixels
        // (`canFlip: false`). No consumer may derive an orientation from this
        // value for this sensor.
        defaultRotation: 180,
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
          values: [594000000, 445500000],
          default: 594000000,
        },
      ],
      // Live: `0 : imx335 [2624x1944 12-bit RGGB] (…/i2c@88000/imx335@1a)`.
      libcameraNames: ['imx335'],
      dtNodeNames: ['imx335'],
      // The probe expects 0x00 at register 0x3912. Another chip can pass: on
      // the CM4 this driver bound to an IMX708 with no kernel error.
      identity: 'weak',
      source: { props: [] },
      requires: { os: ['bookworm'], packageSet: 'arducam-libcamera' },
      info: {
        nativeAspect: '4:3', // 2592x1944 active (listed as 2624x1944)
        fullModeMaxFps: 30, // 2592x1944@30 (driver source)
        // Not measured yet. (Inferred: 16:9 uses the full width and 75% of
        // the height.)
        sensorWidthPercent: { p720: null, p1080: null },
      },
      notes: [
        "Needs Arducam's libcamera packages. Until they are installed the port reports " +
          'that its requirements are missing.',
        'This sensor cannot be rotated: the camera mounting setting has no effect on it.',
      ],
    },
  ],

  planned: [
    // No driver, overlay or tuning file exists on Bookworm (kernel 6.12). The
    // driver arrived in the 6.18 kernel line with libcamera 0.7.2+rpt, both
    // Trixie. Last in the plan and allowed to fail.
    {
      id: 'imx662',
      label: 'Sony IMX662',
      tier: PLANNED_TIER,
      requires: { os: ['trixie'] },
      notes: ['Not available yet. It needs a device image built on Debian Trixie.'],
    },
  ],

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
      ],
    },
  ],
};
