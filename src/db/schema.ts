import {
  pgTable,
  text,
  uuid,
  jsonb,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  bigint,
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
    // When `status` last changed (xorgate-webhooks, migration 028). Written by
    // the status writers' edge claims from Phase 2 on; the presence events'
    // dedupe key is built from it. Null on rows no edge has touched yet.
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    // A device-simulator device (plans/xorgate-device-simulator, migration 032):
    // the real agent in `--mode replay` in a container on a sim host. FIXED AT
    // CREATION by `POST /device-simulations` and never patchable — the one
    // server-side fact that lets the `simulation` config namespace exist without
    // making "turn this device into a simulator" a cloud write any real device
    // could receive. Its `device_simulations` row carries the rest.
    simulated: boolean('simulated').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('devices_workspace_serial_idx').on(t.workspaceId, t.serial),
    index('devices_workspace_idx').on(t.workspaceId),
    index('devices_model_idx').on(t.deviceModelId),
    index('devices_simulated_idx').on(t.workspaceId).where(sql`simulated`),
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
    // `set null` (manual/020; was `cascade`): a registration is a record of
    // how a device came to exist, and outlives the account that minted it.
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
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

// --- Telemetry session index (telemetry-session-artifacts plan, Phase 1, D7) ---
//
// One row per device-minted telemetry session (the uuidv7 in the segment key
// and header) and one per uploaded segment object. Written by
// telemetry-batch-ingest inside its existing transaction, so a segment is
// never indexed without its ingest-log row and vice versa. The index is what
// the replay manifest (Phase 2) range-scans on (device_id, started_at); it
// never lists S3. Lifecycle is advisory and mirrors media_sessions: the
// sweeper flips open -> closed after `mediaSessionCloseAfterMs` without a
// segment ARRIVAL, then builds the session's overview.v1.json.gz artifact.
// A straggler segment re-opens the session and marks the overview stale.
//
// `insights` mirrors the artifact's block (D12) so lists and fleet roll-ups
// never touch S3; the three promoted columns are the ones a list sorts,
// filters or sums on. Everything else stays in the jsonb.
export const telemetrySessions = pgTable(
  'telemetry_sessions',
  {
    id: uuid('id').primaryKey(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    // Min / max sample ts seen across the session's segments (device clock).
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // Server arrival clock of the newest segment: the close-detection clock.
    lastSegmentAt: timestamp('last_segment_at', { withTimezone: true }).defaultNow().notNull(),
    // open | closed (text, not pgEnum: aws-data-api enum-cast issue).
    status: text('status').default('open').notNull(),
    rateHz: integer('rate_hz'),
    // Worst seen across the session's segment headers: ntp > gps > nitz > rtc > unsynced.
    timeSource: text('time_source'),
    segmentCount: integer('segment_count').default(0).notNull(),
    sampleCount: bigint('sample_count', { mode: 'number' }).default(0).notNull(),
    byteCount: bigint('byte_count', { mode: 'number' }).default(0).notNull(),
    // telemetry/v1/<dev>/<sess>/overview.v1.json.gz once built; NULL while open.
    overviewKey: text('overview_key'),
    overviewBuiltAt: timestamp('overview_built_at', { withTimezone: true }),
    // Gzipped size of the artifact, recorded at PUT time (manual/026) so the
    // replay manifest never HEADs per request; NULL until built or backfilled.
    overviewBytes: integer('overview_bytes'),
    // A segment arrived after the last build: rebuild on the next close pass.
    overviewStale: boolean('overview_stale').default(false).notNull(),
    insights: jsonb('insights'),
    // { [insightId]: version } per computer that produced the mirror above.
    insightsComputed: jsonb('insights_computed').$type<Record<string, number>>(),
    // When `telemetry_session_completed` workflow triggers last fired for this
    // session (manual/027). NULL = never. A session fires when it is closed
    // with a built, non-stale overview and (completed_fired_at IS NULL OR
    // completed_fired_at < last_segment_at): a straggler arrival after the
    // last fire re-arms it, a manual rebuild does not.
    completedFiredAt: timestamp('completed_fired_at', { withTimezone: true }),
    distanceM: doublePrecision('distance_m'),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    maxSpeedKph: doublePrecision('max_speed_kph'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('telemetry_sessions_device_started_idx').on(t.deviceId, t.startedAt),
    index('telemetry_sessions_device_ended_idx').on(t.deviceId, t.endedAt),
    index('telemetry_sessions_open_idx')
      .on(t.status, t.lastSegmentAt)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const telemetrySegments = pgTable(
  'telemetry_segments',
  {
    s3Key: text('s3_key').primaryKey(),
    sessionId: uuid('session_id')
      .references(() => telemetrySessions.id, { onDelete: 'cascade' })
      .notNull(),
    deviceId: uuid('device_id').notNull(),
    seq: integer('seq').notNull(),
    // First / last sample ts IN THE FILE (device clock), not the key's startTsMs.
    startTs: timestamp('start_ts', { withTimezone: true }).notNull(),
    endTs: timestamp('end_ts', { withTimezone: true }).notNull(),
    samples: integer('samples').notNull(),
    bytes: integer('bytes').notNull(),
    // Object metadata carries Content-Encoding: gzip (Q14 normalisation), so
    // every platform's fetch() inflates it natively. The manifest filters on it.
    normalized: boolean('normalized').default(false).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('telemetry_segments_session_seq_idx').on(t.sessionId, t.seq),
    index('telemetry_segments_session_start_idx').on(t.sessionId, t.startTs),
  ],
);

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
    // When the advisory close last emitted `media_session.ended` (xorgate-webhooks
    // P3, manual/030). Non-null at close time = a straggler reopened it: the
    // event says `reopened: true`.
    endedFiredAt: timestamp('ended_fired_at', { withTimezone: true }),
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
    // Free-form labels, org-scoped and normalized on write (see utils/tags.ts):
    // trimmed, lowercased, deduped, at most 20 of at most 32 chars each. A
    // consumer holding an organization API key discovers templates by tag, which
    // is what the GIN index below serves (`tags && ARRAY[...]`, ANY-of).
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
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
  (t) => [
    uniqueIndex('workflow_templates_org_slug_idx').on(t.organizationId, t.slug),
    index('workflow_templates_tags_idx').using('gin', t.tags),
  ],
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
    // The emitting node (engine >= 0.5.0 `nodeId`); null on older rows.
    // Migration 029 (xorgate-webhooks P2): joins the event to its output.event
    // node's `webhook` name.
    nodeId: text('node_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('workflow_events_run_idx').on(t.runId),
    index('workflow_events_device_occurred_idx').on(t.deviceId, t.occurredAt),
  ],
);

// --- Models (xorgate-models plan, M2): datasets, items, annotations, imports,
// versions, and the organization model registry. Design §4b. Status columns
// are text (not pgEnum) for the same aws-data-api reason as every other table.
// Keys under datasets/<datasetId>/ and org-models/<orgId>/ carry ids, not
// tenancy; the organization comes from the row (datasets.organization_id, or
// the dataset join for items, imports and versions).

// A labeled image collection. `classes` is the ordered class list
// [{ id, name, color }]: ids are stable so a rename never touches annotations;
// the order is the future `classNames` order of every version built from it.
export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    task: text('task').default('object_detection').notNull(),
    classes: jsonb('classes').default([]).notNull(),
    itemCount: integer('item_count').default(0).notNull(),
    labeledCount: integer('labeled_count').default(0).notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('datasets_org_slug_idx').on(t.organizationId, t.slug)],
);

// One image. `sha256` is unique per dataset (duplicates are reported at
// register time, never stored twice); `groupKey` drives the group-based split
// (a recording session minute); `status`: unlabeled | ai_labeled | labeled |
// excluded. Hard delete only while no version references the item; otherwise
// it flips to `excluded` and stays out of every later version.
export const datasetItems = pgTable(
  'dataset_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .references(() => datasets.id, { onDelete: 'cascade' })
      .notNull(),
    s3Key: text('s3_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    // { kind: upload | recording | run_capture, deviceId?, sessionId?, segmentSeq?, ts?, runId?, nodeId?, filename? }
    source: jsonb('source').default({}).notNull(),
    groupKey: text('group_key'),
    status: text('status').default('unlabeled').notNull(),
    labeledByUserId: text('labeled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    labeledAt: timestamp('labeled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('dataset_items_dataset_sha256_idx').on(t.datasetId, t.sha256),
    index('dataset_items_dataset_status_idx').on(t.datasetId, t.status),
  ],
);

// One box. The single internal representation is absolute xyxy in source
// pixels; the COCO writer converts to xywh at version time. `source`: human |
// model | import; `sourceRef` names the model ref or the import id.
export const datasetAnnotations = pgTable(
  'dataset_annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .references(() => datasetItems.id, { onDelete: 'cascade' })
      .notNull(),
    classId: text('class_id').notNull(),
    x1: doublePrecision('x1').notNull(),
    y1: doublePrecision('y1').notNull(),
    x2: doublePrecision('x2').notNull(),
    y2: doublePrecision('y2').notNull(),
    source: text('source').default('human').notNull(),
    sourceRef: text('source_ref'),
    confidence: doublePrecision('confidence'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('dataset_annotations_item_idx').on(t.itemId)],
);

// A recording-frame import job (design §4f). `status`: queued | running |
// succeeded | failed. `dispatchedAt` is the SQS dispatcher's atomic claim
// (same shape as workflow_runs); `progress` carries the resume cursor when the
// import chunks across invocations.
export const datasetImports = pgTable(
  'dataset_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .references(() => datasets.id, { onDelete: 'cascade' })
      .notNull(),
    kind: text('kind').default('recording').notNull(),
    params: jsonb('params').default({}).notNull(),
    status: text('status').default('queued').notNull(),
    progress: jsonb('progress').default({}).notNull(),
    itemsAdded: integer('items_added').default(0).notNull(),
    error: text('error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('dataset_imports_dataset_idx').on(t.datasetId)],
);

// A frozen, self-contained forge dataset v1 under datasets/<id>/versions/<n>/.
// `status`: building | ready | failed; immutable once ready. `classNames` is
// the frozen class order (COCO category id = index), `stats` per split and
// class, `health` the warnings the health check produced.
export const datasetVersions = pgTable(
  'dataset_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    datasetId: uuid('dataset_id')
      .references(() => datasets.id, { onDelete: 'cascade' })
      .notNull(),
    version: integer('version').notNull(),
    message: text('message'),
    splitConfig: jsonb('split_config').default({}).notNull(),
    classNames: jsonb('class_names').default([]).notNull(),
    stats: jsonb('stats'),
    health: jsonb('health'),
    s3Prefix: text('s3_prefix').notNull(),
    status: text('status').default('building').notNull(),
    error: text('error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('dataset_versions_dataset_version_idx').on(t.datasetId, t.version)],
);

// A training or assist job on SageMaker (xorgate-models M3, design §4b, §4d).
// Mirrors `workflow_runs`: the row is the authority, `dispatchedAt` is the
// dispatcher's atomic claim and `externalRef` is the SageMaker training-job
// name. The organization sits directly on the row (a dataset version has no
// workspace). `task`: train | autolabel. `status`: queued | dispatched |
// running | succeeded | failed | cancelled.
export const modelTrainingJobs = pgTable(
  'model_training_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    // Both nullable: a `train` job names a version, an `autolabel` job names
    // only the dataset. The dataset is kept on every row so a job survives in
    // the list view without a version join.
    datasetId: uuid('dataset_id').references(() => datasets.id, { onDelete: 'set null' }),
    datasetVersionId: uuid('dataset_version_id').references(() => datasetVersions.id, { onDelete: 'set null' }),
    task: text('task').default('train').notNull(),
    recipe: text('recipe').default('yolov8').notNull(),
    // { kind: pretrained | weights, ref?, path? } for train; null for autolabel.
    base: jsonb('base'),
    // The forge job spec v1 exactly as it was written to training/<id>/job/job.json.
    spec: jsonb('spec').default({}).notNull(),
    mode: text('mode'),
    target: text('target').default('cpu').notNull(),
    // { instanceType, spot, volumeSizeGb, maxMinutes, maxRuntimeSeconds }
    compute: jsonb('compute').default({}).notNull(),
    status: text('status').default('queued').notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    externalRef: text('external_ref'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    billableSeconds: integer('billable_seconds'),
    // The last progress line seen plus the phase, so a list row can show it.
    progress: jsonb('progress').default({}).notNull(),
    metrics: jsonb('metrics'),
    artifacts: jsonb('artifacts'),
    error: text('error'),
    outputModelId: uuid('output_model_id'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('model_training_jobs_org_status_idx').on(t.organizationId, t.status),
    uniqueIndex('model_training_jobs_external_ref_idx').on(t.externalRef),
  ],
);

// The organization's model registry rows: one per published
// org-models/<orgId>/<family>/<name>/<version>/. The source of truth for the
// picker and lineage; platform (first-party) models stay S3-listed and are not
// rows. `status`: ready | archived. `provenance`: { jobId, datasetVersionId,
// recipe, base, metrics, trainedAt } (filled by M3's finalizer).
export const orgModels = pgTable(
  'org_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    family: text('family').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    label: text('label'),
    manifest: jsonb('manifest').notNull(),
    s3Prefix: text('s3_prefix').notNull(),
    status: text('status').default('ready').notNull(),
    provenance: jsonb('provenance'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('org_models_org_family_name_version_idx').on(t.organizationId, t.family, t.name, t.version),
    index('org_models_org_family_idx').on(t.organizationId, t.family),
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
export type DeviceSimulation = InferSelectModel<typeof deviceSimulations>;
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
export type TelemetrySession = InferSelectModel<typeof telemetrySessions>;
export type NewTelemetrySession = InferInsertModel<typeof telemetrySessions>;
export type TelemetrySegment = InferSelectModel<typeof telemetrySegments>;
export type NewTelemetrySegment = InferInsertModel<typeof telemetrySegments>;
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
export type Dataset = InferSelectModel<typeof datasets>;
export type NewDataset = InferInsertModel<typeof datasets>;
export type DatasetItem = InferSelectModel<typeof datasetItems>;
export type NewDatasetItem = InferInsertModel<typeof datasetItems>;
export type DatasetAnnotation = InferSelectModel<typeof datasetAnnotations>;
export type NewDatasetAnnotation = InferInsertModel<typeof datasetAnnotations>;
export type DatasetImport = InferSelectModel<typeof datasetImports>;
export type NewDatasetImport = InferInsertModel<typeof datasetImports>;
export type DatasetVersion = InferSelectModel<typeof datasetVersions>;
export type NewDatasetVersion = InferInsertModel<typeof datasetVersions>;
export type OrgModel = InferSelectModel<typeof orgModels>;
export type NewOrgModel = InferInsertModel<typeof orgModels>;
export type ModelTrainingJob = InferSelectModel<typeof modelTrainingJobs>;
export type NewModelTrainingJob = InferInsertModel<typeof modelTrainingJobs>;

// ---------------------------------------------------------------------------
// Tombstones (manual/020). Deletes are real — no `deleted_at` on the live
// tables, and the FK graph cascades — but three facts have to outlive the rows
// they describe:
//
// - A deleted user's Cognito ID token verifies until it expires, and
//   `authenticateJwt` provisions a `users` row on first sight of an unknown
//   sub. Without this record a closed account would re-create itself on its
//   next request. Subs are never reused, so the row is permanent, and it holds
//   nothing personal: the opaque sub and when it was closed.
// - A deleted organization is the audit trail a consumer (Alocate) needs to
//   reconcile its own records against, and the place a support question about
//   "where did our data go" lands.
// - A deleted device may leave S3 objects behind when its prefixes were too
//   large to drain inside one request; `s3Drained=false` marks those. The
//   bucket lifecycle expires them regardless, so this is a bookkeeping flag,
//   not a work queue.
// ---------------------------------------------------------------------------

export const deletedUsers = pgTable('deleted_users', {
  /** The Cognito sub that used to be `users.id`. */
  id: text('id').primaryKey(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
});

export const deletedOrganizations = pgTable('deleted_organizations', {
  /** The former `organizations.id`. */
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull(),
  workspaceCount: integer('workspace_count').default(0).notNull(),
  deviceCount: integer('device_count').default(0).notNull(),
  /** The owner who asked. Not an FK: they may delete their own account next. */
  deletedBy: text('deleted_by').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
});

export const deletedDevices = pgTable('deleted_devices', {
  /** The former `devices.id`, which is also the IoT thing name and the KVS channel prefix. */
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  serial: text('serial'),
  /** False when the S3 prefixes still held objects after the request's budget; the lifecycle finishes. */
  s3Drained: boolean('s3_drained').default(true).notNull(),
  /** User id or API key id, whichever principal asked. */
  deletedBy: text('deleted_by').notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- Device data purge (plans/device-wf-data-delete, drizzle/manual/031) ---
//
// One row per purge request: the audit record and the resumable job state. The
// queue worker (services/device-purge.ts) claims a row by taking `lease_until`,
// persists `cursor` + `counts` after every chunk and re-enqueues itself when the
// Lambda budget runs low, so a duplicate SQS delivery resumes from the row
// rather than starting over. `status`: queued | running | succeeded | failed.
//
// `device_id` cascades on purpose (a deleted device's tombstone is its record);
// the tenancy ids carry no FK, exactly as `deleted_devices`.
export const devicePurges = pgTable(
  'device_purges',
  {
    // uuidv7 minted in app code (utils/uuidv7.ts): sorts by request time.
    id: uuid('id').primaryKey(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    // Subset of 'workflows' | 'telemetry' | 'media' (services/device-purge-rules.ts).
    scopes: text('scopes').array().notNull(),
    status: text('status').default('queued').notNull(),
    // Everything older than this goes; what the device uploads after it stays.
    cutoff: timestamp('cutoff', { withTimezone: true }).notNull(),
    cursor: jsonb('cursor'),
    counts: jsonb('counts').default({}).notNull(),
    error: text('error'),
    /** User id or API key id, whichever principal asked (like deleted_devices.deleted_by). */
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Worker lease: a row whose lease is in the past is claimable again.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
  },
  (t) => [index('device_purges_device_requested_idx').on(t.deviceId, t.requestedAt)],
);

// --- Device simulations (plans/xorgate-device-simulator, drizzle/manual/032) ---
//
// 1:1 with a `simulated` device: what the sim host should do with it (desired)
// and what the host last said it is doing (reported). The host polls
// `GET /sim-hosts/desired` and writes the `host_*` columns through
// `POST /sim-hosts/heartbeat`; the console reads them through
// `GET /device-simulations/{id}`.
//
// `desired_state` is a level ('running' | 'stopped'), but powering a sim back on
// after the DEVICE parked itself (`power_off`) is an EDGE: a level "running"
// alone would undo every power_off within one host pass. `start_requested_at`
// is that edge — `POST /device-simulations/{id}/start` stamps it and the host
// powers a parked sim on only when it is newer than the park (README Q8).
//
// `scenario_id` is the scenario the sim was CREATED with (the first-boot
// default the host hands the container); the live choice is the device's
// `simulation` config namespace. The provision bundle is not here: it lives in
// Secrets Manager `xorgate/sim-devices/<deviceId>`, deleted by device teardown.
export const deviceSimulations = pgTable('device_simulations', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  scenarioId: text('scenario_id').notNull(),
  desiredState: text('desired_state').default('running').notNull(),
  startRequestedAt: timestamp('start_requested_at', { withTimezone: true }),
  // Reported by the sim host. host_state: pending | starting | running | stopped | error.
  hostId: text('host_id'),
  hostState: text('host_state').default('pending').notNull(),
  hostMessage: text('host_message'),
  hostReportedAt: timestamp('host_reported_at', { withTimezone: true }),
  /** User id or API key id, whichever principal created it (like deleted_devices.deleted_by). */
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- Device transfer (plans/transfer-device-ownership) ---

// The audit trail for a tenancy change, and the state machine that makes one
// survivable. A transfer writes three facts that must agree — `devices.workspace_id`,
// the IoT thing's `xgOrgId`/`xgWorkspaceId` attributes, and the `scope` block in the
// retained config message — and the row exists because those three writes cannot be
// one transaction. It records which of them landed, so an interrupted transfer is a
// visible state rather than a device nobody can explain (README §2.5).
//
// Three jobs, in the order they matter:
//   1. the mid-transfer guard — a `pending` row blocks a second transfer of the
//      same device, and a stale one is swept and REPAIRED rather than just cleared
//      (`reconcileStaleTransfers`, services/device-transfer.ts);
//   2. the audit trail — who moved what, when, and out of/into which tenancy;
//   3. what the sweep did — the workflow attachments a cross-org move detached are
//      recorded here because the templates they pointed at belong to an
//      organization that can no longer see this device.
//
// Tenancy ids carry NO foreign keys, deliberately, exactly as `deleted_devices`
// does: a transfer record has to outlive the deletion of either workspace, or the
// history of where a device has been disappears the first time someone tidies up.
// `device_id` is `set null` for the same reason it is on `device_registrations` —
// the record of the move outlives the device.
export const deviceTransfers = pgTable(
  'device_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    fromWorkspaceId: uuid('from_workspace_id').notNull(),
    toWorkspaceId: uuid('to_workspace_id').notNull(),
    fromOrganizationId: uuid('from_organization_id').notNull(),
    toOrganizationId: uuid('to_organization_id').notNull(),
    // Exactly one, mirroring `device_registrations`: an API-key caller has no
    // `users` row to point at, so attribution moves to the key.
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorApiKeyId: uuid('actor_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    // The offer this transfer came from, when it was a cross-org handshake.
    // NULL for a same-org move and for the both-membership fast path.
    offerId: uuid('offer_id'),
    // pending | completed | failed. `pending` is only ever in flight for the
    // couple of seconds the sequence takes; anything older is an interrupted
    // transfer (text, not pgEnum — the aws-data-api enum-cast issue, same as
    // devices.status).
    status: text('status').default('pending').notNull(),
    // Which step of the ordered sequence this row reached: db | publish |
    // attributes | swept. On a `completed` row it is the last step that landed;
    // on a `failed` row it names the step that failed.
    stage: text('stage').default('db').notNull(),
    // 'unchanged' | 'written' | 'failed' from `ensureThingScopeAttributes`.
    // 'failed' is the one degraded-success state: the device was told its new
    // topic but the broker was never told to allow it, so it falls back to the
    // legacy telemetry plane until a config save re-asserts the attributes.
    scopeAttributes: text('scope_attributes'),
    // Template names detached by the cross-org sweep, for the audit trail and
    // for the confirmation the operator already saw in the preview.
    detachedWorkflowAttachments: jsonb('detached_workflow_attachments')
      .$type<string[]>()
      .default([])
      .notNull(),
    warnings: jsonb('warnings').$type<string[]>().default([]).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('device_transfers_device_idx').on(t.deviceId, t.createdAt),
    // The mid-transfer guard scans this.
    index('device_transfers_pending_idx')
      .on(t.deviceId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

// A cross-organization handover, offered by the source and accepted by the
// destination (README §2.4, Q1). It exists because `auth.organizationId` resolves
// to exactly ONE organization, so no single request can be authorized in both
// tenancies — the destination has to act for itself.
//
// Modelled directly on `device_registrations`: a `generateRegistrationCode()`
// code, a `pending | accepted | declined | cancelled | expired` status, an
// `expires_at` enforced on read AND on accept, and the same
// exactly-one-of-user-or-key attribution. The code is a bearer token for one
// thing only — reading the offer's allowlisted preview and acting on it — so the
// preview deliberately exposes device name, model and source organization and
// nothing else.
export const deviceTransferOffers = pgTable(
  'device_transfer_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    // CASCADE, unlike `device_transfers.device_id`: an offer is a live claim on a
    // device, and a deleted device must not leave a claimable code behind.
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    fromOrganizationId: uuid('from_organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    fromWorkspaceId: uuid('from_workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    status: text('status').default('pending').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => apiKeys.id, {
      onDelete: 'set null',
    }),
    // Set on accept. No FK: the destination organization is a different tenant
    // and the offer is history once it resolves.
    acceptedByOrganizationId: uuid('accepted_by_organization_id'),
    acceptedWorkspaceId: uuid('accepted_workspace_id'),
    // Whoever resolved it — accepted, declined or cancelled.
    resolvedByUserId: text('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    // The transfer this offer produced, when it was accepted.
    transferId: uuid('transfer_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_transfer_offers_code_idx').on(t.code),
    // One live offer per device: a second create returns the existing one rather
    // than minting a duplicate, the same idempotency `device_registrations` uses.
    uniqueIndex('device_transfer_offers_pending_device_idx')
      .on(t.deviceId)
      .where(sql`${t.status} = 'pending'`),
    index('device_transfer_offers_from_org_status_idx').on(t.fromOrganizationId, t.status),
  ],
);

// --- Webhooks (plans/xorgate-webhooks, migration drizzle/manual/028) --------
//
// The endpoint registry (URL + a Secrets Manager secret, no routing of its
// own), device-side routing, the outbox and the delivery log. Workflow events
// are routed by the output.event node's `webhook` name, resolved to an
// endpoint at finalize and stamped on the outbox row as `endpointId`.

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    // The handle templates and the device picker reference, unique per org.
    name: text('name').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    // The secret itself lives in Secrets Manager under
    // xorgate/orgs/<orgId>/webhooks/<id>; a rotation bumps this, which is what
    // invalidates the deliver Lambda's process cache.
    secretVersion: integer('secret_version').default(1).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'), // manual | gone | failing (auto-disable, deliver.ts)
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('webhook_endpoints_org_name_idx').on(t.organizationId, t.name),
    index('webhook_endpoints_org_enabled_idx').on(t.organizationId).where(sql`${t.enabled}`),
  ],
);

export const webhookRoutes = pgTable(
  'webhook_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    // Null is reserved for a workspace-wide default route (README Q9, not v1).
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' })
      .notNull(),
    // Subset of the device-routable types (services/webhooks/catalog.ts).
    // Written through textArrayParam: the Data API has no array binding.
    eventTypes: text('event_types').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('webhook_routes_device_endpoint_idx').on(t.deviceId, t.endpointId)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    // uuidv7 minted in app code (utils/uuidv7.ts): time-ordered, and the
    // envelope `id` / `webhook-id` consumers dedupe on.
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' })
      .notNull(),
    workspaceId: uuid('workspace_id'),
    type: text('type').notNull(),
    // Set for node-routed events (workflow.event) and ping; null = resolve
    // through webhook_routes by data.deviceId.
    endpointId: uuid('endpoint_id').references(() => webhookEndpoints.id, { onDelete: 'set null' }),
    dedupeKey: text('dedupe_key').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Set once the fan-out message is on the queue; null = the tick re-enqueues.
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('webhook_events_dedupe_key_idx').on(t.dedupeKey),
    index('webhook_events_undispatched_idx').on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .references(() => webhookEvents.id, { onDelete: 'cascade' })
      .notNull(),
    endpointId: uuid('endpoint_id')
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' })
      .notNull(),
    // A manual redelivery is a new row pointing at the delivery it repeats.
    redeliveryOf: uuid('redelivery_of'),
    status: text('status').default('pending').notNull(), // pending | delivered | failed | exhausted
    // Attempts made so far; the deliver Lambda claims attempt n+1 on `attempt = n`.
    attempt: integer('attempt').default(0).notNull(),
    // When the next attempt is due, or the lease of one in flight (the tick
    // re-enqueues pending rows whose value has passed).
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    responseStatus: integer('response_status'),
    responseMs: integer('response_ms'),
    responseExcerpt: text('response_excerpt'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_event_endpoint_idx')
      .on(t.eventId, t.endpointId)
      .where(sql`${t.redeliveryOf} is null`),
    index('webhook_deliveries_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt.desc()),
  ],
);

export type WebhookEndpoint = InferSelectModel<typeof webhookEndpoints>;
export type WebhookRoute = InferSelectModel<typeof webhookRoutes>;
export type WebhookEvent = InferSelectModel<typeof webhookEvents>;
export type WebhookDelivery = InferSelectModel<typeof webhookDeliveries>;
