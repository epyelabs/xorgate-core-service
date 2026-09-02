import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireAuth,
  requireOrgWideContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import type { Organization } from '../db/schema';
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
import { routeKey } from '../utils/route';
import { decodeImageUpload, deleteImage, putOrganizationLogo } from '../services/images';
import { devicesInWorkspaces, teardownDevices } from '../services/device-teardown';
import { revokeLiveAccessForUser } from '../services/live-access';
import { CREDENTIAL_PROVIDERS, orgSecretName } from '../workflows/org-credentials';
import {
  DeleteSecretCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { organizationView, organizationViews } from '../services/entity-views';

/**
 * Organizations, plus the `{id}/logo` pair.
 *
 * The logo is stored exactly the way a profile picture is (`PUT /me/avatar`):
 * bytes arrive as base64, the declared type is checked against them, the object
 * lands in the private core bucket and the row holds only its key. Responses
 * carry a presigned GET, never the key. It is gated at owner/admin like every
 * other organization edit.
 */

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
 * PUT /organizations/{id}/logo — replace the logo. Same order of operations as
 * the profile-picture route: validate the bytes, write the new object, point
 * the row at it, and only then drop the old one, so a failed write never
 * leaves the organization with no logo.
 */
async function putLogo(
  event: APIGatewayProxyEventV2,
  org: Organization,
): Promise<APIGatewayProxyResultV2> {
  const body = parseLogoBody(event);
  if (!body) return badRequest('contentType and base64 data are required');
  const upload = decodeImageUpload(body);
  if (!upload.ok) return badRequest(upload.message);

  const key = await putOrganizationLogo(org.id, upload.contentType, upload.bytes);
  const [updated] = await db
    .update(schema.organizations)
    .set({ logoKey: key, updatedAt: new Date() })
    .where(eq(schema.organizations.id, org.id))
    .returning();
  if (org.logoKey) await deleteImage(org.logoKey);

  return ok({ organization: await organizationView(updated) });
}

/** DELETE /organizations/{id}/logo — back to initials. Idempotent. */
async function deleteLogo(
  org: Organization,
): Promise<APIGatewayProxyResultV2> {
  if (!org.logoKey) return ok({ organization: await organizationView(org) });
  const [updated] = await db
    .update(schema.organizations)
    .set({ logoKey: null, updatedAt: new Date() })
    .where(eq(schema.organizations.id, org.id))
    .returning();
  await deleteImage(org.logoKey);
  return ok({ organization: await organizationView(updated) });
}

const secrets = new SecretsManagerClient({});

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  // POST without id = bootstrap a new org (no active-org required).
  // Other routes require an active org context.
  if (method === 'POST' && !id) {
    let auth;
    try {
      auth = await requireAuth(event);
    } catch (err) {
      if (err instanceof AuthError) return authErrorResponse(err);
      throw err;
    }

    let body: { name?: string; slug?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return badRequest('Invalid JSON body');
    }

    const name = body.name?.trim();
    const slug = body.slug?.trim();
    if (!name || !slug) return badRequest('name and slug are required');

    const [org] = await db
      .insert(schema.organizations)
      .values({ name, slug })
      .returning();

    await db
      .insert(schema.memberships)
      .values({ userId: auth.userId, organizationId: org.id, role: 'owner' });

    return created({ organization: await organizationView(org) });
  }

  // GET /organizations without id = list orgs the caller is a member of.
  if (method === 'GET' && !id) {
    let auth;
    try {
      auth = await requireAuth(event);
    } catch (err) {
      if (err instanceof AuthError) return authErrorResponse(err);
      throw err;
    }

    // Standardized list dialect (utils/list-params). The membership rows ARE
    // the total: no count query needed.
    const parsed = parseListParams(event, {
      sortable: ['createdAt', 'name'],
      defaultSort: 'createdAt',
    });
    if ('error' in parsed) return parsed.error;
    const { limit, offset, order, sortBy } = parsed;

    const userMemberships = await db.query.memberships.findMany({
      where: eq(schema.memberships.userId, auth.userId),
    });
    if (userMemberships.length === 0) {
      return ok({ organizations: [], page: pageMeta(parsed, 0) });
    }

    const sortCol =
      sortBy === 'name' ? schema.organizations.name : schema.organizations.createdAt;
    const orgs = await db.query.organizations.findMany({
      where: inArray(
        schema.organizations.id,
        userMemberships.map((m) => m.organizationId),
      ),
      orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
      limit,
      offset,
    });

    return ok({
      organizations: await organizationViews(orgs),
      page: pageMeta(parsed, userMemberships.length),
    });
  }

  // Everything else requires an active org context with appropriate role.
  //
  // Org-WIDE: an organization is above the workspace boundary in every
  // direction, so a workspace-scoped session token is refused here (403
  // `WORKSPACE_SCOPED`) regardless of the role it carries. The collection
  // operations above are stricter still — user-only, via `requireAuth`.
  let auth;
  try {
    const writeMethod = method === 'PUT' || method === 'DELETE';
    auth = await requireOrgWideContext(
      event,
      writeMethod ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  // The `{id}/logo` pair shares the gate above — a logo IS an organization
  // edit — but not the `switch (method)` below, which reads a bare `PUT` as a
  // name/slug update.
  const route = routeKey(event);
  if (route === 'PUT /organizations/{id}/logo' || route === 'DELETE /organizations/{id}/logo') {
    if (id !== auth.organizationId) return forbidden('Cannot edit other organizations');
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, id!),
    });
    if (!org) return notFound(`Organization "${id}" not found`);
    return method === 'PUT' ? putLogo(event, org) : deleteLogo(org);
  }

  switch (method) {
    case 'GET': {
      if (id !== auth.organizationId) {
        return notFound(`Organization "${id}" not found`);
      }
      const org = await db.query.organizations.findFirst({
        where: eq(schema.organizations.id, id),
      });
      if (!org) return notFound(`Organization "${id}" not found`);
      return ok({ organization: await organizationView(org) });
    }
    case 'PUT': {
      if (id !== auth.organizationId) return forbidden('Cannot edit other organizations');
      let body: { name?: string; slug?: string };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.slug !== undefined) updates.slug = body.slug;
      if (Object.keys(updates).length === 0) return badRequest('No updatable fields provided');
      updates.updatedAt = new Date();

      const [updated] = await db
        .update(schema.organizations)
        .set(updates)
        .where(eq(schema.organizations.id, id!))
        .returning();
      if (!updated) return notFound(`Organization "${id}" not found`);
      return ok({ organization: await organizationView(updated) });
    }
    case 'DELETE': {
      if (id !== auth.organizationId) return forbidden('Cannot delete other organizations');
      if (auth.membershipRole !== 'owner') {
        return forbidden('Only owners can delete an organization');
      }
      return destroyOrganization(id, auth.userId ?? auth.apiKeyId ?? 'unknown');
    }
    default:
      return methodNotAllowed(method, 'GET, POST, PUT, DELETE');
  }
};

