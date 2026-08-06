import { z } from 'zod';
import type { ConfigNamespaceSpec } from './types';

/**
 * The `imuMount` namespace — how the BNO085 is physically rotated relative to
 * the vehicle (ZYX euler, degrees). Re-read by the IMU collector on every
 * sample, so a change applies live; when enabled the agent publishes
 * vehicle-frame euler angles (the raw quaternion stays sensor-frame).
 *
 * Replaces the hand-rolled `parseImuMountBody` this used to live in
 * (`handlers/devices.ts`), which accepted ANY finite angle and had no
 * unknown-key rejection. Both are fixed here: a mounting correction beyond a
 * full turn is a typo, and an unknown key was silently persisted before.
 * The device's own parser stays maximally tolerant (any finite number) — the
 * cloud bound is a subset, so nothing the cloud can send is clamped device-side.
 */
export const IMU_MOUNT_ANGLE_MIN = -360;
export const IMU_MOUNT_ANGLE_MAX = 360;

const angle = (axis: string) =>
  z
    .number()
    .finite()
    .min(IMU_MOUNT_ANGLE_MIN)
    .max(IMU_MOUNT_ANGLE_MAX)
    .describe(`${axis} rotation of the sensor relative to the vehicle, degrees.`);

export const imuMountConfigSchema = z
  .object({
    enabled: z
      .boolean()
      .describe('Apply the correction. false publishes sensor-frame euler angles as-is.'),
    rollDeg: angle('Roll'),
    pitchDeg: angle('Pitch'),
    yawDeg: angle('Yaw'),
  })
  .strict();

export type ImuMountConfig = z.infer<typeof imuMountConfigSchema>;

/** Device behaviour with the namespace absent: no correction at all. */
export const IMU_MOUNT_DEFAULTS = {
  enabled: false,
  rollDeg: 0,
  pitchDeg: 0,
  yawDeg: 0,
} as const;

export const imuMountNamespace: ConfigNamespaceSpec<ImuMountConfig> = {
  key: 'imuMount',
  title: 'ImuMountConfig',
  description:
    'IMU mounting correction (`imuMount` namespace): how the sensor is physically rotated ' +
    'relative to the vehicle (ZYX euler, degrees). All four fields are required. Applied live ' +
    'by the IMU collector; absent = no correction.',
  schema: imuMountConfigSchema,
  defaults: IMU_MOUNT_DEFAULTS,
  applyClass: 'agent-poll',
  legacyColumn: 'imuMount',
  legacyPutField: 'imuMount',
  kind: 'object',
};
