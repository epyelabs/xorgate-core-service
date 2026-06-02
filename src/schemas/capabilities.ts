import { z } from 'zod';

/**
 * Device `io_capabilities` contract (stored on `device_models.io_capabilities` jsonb).
 *
 * Capability-driven: each declared leaf maps to one telemetry `metric` namespace
 * and/or one media stream key. Consumers render/handle only what is declared, so
 * partial-capability devices validate too (every section is optional).
 */

const videoCapabilitySchema = z.object({
  key: z.string(), // cam0, cam1
  codec: z.string(), // h264
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  maxFps: z.number().positive().optional(),
  label: z.string().optional(),
});

const audioCapabilitySchema = z.object({
  key: z.string(), // audio0
  codec: z.string(), // opus
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
});

const mediaCapabilitiesSchema = z.object({
  video: z.array(videoCapabilitySchema).default([]),
  audio: z.array(audioCapabilitySchema).default([]),
});

const imuSensorSchema = z.object({
  axes: z.array(z.string()), // ['x','y','z']
  unit: z.string().optional(),
  rateHz: z.number().positive().optional(),
});

const sensorsCapabilitiesSchema = z.object({
  imu: imuSensorSchema.optional(),
});

const fieldListSchema = z.object({ fields: z.array(z.string()) });

const commCapabilitiesSchema = z.object({
  module: z.string().optional(), // 4g-lte
  gps: fieldListSchema.optional(),
  signal: fieldListSchema.optional(),
});

export const ioCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  media: mediaCapabilitiesSchema.optional(),
  sensors: sensorsCapabilitiesSchema.optional(),
  comm: commCapabilitiesSchema.optional(),
  system: fieldListSchema.optional(),
});

export type IoCapabilities = z.infer<typeof ioCapabilitiesSchema>;

/** Canonical media stream keys used for KVS channels and S3 segment paths. */
export const STREAM_KEYS = ['cam0', 'cam1', 'audio0'] as const;
export type StreamKey = (typeof STREAM_KEYS)[number];
