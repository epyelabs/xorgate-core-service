import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';
import { CAMERAS_MAX_KEYS, STREAM_KEY_RE } from './recording';

/**
 * The `cameraMount` namespace (cam-sensor-level-rotate plan) — how each camera
 * is physically mounted, expressed as the rotation the SENSOR must apply so
 * every consumer sees an upright frame.
 *
 * A mounting fact, not a recording setting (Q1): a device in bridge-only mode
 * with recording disabled still needs its picture the right way up, so this
 * cannot live inside `recording.video`. `imuMount` is the precedent, and the
 * two namespaces are the same idea for two different sensors.
 *
 * The device applies it by editing the `rotation=180` parameter on the
 * camera's `dtoverlay=` line in `/boot/firmware/config.txt`, which flips the
 * image in the sensor's own readout registers — measured at +0.0% CPU on both
 * CM5 and CM4, against +21%/+50% for a `videoflip` element. The cost is that
 * it only takes effect on the next boot: the agent NEVER reboots by itself
 * (Q2), it edits the line and reports `rebootRequired` on the namespace's
 * status until an operator reboots the device.
 *
 * `rotationDeg` is a closed `0 | 180` enum rather than a boolean (Q3): it is
 * self-documenting on the wire and leaves room for 90/270 if a `videoflip`
 * fallback is ever accepted, without a schema break. 90/270 are NOT valid
 * today — the overlay parameter itself takes only 0 or 180.
 */

/** The only values the camera overlay's `rotation` parameter accepts. */
export const CAMERA_ROTATIONS = [0, 180] as const;
export type CameraRotationDeg = (typeof CAMERA_ROTATIONS)[number];

const cameraMountEntrySchema = z
  .object({
    rotationDeg: z
      // The union's own message is "Invalid input", which tells an operator
      // nothing about a closed two-value set that ends up in a boot config.
      .union([z.literal(0), z.literal(180)], {
        errorMap: () => ({ message: 'must be 0 or 180' }),
      })
      .describe(
        'Rotation applied at the sensor, degrees. 180 = the camera is mounted upside down, so ' +
          'the sensor flips H+V and every consumer (live WebRTC, recorded MP4s, replays, ' +
          'workflow frames) sees an upright image with no added CPU. Only 0 and 180 exist — ' +
          'the camera overlay parameter has no 90/270.',
      ),
  })
  .strict();

export const cameraMountConfigSchema = z
  .object({
    // Keyed by stream key (`cam0`, `cam1`, …) exactly like `recording.video.cameras`
    // — the same device-specific identity, so the same shape rule rather than a
    // closed enum. Front and rear are independent `dtoverlay` lines on the Pi,
    // so they can genuinely differ.
    cameras: z
      .record(
        z.string().regex(STREAM_KEY_RE, 'must be a stream key'),
        cameraMountEntrySchema,
      )
      .refine((m) => Object.keys(m).length <= CAMERAS_MAX_KEYS, {
        message: `at most ${CAMERAS_MAX_KEYS} cameras`,
      })
      .describe(
        'Per-camera mounting rotation keyed by stream key, e.g. {"cam0": {"rotationDeg": 180}}. ' +
          'An ABSENT key is UNMANAGED: the device leaves that camera\'s boot config exactly as ' +
          'it found it. Send an explicit {"rotationDeg": 0} to take a camera over and force it ' +
          'upright. Takes effect on the next boot — the device reports `rebootRequired` and ' +
          'never reboots itself.',
      ),
  })
  .strict();

export type CameraMountConfig = z.infer<typeof cameraMountConfigSchema>;

/**
 * Device behaviour with the namespace absent: no camera is managed, so the
 * boot config is left untouched.
 *
 * Deliberately NOT "every camera is 0" (the `cellular` safety posture): an
 * installer who set `rotation=180` by hand on a box the cloud has never
 * configured must not have it silently stripped — and stripping it would also
 * raise `rebootRequired` on a device nobody asked to change. Managing a camera
 * is always an explicit key.
 */
export const CAMERA_MOUNT_DEFAULTS = { cameras: {} } as const;

export const cameraMountNamespace: ConfigNamespaceSpec<CameraMountConfig> = {
  key: 'cameraMount',
  title: 'CameraMountConfig',
  description:
    'Camera mounting rotation (`cameraMount` namespace): per-camera 0/180 applied at the image ' +
    'sensor via the camera overlay in /boot/firmware/config.txt, so live video, recordings, ' +
    'replays and workflow frames are all corrected at zero CPU cost. ⚠️ Applies on the NEXT ' +
    'BOOT: the agent edits the boot config and reports the namespace with a `rebootRequired` ' +
    'detail; it never reboots the device itself. An absent camera key is unmanaged (the boot ' +
    'config is left as found); an explicit `rotationDeg: 0` forces that camera upright.',
  schema: cameraMountConfigSchema,
  defaults: CAMERA_MOUNT_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: null, // new namespace, born into `devices.config` -> no column, no migration
  legacyPutField: null,
  kind: 'object',
};
