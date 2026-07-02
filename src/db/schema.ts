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
    firmwareVersion: text('firmware_version'),
    status: text('status').default('provisioned').notNull(),
    // Opt-in telemetry persistence. When false (default) the ingest Lambda streams
    // to IoT Core but writes nothing to telemetry_readings / device_latest.
    persistTelemetry: boolean('persist_telemetry').default(false).notNull(),
    // Opt-in automatic recording. When true the telemetry-ingest Lambda spawns a
    // cloud viewer-recorder (Fargate) whenever a media stream becomes active, and
    // stops it when the stream drops. Off by default.
    autoRecord: boolean('auto_record').default(false).notNull(),
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

// A cloud-side recording of one stream. A headless KVS viewer-recorder (Fargate)
// joins the device's existing signaling channel as an extra VIEWER, remuxes the
// incoming H.264 to a single MP4, and uploads it to S3 on stop. One row per run.
// `status` / `trigger` are text (not pgEnum) to dodge the aws-data-api enum-cast
// issue — same reasoning as devices.status.
export const recordings = pgTable(
  'recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    streamKey: text('stream_key').notNull(), // cam0 | cam1 | ...
    status: text('status').default('recording').notNull(), // recording | completed | failed
    trigger: text('trigger').default('manual').notNull(), // manual | auto
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    // Set by the recorder (via an IoT "capturing" signal) on its first received video
    // frame. NULL while the row is 'recording' but the recorder hasn't captured yet
    // (cold start) -> the UI shows "Starting…"; non-NULL -> "REC".
    captureStartedAt: timestamp('capture_started_at', { withTimezone: true }),
    s3Key: text('s3_key'), // media/v1/<deviceId>/<streamKey>/<recordingId>.mp4
    sizeBytes: integer('size_bytes'),
    durationMs: integer('duration_ms'),
    taskArn: text('task_arn'), // Fargate task ARN, for StopTask
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('recordings_device_stream_status_idx').on(t.deviceId, t.streamKey, t.status),
    index('recordings_device_created_idx').on(t.deviceId, t.createdAt),
  ],
);

// --- Workflows (user-defined processing pipelines) ---
// A workflow: a graph of nodes (CV / telemetry processors) that attaches to a
// device, fires on a trigger, and produces reviewable runs + events. `status`
// columns are text (not pgEnum) to dodge the aws-data-api enum-cast issue — same
// reasoning as devices.status / recordings.status. All graph/trigger/payload
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
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .notNull(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
    attachmentId: uuid('attachment_id').references(() => workflowAttachments.id, {
      onDelete: 'set null',
    }),
    templateId: uuid('template_id')
      .references(() => workflowTemplates.id, { onDelete: 'cascade' })
      .notNull(),
    templateVersion: integer('template_version').notNull(),
    definition: jsonb('definition').notNull(), // snapshot of the version that ran
    trigger: text('trigger').notNull(), // event | schedule | manual
    triggerContext: jsonb('trigger_context'),
    status: text('status').default('running').notNull(), // running | succeeded | failed
    executionMode: text('execution_mode').notNull(), // inline | fargate
    taskArn: text('task_arn'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    metrics: jsonb('metrics').default({}).notNull(),
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
export const workflowEvents = pgTable(
  'workflow_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .references(() => workflowRuns.id, { onDelete: 'cascade' })
      .notNull(),
    deviceId: uuid('device_id')
      .references(() => devices.id, { onDelete: 'cascade' })
      .notNull(),
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
export type ApiKey = InferSelectModel<typeof apiKeys>;
export type NewApiKey = InferInsertModel<typeof apiKeys>;
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
export type Recording = InferSelectModel<typeof recordings>;
export type NewRecording = InferInsertModel<typeof recordings>;
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
