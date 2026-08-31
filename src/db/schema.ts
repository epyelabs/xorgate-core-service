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
import { sql } from 'drizzle-orm';
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
// Type-only: the consolidated `devices.config` document shape lives with the
// config registry that validates and publishes it (Phase 2).
import type { DeviceConfigDocument } from '../config-registry/index';

// Cognito sub as primary key. Identity-level table; org membership lives in `memberships`.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name'),
  tier: text('tier').default('free'),
  role: text('role').default('user').notNull(),
  // S3 key of the profile picture in the core bucket, under `avatars/`. Null
  // means "no picture" — clients draw initials. Never handed to a client as-is:
  // the bucket is private, so `GET /me` answers with a presigned URL instead.
  avatarKey: text('avatar_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // S3 key of the logo in the core bucket, under `logos/organizations/`.
    // Null means "no logo" — clients draw initials. Never handed to a client
    // as-is: the bucket is private, so responses carry a presigned URL instead.
    logoKey: text('logo_key'),
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

// Which AWS IoT policies are attached to which Cognito identity, and for whom.
// AWS is the source of truth for the attachment itself; this table exists only
// because AWS cannot answer "which identity belongs to user X" — GetId needs
// the user's own token, so a membership-removal path (which has a user id and
// no token) has no other way to find the identity it must detach from.
// One row per (user, identity, policy). Cardinality is one in practice today
// (GetId is stable per identity pool + provider + sub, verified 2026-08-13),
// but the policy dimension is real: Phase 4 evaluates per-workspace policy
// variants, and a detach must then know which named policies to remove.
export const iotPolicyAttachments = pgTable(
  'iot_policy_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    identityId: text('identity_id').notNull(),
    policyName: text('policy_name').notNull(),
    attachedAt: timestamp('attached_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('iot_policy_attachments_identity_policy_idx').on(
      t.identityId,
      t.policyName,
    ),
    index('iot_policy_attachments_user_idx').on(t.userId),
  ],
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
    // The membership role the key acts with. Same vocabulary as
    // `memberships.role`, same storage (plain text, validated in the handler).
    // A key is not a member row: it has no user, so it cannot be found by any
    // membership query, and this column is the only thing that answers "what may
    // this credential do".
    role: text('role').default('member').notNull(),
    // Opt-in expiry. NULL means never.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // First 8 characters of the plaintext (`xg_` + 5), for display only. NULL on
    // every key minted before Phase 2, and unbackfillable: only the hash was
    // ever stored.
    keyPrefix: text('key_prefix'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('api_keys_hashed_key_idx').on(t.hashedKey),
    index('api_keys_org_active_idx')
      .on(t.organizationId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// Short-lived credential a consumer's BROWSER or mobile app may hold
// (platform-auth-and-live-plane, Phase 3). Minted by presenting an `xg_` key to
// `POST /auth/session-tokens`; presented as `Authorization: Bearer xgs_…`.
//
// DB-backed and hashed, exactly like `api_keys`, rather than a stateless signed
// token. Three reasons, in order: revocation is a row update instead of a
// key-rotation event; the minting key's own lifecycle can cascade (the FK below
// is ON DELETE CASCADE and the verify path joins the key row, so deleting,
// revoking or expiring a key kills every token it minted); and the auth
// middleware already does one indexed lookup per request for keys, so the cost
// model is unchanged.
//
// `workspace_id` is the whole point of the table. It is NULL for an org-scoped
// token, which then behaves exactly like the key that minted it; when set, it is
// an ENFORCED boundary rather than the advisory filter `X-Workspace-Id` is for
// every other caller. See `services/workspace-scope.ts`.
export const sessionTokens = pgTable(
  'session_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // SHA-256 hex of the plaintext, same construction as `api_keys.hashed_key`.
    hashedToken: text('hashed_token').notNull(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    // NULL = org-scoped. Set = the token may only see this workspace.
    // ON DELETE CASCADE: a deleted workspace must not leave tokens naming it.
    workspaceId: uuid('workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
    // Inherited from the minting key, never elevated. The EFFECTIVE role is the
    // lower of this and the key's current role, so downgrading a key downgrades
    // its live tokens too (services/session-token-auth.ts).
    role: text('role').notNull(),
    // The `xg_` key this was exchanged from. CASCADE is the revocation story:
    // `DELETE /api-keys/{id}` is a hard delete, so it takes the tokens with it.
    createdByKeyId: uuid('created_by_key_id')
      .references(() => apiKeys.id, { onDelete: 'cascade' })
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('session_tokens_hashed_token_idx').on(t.hashedToken),
    // The expiry sweep in `offline-sweeper.ts` scans on this.
    index('session_tokens_expires_at_idx').on(t.expiresAt),
    index('session_tokens_created_by_key_idx').on(t.createdByKeyId),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    // Same contract as `organizations.logo_key`, under `logos/workspaces/`.
    logoKey: text('logo_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('workspaces_org_slug_idx').on(t.organizationId, t.slug)],
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
    workspaceId: uuid('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    deviceModelId: uuid('device_model_id')
      .references(() => deviceModels.id, { onDelete: 'restrict' })
      .notNull(),
    serial: text('serial').notNull(),
    name: text('name'),
    // The installed xorgate-device-agent build, MIRRORED from the device's own
    // config report (`effective.agent.build.version`) — never written by an
    // operator. Named for what it is: the agent isn't firmware.
    agentVersion: text('agent_version'),
    status: text('status').default('provisioned').notNull(),
    // Probe-at-claim couldn't pick a model unambiguously (cm4-support D3): the
    // device carries its registration's fallback model until an operator
    // confirms one (PUT /devices/{id} {deviceModelId}), which clears this.
    // Separate from `status` — that column is machine-managed connectivity.
    needsModel: boolean('needs_model').default(false).notNull(),
    // GNSS antenna bias: true powers an active GPS antenna's LNA via the modem's
    // VDD_AUX LDO (AT+CVAUXV/AT+CVAUXS). False (default) = passive antenna, bias
    // off — the hardware-safe state. Delivered to the device as a retained MQTT
    // config message on xorgate/devices/{id}/config.
    gnssAntBias: boolean('gnss_ant_bias').default(false).notNull(),
    // Which pre-made layout the Active Streams tab renders for this device.
    // 'card' (default) is the media-over-telemetry grid; 'map' is the location-first
    // map view. text (not pgEnum) + app-side allowlist, per the enum-cast convention.
    activeStreamsViewType: text('active_streams_view_type').default('card').notNull(),
    // IMU mounting correction: how the BNO085 is physically rotated relative to
    // the vehicle (ZYX euler, degrees). Delivered to the device as retained MQTT
    // config; the agent then publishes vehicle-frame euler angles (the raw
    // quaternion stays sensor-frame). NULL = never configured (no correction).
    imuMount: jsonb('imu_mount').$type<{
      enabled: boolean;
      rollDeg: number;
      pitchDeg: number;
      yawDeg: number;
    }>(),
    // On-device recording config (offline recording plan, Phase 5 / D7). The
    // README `recording` settings shape, validated against a closed preset
    // table on PUT and delivered to the device as retained MQTT config; the
    // agent merges it into settings.json and applies live. NULL = never
    // configured from the cloud (device keeps its local settings; feature off
    // by default).
    recordingConfig: jsonb('recording_config').$type<{
      telemetry?: { enabled?: boolean; rateHz?: number };
      video?: {
        enabled?: boolean;
        preset?: string;
        segmentSeconds?: number;
        bootDefer?: 'auto' | 'always' | 'off';
        bootDeferMaxSecs?: number;
        bootDeferMinBudgetMa?: number;
        /** GPS/LTE video gate (Phase 7); `gpsGateMaxSecs` 0 = no time cap. */
        gpsGate?: 'auto' | 'always' | 'off';
        gpsGateMaxSecs?: number;
        /** No-progress gate escape hatch, seconds; 0 = off (Phase 10 iter 2). */
        gpsGateNoProgressSecs?: number;
        spawnStaggerSecs?: number;
        /** Per-camera enables keyed by streamKey (Phase 6); an absent key = enabled. */
        cameras?: Record<string, boolean>;
      };
      upload?: { mode?: 'auto' | 'off' };
      retention?: { maxBytes?: number; minFreeBytes?: number };
      powerShedding?: {
        enabled?: boolean;
        uvSamples?: number;
        uvWindowSecs?: number;
        railLowVolts?: number;
        railLowSecs?: number;
        escalateDwellSecs?: number;
        escalateDutyPct?: number;
        /**
         * Thermal arm (power_management_improvements plan, Phase 1). These three
         * shipped accepted-and-delivered but were missing from this `$type`, from
         * the publish message interface, from the OpenAPI block and from the CLI
         * allowlist — the drift this plan's registry exists to prevent. The
         * registry (src/config-registry/recording.ts) is now the single source;
         * this column is transition-only and dropped in a follow-up migration.
         */
        cpuTempC?: number;
        cpuTempRestoreC?: number;
        cpuTempSecs?: number;
        restoreSecs?: number;
        railRestoreVolts?: number;
        maxShedsPerHour?: number;
      };
    }>(),
    // LTE recovery policy (lte_gnss_recovery plan, R8): how aggressively the
    // device's connection-manager may use the GNSS-destructive modem reset.
    // Validated on PUT (schemas/lte-recovery-config.ts) and delivered as the
    // `lteRecovery` key of the retained MQTT config; the sim7600-lte daemon
    // reads it live at each recovery decision. NULL = never configured from
    // the cloud (device uses its safe defaults: defer / balanced).
    lteRecoveryConfig: jsonb('lte_recovery_config').$type<{
      gpsFixResetPolicy?: 'defer' | 'veto-deadzone';
      deadZoneProfile?: 'conservative' | 'balanced' | 'aggressive';
    }>(),
    // Offline time sources (optimize-system-process-cycle plan, Phase 4):
    // GPS/NITZ clock stepping while NTP is unsynced. Validated on PUT
    // (schemas/time-sync-config.ts) and delivered as the `timeSync` key of
    // the retained MQTT config; the agent's clock stepper reads it live.
    // NULL = never configured from the cloud (device defaults: stepping on,
    // 10 s threshold, 4 steps/boot).
    timeSyncConfig: jsonb('time_sync_config').$type<{
      offlineSources?: boolean;
      stepThresholdSecs?: number;
      maxStepsPerBoot?: number;
    }>(),
    // Camera direction for the web 3D orientation view. Cloud-only (never
    // delivered to the device). NULL = the view's built-in default 3/4 angle.
    imuView: jsonb('imu_view').$type<{
      azimuthDeg: number;
      elevationDeg: number;
    }>(),
    // ---- Consolidated config (improve_device_settings_management, Phase 2) ----
    // ONE document for everything the device is told, namespaced exactly as the
    // wire/settings.json keys (never renamed — the modem daemon greps those
    // paths). Validated by src/config-registry and published verbatim on
    // xorgate/devices/{id}/config. An ABSENT namespace means "device defaults",
    // so nothing is materialized on create. The six columns above are kept and
    // DUAL-WRITTEN during the transition window; a follow-up migration drops
    // them once no client reads them (cf. drizzle/0022).
    config: jsonb('config').$type<DeviceConfigDocument>().default({}).notNull(),
    // Monotonic, bumped on every config write. Rides the retained message as
    // `rev`; the device (Phase 4) skips a redelivered doc it has already
    // applied, which is what stops reconnect-redelivery reverting newer local
    // state. Also the ordering primitive the reported plane reconciles against
    // (`pending` = config_rev > reported.rev && device online).
    configRev: integer('config_rev').default(0).notNull(),
    configUpdatedAt: timestamp('config_updated_at', { withTimezone: true }),
    // Last device report of what it actually applied (Phase 3 fills these; the
    // columns land now so the reported plane needs no second migration).
    reportedConfig: jsonb('reported_config').$type<Record<string, unknown>>(),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    // Cloud-only presentation prefs, fenced off from `config` so "delivered to
    // the device" vs "never leaves the cloud" is visible in the schema instead
    // of only in the publish trigger list. { activeStreamsViewType, imuView }.
    uiPrefs: jsonb('ui_prefs').$type<Record<string, unknown>>().default({}).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('devices_workspace_serial_idx').on(t.workspaceId, t.serial),
    index('devices_workspace_idx').on(t.workspaceId),
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
    workspaceId: uuid('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    deviceModelId: uuid('device_model_id')
      .references(() => deviceModels.id, { onDelete: 'restrict' })
      .notNull(),
    // True when the operator explicitly picked the model in the Register
    // dialog (cm4-support D3): the claim then honors the pick and skips
    // probe-at-claim mapping. False = deviceModelId is the auto-picked
    // default, which the probe may override.
    modelPinned: boolean('model_pinned').default(false).notNull(),
    // Exactly one of the two creator columns is set. A Cognito-authenticated
    // caller sets the user; an API-key caller sets the key, because a key has no
    // `users` row to point at. Nullable since Phase 2 for that reason.
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
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
    index('device_registrations_workspace_status_idx').on(t.workspaceId, t.status),
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
    // The workspace whose id was last written onto the channel as an AWS
    // resource TAG (platform-auth Phase 4). Scoped live credentials authorize
    // video with a tag condition rather than a channel list, because a channel
    // name carries only `{deviceId}-{streamKey}` and has no tenant text to
    // match on. NULL means "tags unknown", which is the state of every channel
    // created before that phase and of every channel whose device has just
    // moved workspace; the next vend reconciles it.
    taggedWorkspaceId: uuid('tagged_workspace_id'),
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

// Batch-ingest audit/idempotency log (offline recording plan, Phase 2): one row
// per S3 telemetry segment object ever ingested. The PK on s3_key is the
// redelivery guard — an S3 event delivered twice inserts once — and the counts
// give a backlog-debugging audit trail. Low volume (one row per ~60 s segment
// per recording device), so no partitioning.
export const telemetryIngestLog = pgTable('telemetry_ingest_log', {
  s3Key: text('s3_key').primaryKey(),
  deviceId: uuid('device_id').notNull(),
  sessionId: uuid('session_id'),
  rowsInserted: integer('rows_inserted').notNull(),
  linesSkipped: integer('lines_skipped').default(0).notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
});

// A continuous recording run for one stream. Groups segments and holds the CMAF init key.
// Populated (offline recording plan, Phase 4) by media-segment-ingest from device-uploaded
// segments: `id` IS the device-minted session UUID (uuidv7 — sorts by start time), not a
// defaultRandom value; started_at/ended_at/last_segment_at are rolled forward as segments
// arrive. init_key stays NULL until CMAF/stitching lands (deferred).
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
    // Where the session came from: 'device-offline' (Phase 4 device recorder).
    // Text, not pgEnum (aws-data-api enum-cast issue — same as devices.status).
    source: text('source'),
    // Advisory lifecycle: 'open' while segments may still arrive, 'closed' once
    // the sweeper sees no new segment for the close window (there is no explicit
    // end signal — the device may die mid-session). Segments stay queryable
    // regardless of status.
    status: text('status').default('open').notNull(),
    // Device clock quality when the session started: ntp | rtc | unsynced (D6).
    timeSource: text('time_source'),
    bitrateKbps: integer('bitrate_kbps'),
    // S3 key of the poster frame extracted from the session's first segment
    // (media-thumbnail handler). Lives inside the session's own prefix so the
    // segment lifecycle rule expires it too. NULL = no thumbnail (pre-feature
    // session, or extraction failed past retries) — always optional.
    thumbnailKey: text('thumbnail_key'),
    // Server-side arrival time of the most recent segment — the sweeper's
    // close-detection clock (upload can lag recording by hours; never use
    // device timestamps to decide "no longer arriving").
    lastSegmentAt: timestamp('last_segment_at', { withTimezone: true }),
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
    // False = the device cut this fragment mid-write (crash/power loss). Still
    // playable up to the cut (fragmented MP4), but stitching should prefer the
    // next segment's start_ts over this row's duration_ms.
    finalized: boolean('finalized').default(true).notNull(),
    // Sidecar provenance passthrough (anchor: fstat|computed, timeSource,
    // startMono) — kept for cloud-side re-anchoring (D6) without more columns.
    meta: jsonb('meta'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('media_segments_device_stream_start_idx').on(t.deviceId, t.streamKey, t.startTs),
    uniqueIndex('media_segments_s3key_idx').on(t.s3Key),
    // The per-session rollups (`GET /devices/{id}/sessions`, and the run
    // clustering's `agg` CTE) group by session_id, and the segments listing
    // filters on it. Irrelevant at today's ~2 300 rows, cheap insurance before
    // it grows.
    index('media_segments_session_idx').on(t.sessionId),
  ],
);

// --- Workflows (user-defined processing pipelines) ---
// A workflow: a graph of nodes (CV / telemetry processors) that attaches to a
// device, fires on a trigger, and produces reviewable runs + events. `status`
// columns are text (not pgEnum) to dodge the aws-data-api enum-cast issue — same
// reasoning as devices.status. All graph/trigger/payload
// shapes are jsonb, validated app-side against the schemas in src/schemas/workflows.ts.

// Org-scoped template (the reusable definition). `publishedVersion`/`currentVersion`
// are version NUMBERS (not FKs) to mirror the FE and avoid a circular FK with
// workflow_template_versions.
export const workflowTemplates = pgTable(
  'workflow_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    status: text('status').default('draft').notNull(), // draft | published
    currentVersion: integer('current_version').default(1).notNull(),
    publishedVersion: integer('published_version'), // null until first publish
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('workflow_templates_org_slug_idx').on(t.organizationId, t.slug)],
);

// One version row per saved definition. App-enforced invariant (see
// workflow-templates.ts): at most one draft and one published row per template.
export const workflowTemplateVersions = pgTable(
  'workflow_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .references(() => workflowTemplates.id, { onDelete: 'cascade' })
      .notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(), // draft | published | archived
    message: text('message'),
    definition: jsonb('definition').notNull(), // { nodes[], edges[] }
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('workflow_template_versions_template_version_idx').on(t.templateId, t.version)],
);

// A template attached to one device with one or more triggers. Detach keeps run
// history (workflow_runs.attachmentId is set-null on delete).
export const workflowAttachments = pgTable(
  'workflow_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    templateId: uuid('template_id')
      .references(() => workflowTemplates.id, { onDelete: 'cascade' })
      .notNull(),
    pinnedVersion: integer('pinned_version'), // null = follow the published version
    enabled: boolean('enabled').default(true).notNull(),
    triggers: jsonb('triggers').notNull(), // attachmentTriggerSchema[]
    // Denormalized stats (finalizer guards drift with a lastRunAt comparison).
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunStatus: text('last_run_status'), // running | succeeded | failed
    runCount: integer('run_count').default(0).notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('workflow_attachments_device_template_idx').on(t.deviceId, t.templateId)],
);

// Debounce/cooldown + schedule cursor, one row per (attachment, trigger index).
export const workflowTriggerState = pgTable(
  'workflow_trigger_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attachmentId: uuid('attachment_id')
      .references(() => workflowAttachments.id, { onDelete: 'cascade' })
      .notNull(),
    triggerIndex: integer('trigger_index').notNull(), // index into triggers[]
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    lastConditionMet: boolean('last_condition_met'), // edge detection (telemetry)
    lastWindowEnd: timestamp('last_window_end', { withTimezone: true }), // schedule sinceLastRun cursor
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('workflow_trigger_state_attachment_trigger_idx').on(
      t.attachmentId,
      t.triggerIndex,
    ),
  ],
);

// One execution. `definition` is a SNAPSHOT of the version that ran (detach /
// republish never rewrites history). No `queued` status in v1 (see plan §11.1).
// workspace_id / device_id are NULLABLE since migration 0015: simulation runs
// (mode='simulation') that execute only uploaded inputs have no device and
// therefore no workspace; org scoping for such rows goes through template_id.
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id').references(() => workflowAttachments.id, {
      onDelete: 'set null',
    }),
    templateId: uuid('template_id')
      .references(() => workflowTemplates.id, { onDelete: 'cascade' })
      .notNull(),
    templateVersion: integer('template_version').notNull(),
    definition: jsonb('definition').notNull(), // snapshot of the version that ran
    trigger: text('trigger').notNull(), // event | schedule | manual | simulation
    triggerContext: jsonb('trigger_context'),
    status: text('status').default('running').notNull(), // running | succeeded | failed
    // v1 (PoC) values: inline | fargate. v2 engine runs stamp the dispatch
    // target instead: lambda | fargate (simulation rows use these today).
    executionMode: text('execution_mode').notNull(),
    // production | simulation (M3 simulator runs; architecture.md §7).
    mode: text('mode').default('production').notNull(),
    // Which engine ran it: null/1 = PoC inline runner or Python cv-runner,
    // 2 = the v2 TS engine (stamped by the v2 finalize path, session 2).
    engineVersion: integer('engine_version'),
    taskArn: text('task_arn'),
    // M6 idempotency stamp: the SQS dispatcher claims a run atomically
    // (conditional UPDATE ... WHERE dispatched_at IS NULL) before launching an
    // engine target, so an SQS redelivery mid-run can never double-invoke.
    // Null on simulation runs (their dispatch is direct, no retry queue).
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    metrics: jsonb('metrics').default({}).notNull(),
    // v2 engine result artifacts ({ eventsKey, outputs: { <nodeId>: { recordsKey,
    // count, format } } }), stamped by the v2 finalize path so the run detail UI
    // can link Data Capture downloads. Null on PoC-engine runs.
    artifacts: jsonb('artifacts'),
    error: text('error'),
    failedNodeId: text('failed_node_id'),
    eventCount: integer('event_count').default(0).notNull(),
  },
  (t) => [
    index('workflow_runs_workspace_started_idx').on(t.workspaceId, t.startedAt),
    index('workflow_runs_device_started_idx').on(t.deviceId, t.startedAt),
    index('workflow_runs_status_idx').on(t.status), // watchdog sweep
    index('workflow_runs_attachment_idx').on(t.attachmentId),
  ],
);