/**
 * The whole organization. Order matters, and every step before the row delete
 * needs identifiers that the cascade takes with it:
 *
 *  1. every device in every workspace — IoT thing, KVS channels, S3 prefixes,
 *     FK-less telemetry rows (services/device-teardown.ts);
 *  2. the organization's connector secrets in Secrets Manager, force-deleted
 *     so the same names can be recreated (the pattern organization-credentials
 *     already uses);
 *  3. the organization and workspace logos;
 *  4. the tombstone, in the same transaction as the row delete; the cascade
 *     then removes workspaces, devices, API keys, session tokens, memberships,
 *     workflow templates, registrations;
 *  5. live-plane revocation for members whose ONLY membership this was — the
 *     browser IoT policy hangs off the Cognito identity, not the membership,
 *     so nothing else would ever detach it (same rule as DELETE /memberships).
 *
 * The AWS steps are best-effort and logged; the row delete is the fact.
 */
async function destroyOrganization(
  organizationId: string,
  deletedBy: string,
): Promise<APIGatewayProxyResultV2> {
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, organizationId),
  });
  if (!org) return notFound(`Organization "${organizationId}" not found`);

  const workspaces = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true, logoKey: true },
  });
  const members = await db.query.memberships.findMany({
    where: eq(schema.memberships.organizationId, organizationId),
    columns: { userId: true },
  });

  const devices = await devicesInWorkspaces(
    workspaces.map((w) => w.id),
    organizationId,
  );
  const teardown = await teardownDevices(devices, deletedBy);
  if (teardown.errors.length) {
    console.warn(
      `[organizations] delete ${organizationId}: ${teardown.errors.length} device teardown error(s)`,
    );
  }

  for (const provider of CREDENTIAL_PROVIDERS) {
    try {
      await secrets.send(
        new DeleteSecretCommand({
          SecretId: orgSecretName(organizationId, provider),
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        console.warn(`[organizations] delete secret ${provider} failed`, err);
      }
    }
  }

  if (org.logoKey) await deleteImage(org.logoKey);
  for (const w of workspaces) if (w.logoKey) await deleteImage(w.logoKey);

  await db.transaction(async (tx) => {
    // Sequential: the Data API driver cannot run concurrent statements in one transaction.
    await tx
      .insert(schema.deletedOrganizations)
      .values({
        id: organizationId,
        slug: org.slug,
        workspaceCount: workspaces.length,
        deviceCount: devices.length,
        deletedBy,
      })
      .onConflictDoNothing();
    await tx.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
  });

  for (const { userId } of members) {
    const remaining = await db.query.memberships.findFirst({
      where: eq(schema.memberships.userId, userId),
      columns: { id: true },
    });
    if (remaining) continue;
    try {
      await revokeLiveAccessForUser(userId);
    } catch (err) {
      console.error(`[organizations] live-access revoke failed for ${userId}`, err);
    }
  }

  return { statusCode: 204, body: '' };
}

export const handler = apiHandler(restHandler);
