import {
  pgTable,
  text,
  uuid,
  jsonb,
  integer,
  numeric,
  timestamp,
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
    sensorCapabilities: jsonb('sensor_capabilities'),
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
    simIccid: text('sim_iccid'),
    status: text('status').default('provisioned').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastLatitude: numeric('last_latitude', { precision: 9, scale: 6 }),
    lastLongitude: numeric('last_longitude', { precision: 9, scale: 6 }),
    lastAccuracyM: integer('last_accuracy_m'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('devices_project_serial_idx').on(t.projectId, t.serial),
    index('devices_project_idx').on(t.projectId),
    index('devices_model_idx').on(t.deviceModelId),
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
