import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { asc, desc, eq, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requirePrincipal,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  created,
  forbidden,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { apiHandler } from '../utils/api-handler';
import { ioCapabilitiesSchema } from '../schemas/capabilities';
import { publishDeviceConfig } from '../services/device-config';

/**
 * Versioned `ioCapabilities` documents are validated on write (cm4-support
 * plan): a v2 doc drives real device behavior (encoder templates, overlays,
 * LED pins) through the hardware block, so a typo'd enum must fail HERE, not
 * as a silently-degraded device. Unversioned/null docs stay accepted
 * unvalidated — legacy rows (and the odd freeform sketch) predate the schema.
 */
function invalidCapabilities(caps: unknown): string | null {
  if (caps === null || caps === undefined) return null;
  if (typeof caps !== 'object' || Array.isArray(caps)) {
    return 'ioCapabilities must be an object or null';
  }
  if (!('schemaVersion' in (caps as Record<string, unknown>))) return null;
  const parsed = ioCapabilitiesSchema.safeParse(caps);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? issue.path.join('.') : 'ioCapabilities';
  return `ioCapabilities invalid at ${path}: ${issue?.message ?? 'invalid'}`;
}

/**
 * A capability edit changes the hardware block every device on the model
 * receives, and the retained config topic is how it reaches them: bump each
 * device's config_rev and republish (the agent skips already-applied revs, so
 * this is what makes it re-read). Best-effort per device — the model update
 * has already committed, and the reported-rev self-heal republishes stragglers.
 */
async function republishModelDevices(modelId: string): Promise<void> {
  const rows = await db
    .update(schema.devices)
    .set({
      configRev: sql`${schema.devices.configRev} + 1`,
      configUpdatedAt: new Date(),
    })
    .where(eq(schema.devices.deviceModelId, modelId))
    .returning({
      id: schema.devices.id,
      config: schema.devices.config,
      configRev: schema.devices.configRev,
    });
  for (const row of rows) {
    try {
      await publishDeviceConfig(row.id, row.config, row.configRev);
    } catch (err) {
      console.error('model-edit config republish failed', {
        deviceId: row.id,
        modelId,
        rev: row.configRev,
        err,
      });
    }
  }
}

// device_models is a platform-wide catalog: any authenticated caller can read,
// including an API-key caller (`requirePrincipal`, not `requireAuth`) — the
// catalog is org-blind data a consumer legitimately needs before registering a
// device. Mutations require `users.role === 'admin'` (platform admin),
// regardless of org membership, and an API-key principal is always platform
// role `'user'`, so writes stay closed to keys with no extra check.
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    auth = await requirePrincipal(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const requirePlatformAdmin = (): APIGatewayProxyResultV2 | null =>
    auth.role === 'admin' ? null : forbidden('Platform admin role required');

  switch (method) {
    case 'GET': {
      if (id) {
        const row = await db.query.deviceModels.findFirst({
          where: eq(schema.deviceModels.id, id),
        });
        if (!row) return notFound(`Device model "${id}" not found`);
        return ok({ device_model: row });
      }
      // Standardized list dialect (utils/list-params). Default order preserves
      // the prior behaviour (newest first).
      const parsed = parseListParams(event, {
        sortable: ['createdAt', 'name'],
        defaultSort: 'createdAt',
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy } = parsed;

      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.deviceModels);
      const total = Number(totalRows[0]?.total ?? 0);

      const sortCol =
        sortBy === 'name' ? schema.deviceModels.name : schema.deviceModels.createdAt;
      const rows = await db.query.deviceModels.findMany({
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });
      return ok({ device_models: rows, page: pageMeta(parsed, total) });
    }
    case 'POST': {
      const denial = requirePlatformAdmin();
      if (denial) return denial;
      let body: {
        name?: string;
        sku?: string;
        ioCapabilities?: unknown;
        firmwareChannel?: string;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const name = body.name?.trim();
      const sku = body.sku?.trim();
      if (!name || !sku) return badRequest('name and sku are required');
      const capsError = invalidCapabilities(body.ioCapabilities);
      if (capsError) return badRequest(capsError);

      const [row] = await db
        .insert(schema.deviceModels)
        .values({
          name,
          sku,
          ioCapabilities: body.ioCapabilities ?? null,
          firmwareChannel: body.firmwareChannel ?? null,
        })
        .returning();
      return created({ device_model: row });
    }
    case 'PUT': {
      const denial = requirePlatformAdmin();
      if (denial) return denial;
      if (!id) return badRequest('device_model id required in path');
      let body: {
        name?: string;
        sku?: string;
        ioCapabilities?: unknown;
        firmwareChannel?: string;
      };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.sku !== undefined) updates.sku = body.sku;
      if (body.ioCapabilities !== undefined) {
        const capsError = invalidCapabilities(body.ioCapabilities);
        if (capsError) return badRequest(capsError);
        updates.ioCapabilities = body.ioCapabilities;
      }
      if (body.firmwareChannel !== undefined) updates.firmwareChannel = body.firmwareChannel;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      const updated = await db
        .update(schema.deviceModels)
        .set(updates)
        .where(eq(schema.deviceModels.id, id))
        .returning();
      if (updated.length === 0) return notFound(`Device model "${id}" not found`);
      // A capability edit must reach the model's devices (their hardware block
      // rides the retained config message) — no re-provision, no ssh.
      if (body.ioCapabilities !== undefined) await republishModelDevices(id);
      return ok({ device_model: updated[0] });
    }
    case 'DELETE': {
      const denial = requirePlatformAdmin();
      if (denial) return denial;
      if (!id) return badRequest('device_model id required in path');
      const deleted = await db
        .delete(schema.deviceModels)
        .where(eq(schema.deviceModels.id, id))
        .returning({ id: schema.deviceModels.id });
      if (deleted.length === 0) return notFound(`Device model "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

export const handler = apiHandler(restHandler);
