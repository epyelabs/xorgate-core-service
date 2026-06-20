import {
  pgTable,
  text,
  uuid,
  jsonb,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

// Cognito sub as primary key. Identity-level table; org membership lives in `memberships`.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  tier: text('tier').default('free'),
  role: text('role').default('user').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('organizations_slug_idx').on(t.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('memberships_user_org_idx').on(t.userId, t.organizationId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    hashedKey: text('hashed_key').notNull(),
    scope: text('scope').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('api_keys_hashed_key_idx').on(t.hashedKey)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('projects_org_slug_idx').on(t.organizationId, t.slug)],
);

// Platform-wide catalog. No organizationId. Read by any authed user; mutation gated to users.role='admin'.
export const deviceModels = pgTable(
  'device_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    sku: text('sku').notNull(),
    ioCapabilities: jsonb('io_capabilities'),
    firmwareChannel: text('firmware_channel'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('device_models_sku_idx').on(t.sku)],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    deviceModelId: uuid('device_model_id')
      .references(() => deviceModels.id, { onDelete: 'restrict' })
      .notNull(),
    serial: text('serial').notNull(),
    name: text('name'),
    firmwareVersion: text('firmware_version'),
    status: text('status').default('provisioned').notNull(),
    // Opt-in telemetry persistence. When false (default) the ingest Lambda streams
    // to IoT Core but writes nothing to telemetry_readings / device_latest.
    persistTelemetry: boolean('persist_telemetry').default(false).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('devices_project_serial_idx').on(t.projectId, t.serial),
    index('devices_project_idx').on(t.projectId),
    index('devices_model_idx').on(t.deviceModelId),
  ],
);

// Device onboarding codes. A short-lived code minted by the web app and claimed
// (unauthenticated) by install.sh running on the remote device. On claim the
// `devices` row + IoT identity are created and linked back here via `deviceId`.
// `status` is text (not pgEnum) to dodge the aws-data-api enum-cast issue — same
// reasoning as devices.status / deviceIdentities.status.
export const deviceRegistrations = pgTable(
  'device_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    deviceModelId: uuid('device_model_id')
      .references(() => deviceModels.id, { onDelete: 'restrict' })
      .notNull(),
    createdByUserId: text('created_by_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').default('pending').notNull(), // pending | claimed | expired
    // Set on claim. onDelete set null so deleting a claimed device leaves the
    // (now historical) registration row intact.
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    serial: text('serial'), // filled on claim (derived from the device's machine-id)
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_registrations_code_idx').on(t.code),
    index('device_registrations_project_status_idx').on(t.projectId, t.status),
  ],
);

// --- Device Media & Telemetry Streaming (P0) ---

// Per-device KVS WebRTC signaling channel, one row per media stream (cam0/cam1/audio0).
export const kvsChannels = pgTable(
  'kvs_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    streamKey: text('stream_key').notNull(), // cam0 | cam1 | audio0
    channelName: text('channel_name').notNull(), // `${deviceId}-${streamKey}`
    channelArn: text('channel_arn').notNull(),
    region: text('region').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('kvs_channels_device_stream_idx').on(t.deviceId, t.streamKey)],
);

// IoT X.509 identity + credential-provider binding. Private key is never stored (returned once at provisioning).
export const deviceIdentities = pgTable(
  'device_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    iotThingName: text('iot_thing_name').notNull(),
    certificateId: text('certificate_id').notNull(),
    certificateArn: text('certificate_arn').notNull(),
    policyName: text('policy_name').notNull(),
    roleAlias: text('role_alias').notNull(),
    credentialEndpoint: text('credential_endpoint').notNull(),
    status: text('status').default('active').notNull(), // active | revoked (text, not pgEnum)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_identities_device_idx').on(t.deviceId),
    uniqueIndex('device_identities_cert_idx').on(t.certificateId),
  ],
);

// Hot path. Tall/narrow (one row per metric). Physically RANGE(ts)-partitioned monthly via drizzle/manual/001.
// No primary key: keeps batched inserts cheap; last-writer wins.
export const telemetryReadings = pgTable(
  'telemetry_readings',
  {
    deviceId: uuid('device_id').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(), // 'imu.z', 'gps.lat', 'system.cpu_temp', 'media.kvs'
    value: doublePrecision('value'),
    unit: text('unit'),
    meta: jsonb('meta'),
  },
  (t) => [
    index('telemetry_device_metric_ts_idx').on(t.deviceId, t.metric, t.ts),
    index('telemetry_device_ts_metric_idx').on(t.deviceId, t.ts, t.metric),
  ],
);

// One row per (device, metric): the latest reading. Upserted via ON CONFLICT (device_id, metric).
export const deviceLatest = pgTable(
  'device_latest',
  {
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value'),
    unit: text('unit'),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('device_latest_device_metric_idx').on(t.deviceId, t.metric)],
);

// A continuous recording run for one stream. Groups segments and holds the CMAF init key.
export const mediaSessions = pgTable(
  'media_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    streamKey: text('stream_key').notNull(),
    initKey: text('init_key'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    codec: text('codec'),
    width: integer('width'),
    height: integer('height'),
    fps: integer('fps'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('media_sessions_device_stream_started_idx').on(t.deviceId, t.streamKey, t.startedAt)],
);

// One row per uploaded .m4s segment. The AI-addressable media index (device + time range).
export const mediaSegments = pgTable(
  'media_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    sessionId: uuid('session_id').references(() => mediaSessions.id, { onDelete: 'cascade' }),
    streamKey: text('stream_key').notNull(),
    s3Key: text('s3_key').notNull(),
    seq: integer('seq').notNull(),
    startTs: timestamp('start_ts', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    keyframe: boolean('keyframe').default(true).notNull(),
    sizeBytes: integer('size_bytes'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('media_segments_device_stream_start_idx').on(t.deviceId, t.streamKey, t.startTs),
    uniqueIndex('media_segments_s3key_idx').on(t.s3Key),
  ],
);

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type Organization = InferSelectModel<typeof organizations>;
export type NewOrganization = InferInsertModel<typeof organizations>;
export type Membership = InferSelectModel<typeof memberships>;
export type NewMembership = InferInsertModel<typeof memberships>;
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;
export type Project = InferSelectModel<typeof projects>;
export type NewProject = InferInsertModel<typeof projects>;
export type DeviceModel = InferSelectModel<typeof deviceModels>;
export type NewDeviceModel = InferInsertModel<typeof deviceModels>;
export type Device = InferSelectModel<typeof devices>;
export type NewDevice = InferInsertModel<typeof devices>;
export type DeviceRegistration = InferSelectModel<typeof deviceRegistrations>;
export type NewDeviceRegistration = InferInsertModel<typeof deviceRegistrations>;
export type KvsChannel = InferSelectModel<typeof kvsChannels>;
export type NewKvsChannel = InferInsertModel<typeof kvsChannels>;
export type DeviceIdentity = InferSelectModel<typeof deviceIdentities>;
export type NewDeviceIdentity = InferInsertModel<typeof deviceIdentities>;
export type TelemetryReading = InferSelectModel<typeof telemetryReadings>;
export type NewTelemetryReading = InferInsertModel<typeof telemetryReadings>;
export type DeviceLatest = InferSelectModel<typeof deviceLatest>;
export type NewDeviceLatest = InferInsertModel<typeof deviceLatest>;
export type MediaSession = InferSelectModel<typeof mediaSessions>;
export type NewMediaSession = InferInsertModel<typeof mediaSessions>;
export type MediaSegment = InferSelectModel<typeof mediaSegments>;
export type NewMediaSegment = InferInsertModel<typeof mediaSegments>;
