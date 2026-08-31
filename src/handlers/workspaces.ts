import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  assertOrgWideScope,
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import type { Workspace } from '../db/schema';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { decodeImageUpload, deleteImage, putWorkspaceLogo } from '../services/images';
import { workspaceView, workspaceViews } from '../services/entity-views';
import {
  badRequest,
  created,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { apiHandler } from '../utils/api-handler';
import { routeKey } from '../utils/route';

/** The shape both logo routes accept, mirroring `PUT /me/avatar`. */
interface LogoBody {
  contentType: string;
  /** Base64, no `data:` prefix — the browser strips it before sending. */
  data: string;
}

function parseLogoBody(event: APIGatewayProxyEventV2): LogoBody | null {
  try {
    const parsed = JSON.parse(event.body ?? '{}') as Partial<LogoBody>;
    if (typeof parsed.contentType !== 'string' || typeof parsed.data !== 'string') {
      return null;
    }
    if (parsed.data.length === 0) return null;
    return { contentType: parsed.contentType, data: parsed.data };
  } catch {
    return null;
  }
}

/**
 * PUT /workspaces/{id}/logo — replace the logo. Validate the bytes, write the
 * new object, point the row at it, and only then drop the old one, so a failed
 * write never leaves the workspace with no logo.
 */
async function putLogo(
  event: APIGatewayProxyEventV2,
  workspace: Workspace,
): Promise<APIGatewayProxyResultV2> {
  const body = parseLogoBody(event);
  if (!body) return badRequest('contentType and base64 data are required');
  const upload = decodeImageUpload(body);
  if (!upload.ok) return badRequest(upload.message);

  const key = await putWorkspaceLogo(workspace.id, upload.contentType, upload.bytes);
  const [updated] = await db
    .update(schema.workspaces)
    .set({ logoKey: key, updatedAt: new Date() })
    .where(eq(schema.workspaces.id, workspace.id))
    .returning();
  if (workspace.logoKey) await deleteImage(workspace.logoKey);

  return ok({ workspace: await workspaceView(updated) });
}

/** DELETE /workspaces/{id}/logo — back to initials. Idempotent. */
async function deleteLogo(workspace: Workspace): Promise<APIGatewayProxyResultV2> {
  if (!workspace.logoKey) return ok({ workspace: await workspaceView(workspace) });
  const [updated] = await db
    .update(schema.workspaces)
    .set({ logoKey: null, updatedAt: new Date() })
    .where(eq(schema.workspaces.id, workspace.id))
    .returning();
  await deleteImage(workspace.logoKey);
  return ok({ workspace: await workspaceView(updated) });
}

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
 *
 * The `{id}/logo` pair follows the WRITE rule, and is stored exactly the way a
 * profile picture is (`PUT /me/avatar`): base64 in the body, the declared type
 * checked against the bytes, the object private in the core bucket and only
 * its key on the row. Responses carry a presigned GET, never the key.
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

  // The `{id}/logo` pair is a workspace WRITE, so it is already covered by the
  // org-wide gate above; it just does not belong in the `switch (method)`
  // below, which reads a bare `PUT` as a name/slug/description update.
  const route = routeKey(event);
  if (route === 'PUT /workspaces/{id}/logo' || route === 'DELETE /workspaces/{id}/logo') {
    if (!id) return badRequest('workspace id required in path');
    const workspace = await db.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.id, id),
        eq(schema.workspaces.organizationId, auth.organizationId),
      ),
    });
    if (!workspace) return notFound(`Workspace "${id}" not found`);
    return method === 'PUT' ? putLogo(event, workspace) : deleteLogo(workspace);
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
        return ok({ workspace: await workspaceView(row) });
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
      return ok({ workspaces: await workspaceViews(rows), page: pageMeta(parsed, total) });
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
      return created({ workspace: await workspaceView(row) });
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
      return ok({ workspace: await workspaceView(updated[0]) });
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
