import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  assertOrgWideScope,
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import {
  badRequest,
  created,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { apiHandler } from '../utils/api-handler';

/**
 * Workspaces are the one resource that is BOTH sides of the boundary, which is
 * why this handler mixes the two gates rather than picking one:
 *
 * - **Reads** are scoped. A workspace-scoped session token lists exactly one
 *   workspace (its own) and reads any other as `404`, indistinguishable from a
 *   workspace in another organization. A consumer's browser legitimately needs
 *   the name of the tenant it is looking at.
 * - **Writes** are organization-wide. Creating, renaming or deleting a tenant is
 *   the consumer's BACKEND's job, done with the `xg_` key that mints tokens in
 *   the first place. A browser-held credential that could delete its own tenant
 *   is a liability with no matching use.
 */
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'PUT' || method === 'DELETE';
    auth = await requireOrgContext(
      event,
      writeMethod ? ['owner', 'admin', 'member'] : undefined,
    );
    if (writeMethod) assertOrgWideScope(auth);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  switch (method) {
    case 'GET': {
      // The same intersection every device handler applies, one level up: for an
      // org-scoped caller this is every workspace in the organization, and for a
      // workspace-scoped token it is the single row it is bound to.
      const visibleIds = await resolveWorkspaceScope(auth);
      if (id) {
        if (!visibleIds.includes(id)) return notFound(`Workspace "${id}" not found`);
        const row = await db.query.workspaces.findFirst({
          where: and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.organizationId, auth.organizationId),
          ),
        });
        if (!row) return notFound(`Workspace "${id}" not found`);
        return ok({ workspace: row });
      }

      // Standardized list dialect (utils/list-params). Default order preserves
      // the prior behaviour (most-recently-updated first).
      const parsed = parseListParams(event, {
        sortable: ['updatedAt', 'createdAt', 'name'],
        defaultSort: 'updatedAt',
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy } = parsed;
      if (visibleIds.length === 0) {
        return ok({ workspaces: [], page: pageMeta(parsed, 0) });
      }

      const where = and(
        eq(schema.workspaces.organizationId, auth.organizationId),
        inArray(schema.workspaces.id, visibleIds),
      );
      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.workspaces)
        .where(where);
      const total = Number(totalRows[0]?.total ?? 0);

      const sortCol =
        sortBy === 'createdAt'
          ? schema.workspaces.createdAt
          : sortBy === 'name'
            ? schema.workspaces.name
            : schema.workspaces.updatedAt;
      const rows = await db.query.workspaces.findMany({
        where,
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });
      return ok({ workspaces: rows, page: pageMeta(parsed, total) });
    }
    case 'POST': {
      let body: { name?: string; slug?: string; description?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const name = body.name?.trim();
      const slug = body.slug?.trim();
      if (!name || !slug) return badRequest('name and slug are required');

      const [row] = await db
        .insert(schema.workspaces)
        .values({
          organizationId: auth.organizationId,
          name,
          slug,
          description: body.description ?? null,
        })
        .returning();
      return created({ workspace: row });
    }
    case 'PUT': {
      if (!id) return badRequest('workspace id required in path');
      let body: { name?: string; slug?: string; description?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (body.description !== undefined) updates.description = body.description;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      const updated = await db
        .update(schema.workspaces)
        .set(updates)
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.organizationId, auth.organizationId),
          ),
        )
        .returning();
      if (updated.length === 0) return notFound(`Workspace "${id}" not found`);
      return ok({ workspace: updated[0] });
    }
    case 'DELETE': {
      if (!id) return badRequest('workspace id required in path');
      const deleted = await db
        .delete(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, id),
            eq(schema.workspaces.organizationId, auth.organizationId),
          ),
        )
        .returning({ id: schema.workspaces.id });
      if (deleted.length === 0) return notFound(`Workspace "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

export const handler = apiHandler(restHandler);