// One row per executed node (the step trace rendered in the run detail UI).
export const workflowRunSteps = pgTable(
  'workflow_run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .references(() => workflowRuns.id, { onDelete: 'cascade' })
      .notNull(),
    seq: integer('seq').notNull(), // topo order
    nodeId: text('node_id').notNull(),
    label: text('label').notNull(),
    status: text('status').notNull(), // ok | failed | skipped
    output: text('output').default('').notNull(), // human one-liner, e.g. "37 detections"
    durationMs: integer('duration_ms').default(0).notNull(),
    detail: jsonb('detail'),
  },
  (t) => [uniqueIndex('workflow_run_steps_run_node_idx').on(t.runId, t.nodeId)],
);

// A detection/observation emitted by a run. Rendered in the run detail Events tab.
// device_id NULLABLE since migration 0015 (events from device-less simulation runs).
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .references(() => workflowRuns.id, { onDelete: 'cascade' })
      .notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // person_at_perimeter | overspeed | ...
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    confidence: doublePrecision('confidence'),
    clip: boolean('clip').default(false).notNull(),
    clipS3Key: text('clip_s3_key'),
    payloadSummary: text('payload_summary').default('').notNull(),
    payload: jsonb('payload'), // bboxes, observed values
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('workflow_events_run_idx').on(t.runId),
    index('workflow_events_device_occurred_idx').on(t.deviceId, t.occurredAt),
  ],
);

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type Organization = InferSelectModel<typeof organizations>;
export type NewOrganization = InferInsertModel<typeof organizations>;
export type Membership = InferSelectModel<typeof memberships>;
export type NewMembership = InferInsertModel<typeof memberships>;
export type IotPolicyAttachment = InferSelectModel<typeof iotPolicyAttachments>;
export type NewIotPolicyAttachment = InferInsertModel<typeof iotPolicyAttachments>;
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;
export type SessionToken = InferSelectModel<typeof sessionTokens>;
export type NewSessionToken = InferInsertModel<typeof sessionTokens>;
export type Workspace = InferSelectModel<typeof workspaces>;
export type NewWorkspace = InferInsertModel<typeof workspaces>;
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
export type WorkflowTemplate = InferSelectModel<typeof workflowTemplates>;
export type NewWorkflowTemplate = InferInsertModel<typeof workflowTemplates>;
export type WorkflowTemplateVersion = InferSelectModel<typeof workflowTemplateVersions>;
export type NewWorkflowTemplateVersion = InferInsertModel<typeof workflowTemplateVersions>;
export type WorkflowAttachment = InferSelectModel<typeof workflowAttachments>;
export type NewWorkflowAttachment = InferInsertModel<typeof workflowAttachments>;
export type WorkflowTriggerState = InferSelectModel<typeof workflowTriggerState>;
export type NewWorkflowTriggerState = InferInsertModel<typeof workflowTriggerState>;
export type WorkflowRun = InferSelectModel<typeof workflowRuns>;
export type NewWorkflowRun = InferInsertModel<typeof workflowRuns>;
export type WorkflowRunStep = InferSelectModel<typeof workflowRunSteps>;
export type NewWorkflowRunStep = InferInsertModel<typeof workflowRunSteps>;
export type WorkflowEvent = InferSelectModel<typeof workflowEvents>;
export type NewWorkflowEvent = InferInsertModel<typeof workflowEvents>;
