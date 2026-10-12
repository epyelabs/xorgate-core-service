import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import type { MembershipRole, OrgAuthContext } from '../types/index';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { publishDeviceCommand, type DeviceCommandName } from '../services/device-command';
import { accepted, errorResponse, notFound, ok } from '../utils/responses';
import { uuidv7 } from '../utils/uuidv7';

/**
 * `/devices/{id}/sms-reads` (plans/device-sms-inbox, Phase 2; the wire shapes
 * are binding in plans/device-sms-inbox/contract.md §4) and
 * `/devices/{id}/sms/clear` (plans/device-sms-clear, contract.md §4). Served
 * from the device-commands Lambda, which already holds the command-publish
 * grant.
 *
 *   POST .../sms-reads           202 + a pending read row; publishes `read_sms`
 *   POST .../sms/clear           202 + a pending clear row; publishes `clear_sms`
 *   GET  .../sms-reads/latest    the device's stored `ok` row (works offline)
 *   GET  .../sms-reads/{readId}  the row; the web polls it while `pending`
 *
 * A clear is a `device_sms_reads` row with `action = 'clear'`: same polling,
 * same reply payload (the device's post-clear sweep), same retention. So an
 * `ok` clear becomes what `/latest` serves until the next read.
 *
 * Gates: reads take ANY org member, viewer included (owner decision, inbox
 * README §9 Q1): a read-only action on the device. A clear is destructive and
 * irreversible, so owner/admin only (device-sms-clear README, decision 1).
 * Devices outside the caller's workspace scope are a 404, never a 403.
 *
 * The device's reply lands through the IoT rule on `xorgate/devices/+/sms`
 * (handlers/device-sms-result.ts), which also does the retention cleanup. No
 * statement here deletes anything.
 *
 * PRIVACY: `result` carries message text and sender numbers. Never log it.
 */

export const SMS_READ_DEFAULT_LIMIT = 10;
export const SMS_READ_MAX_LIMIT = 50;
/** A `pending` row older than this is reported (and stored) as `expired`. */
export const SMS_READ_TIMEOUT_MS = 45_000;
/** The capability string the agent advertises in `effective.agent.capabilities`. */
export const SMS_READ_CAPABILITY = 'sms.read';
/** Advertised next to `sms.read` by agents that can delete the stores (device-sms-clear contract §3). */
export const SMS_CLEAR_CAPABILITY = 'sms.clear';

export type SmsAction = 'read' | 'clear';

/** What differs between the read POST and the clear POST; everything else is shared. */
const SMS_ACTIONS: Record<
  SmsAction,
  {
    command: DeviceCommandName;
    capability: string;
    /** Roles for requireOrgContext; undefined = any org member. */
    roles: MembershipRole[] | undefined;
    offlineHint: string;
    unsupported: string;
  }
> = {
  read: {
    command: 'read_sms',
    capability: SMS_READ_CAPABILITY,
    roles: undefined,
    offlineHint: 'It must be online to read its messages; GET .../sms-reads/latest serves the last read.',
    unsupported: 'This device\'s agent cannot read SMS. Update the device agent to read messages.',
  },
  clear: {
    command: 'clear_sms',
    capability: SMS_CLEAR_CAPABILITY,
    roles: ['owner', 'admin'],
    offlineHint: 'It must be online to clear its messages.',
    unsupported: 'This device\'s agent cannot clear SMS. Update the device agent to clear messages.',
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SmsReadRow = typeof schema.deviceSmsReads.$inferSelect;

/** The public `SmsRead` (contract §4): camelCase, no tenancy ids. */
export function smsReadView(row: SmsReadRow) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    status: row.status,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    limit: row.limit,
    action: row.action,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
    result: row.status === 'ok' ? (row.result ?? null) : null,
  };
}

/** True when the device's last config report advertises `sms.read` (contract §3). */
export function supportsSmsRead(reportedConfig: unknown): boolean {
  return hasAgentCapability(reportedConfig, SMS_READ_CAPABILITY);
}

/** True when `effective.agent.capabilities` is an array that includes `capability`. */
export function hasAgentCapability(reportedConfig: unknown, capability: string): boolean {
  if (!reportedConfig || typeof reportedConfig !== 'object') return false;
  const effective = (reportedConfig as { effective?: unknown }).effective;
  if (!effective || typeof effective !== 'object') return false;
  const agent = (effective as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object') return false;
  const capabilities = (agent as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) && capabilities.includes(capability);
}

/**
 * `{ limit? }` -> the clamped limit, or an error. Absent / null = the default;
 * any finite number is floored and clamped to 1..50; anything else is a 400.
 */
export function parseSmsReadLimit(rawBody: string | undefined | null): { limit: number } | { error: string } {
  if (rawBody === undefined || rawBody === null || rawBody.trim() === '') {
    return { limit: SMS_READ_DEFAULT_LIMIT };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { error: 'Invalid JSON body' };
  }
  if (body === null) return { limit: SMS_READ_DEFAULT_LIMIT };
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object' };
  const raw = (body as { limit?: unknown }).limit;
  if (raw === undefined || raw === null) return { limit: SMS_READ_DEFAULT_LIMIT };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { error: '`limit` must be a number between 1 and 50' };
  }
  return { limit: Math.min(SMS_READ_MAX_LIMIT, Math.max(1, Math.floor(raw))) };
}

export async function handleDeviceSmsReadRoutes(
  event: APIGatewayProxyEventV2,
  routeKey: string,
  deviceId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!deviceId) return notFound('Device "" not found');

  const isClear = routeKey === 'POST /devices/{id}/sms/clear';
  let auth: OrgAuthContext;
  try {
    // The role gate runs before any device lookup, like the other owner/admin
    // device commands: a member asking to clear is a 403 whatever the device.
    // The GETs take the read gate.
    auth = await requireOrgContext(event, SMS_ACTIONS[isClear ? 'clear' : 'read'].roles);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);
  const device = await db.query.devices.findFirst({
    where: and(eq(schema.devices.id, deviceId), inArray(schema.devices.workspaceId, orgWorkspaceIds)),
    columns: { id: true, name: true, serial: true, status: true, workspaceId: true, reportedConfig: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

  if (routeKey === 'POST /devices/{id}/sms-reads') return createRequest(event, auth, device, 'read');
  if (isClear) return createRequest(event, auth, device, 'clear');
  if (routeKey === 'GET /devices/{id}/sms-reads/latest') return latest(deviceId);
  if (routeKey === 'GET /devices/{id}/sms-reads/{readId}') {
    return getRead(deviceId, event.pathParameters?.readId);
  }
  return notFound('Route not found');
}

/** The read POST and the clear POST: one row, one command, one 202 (contract §4 of each plan). */
async function createRequest(
  event: APIGatewayProxyEventV2,
  auth: OrgAuthContext,
  device: {
    id: string;
    name: string | null;
    serial: string | null;
    status: string;
    workspaceId: string;
    reportedConfig: unknown;
  },
  action: SmsAction,
): Promise<APIGatewayProxyResultV2> {
  const spec = SMS_ACTIONS[action];
  const parsed = parseSmsReadLimit(event.body);
  if ('error' in parsed) return errorResponse(400, 'VALIDATION_ERROR', parsed.error);

  // Commands are not retained: an offline device would never see this one,
  // and the web would sit through the 45 s timeout. Same race as the other
  // commands (the device can drop off right after this check).
  if (device.status !== 'online') {
    return errorResponse(
      409,
      'DEVICE_OFFLINE',
      `Device "${device.name ?? device.serial ?? device.id}" is ${device.status}. ${spec.offlineHint}`,
    );
  }
  if (!hasAgentCapability(device.reportedConfig, spec.capability)) {
    return errorResponse(409, 'UNSUPPORTED_AGENT', spec.unsupported);
  }

  const now = new Date();
  const [row] = await db
    .insert(schema.deviceSmsReads)
    .values({
      id: uuidv7(now.getTime()),
      deviceId: device.id,
      workspaceId: device.workspaceId,
      organizationId: auth.organizationId,
      requestedBy: auth.userId ?? auth.apiKeyId ?? 'unknown',
      limit: parsed.limit,
      action,
      status: 'pending',
      createdAt: now,
    })
    .returning();

  try {
    await publishDeviceCommand(device.id, spec.command, {
      args: { limit: parsed.limit },
      requestId: row.id,
    });
  } catch (err) {
    console.error('[sms-read] command publish failed', { readId: row.id, deviceId: device.id, action, err });
    await db
      .update(schema.deviceSmsReads)
      .set({ status: 'error', errorCode: 'publish_failed', completedAt: new Date() })
      .where(eq(schema.deviceSmsReads.id, row.id));
    return errorResponse(
      502,
      'COMMAND_PUBLISH_FAILED',
      'Delivering the command to the device failed. Try again.',
      { readId: row.id },
    );
  }
  console.log('[sms-read] requested', { readId: row.id, deviceId: device.id, action, limit: parsed.limit });
  return accepted(smsReadView(row));
}

async function latest(deviceId: string): Promise<APIGatewayProxyResultV2> {
  const row = await db.query.deviceSmsReads.findFirst({
    where: and(eq(schema.deviceSmsReads.deviceId, deviceId), eq(schema.deviceSmsReads.status, 'ok')),
    orderBy: desc(schema.deviceSmsReads.completedAt),
  });
  if (!row) return errorResponse(404, 'NO_SMS_READ', 'This device\'s messages have not been read yet.');
  return ok(smsReadView(row));
}

async function getRead(deviceId: string, readId: string | undefined): Promise<APIGatewayProxyResultV2> {
  if (!readId || !UUID_RE.test(readId)) return notFound(`SMS read "${readId ?? ''}" not found`);
  const row = await db.query.deviceSmsReads.findFirst({
    where: and(eq(schema.deviceSmsReads.id, readId), eq(schema.deviceSmsReads.deviceId, deviceId)),
  });
  if (!row) return notFound(`SMS read "${readId}" not found`);

  if (row.status === 'pending' && Date.now() - new Date(row.createdAt).getTime() > SMS_READ_TIMEOUT_MS) {
    // Expire on read: no sweeper. Guarded on `pending` so a reply that landed
    // between the read above and this write wins; then the fresh row is served.
    const [expired] = await db
      .update(schema.deviceSmsReads)
      .set({ status: 'expired', errorCode: 'timeout', completedAt: new Date() })
      .where(and(eq(schema.deviceSmsReads.id, readId), eq(schema.deviceSmsReads.status, 'pending')))
      .returning();
    if (expired) return ok(smsReadView(expired));
    const fresh = await db.query.deviceSmsReads.findFirst({
      where: and(eq(schema.deviceSmsReads.id, readId), eq(schema.deviceSmsReads.deviceId, deviceId)),
    });
    if (!fresh) return notFound(`SMS read "${readId}" not found`);
    return ok(smsReadView(fresh));
  }
  return ok(smsReadView(row));
}
