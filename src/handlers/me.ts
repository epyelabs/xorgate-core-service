import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { AuthError, authErrorResponse, requireAuth } from '../middleware/auth';
import type { UserAuthContext } from '../types/index';
import { db, schema } from '../db/index';
import { routeKey } from '../utils/route';
import { badRequest, methodNotAllowed, ok } from '../utils/responses';
import { decodeImageUpload, deleteImage, imageUrl, putAvatar } from '../services/images';
import { organizationViews } from '../services/entity-views';
import { apiHandler } from '../utils/api-handler';

/**
 * The signed-in user's OWN profile. Every route here is scoped to the caller by
 * the token alone — there is no `{id}` to address someone else with, so no
 * `X-Organization-Id` and no role gate is involved. Editing another member is
 * the memberships handler's job, and it stops at their role.
 *
 * Cognito stays the credential store: passwords are changed by the browser
 * against Cognito directly and never pass through this API. The `users` row is
 * the PROFILE, so a name edited here is not written back to the Cognito `name`
 * attribute — that attribute seeds the row on first sight (middleware/auth.ts)
 * and has no reader afterwards.
 */

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
});

const avatarSchema = z.object({
  contentType: z.string(),
  /** Base64, no `data:` prefix — the browser strips it before sending. */
  data: z.string().min(1),
});

/**
 * The `user` block every route here answers with. Built from the auth context
 * rather than the row, which is why it carries no `created_at` — the same
 * omission `GET /me` has always had, and which the SDK's `User.createdAt`
 * documents as null for this endpoint.
 */
async function view(auth: UserAuthContext) {
  return {
    id: auth.userId,
    email: auth.email,
    name: auth.name,
    tier: auth.tier,
    role: auth.role,
    avatarUrl: await imageUrl(auth.avatarKey),
  };
}

function parseBody<T>(event: APIGatewayProxyEventV2, shape: z.ZodType<T>): T | null {
  try {
    const parsed = shape.safeParse(JSON.parse(event.body ?? '{}'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** GET /me — identity plus every organization the caller belongs to. */
async function getMe(auth: UserAuthContext): Promise<APIGatewayProxyResultV2> {
  const userMemberships = await db.query.memberships.findMany({
    where: eq(schema.memberships.userId, auth.userId),
  });

  const orgs = userMemberships.length
    ? await db.query.organizations.findMany({
        where: inArray(
          schema.organizations.id,
          userMemberships.map((m) => m.organizationId),
        ),
      })
    : [];

  return ok({
    user: await view(auth),
    memberships: userMemberships,
    // Through the same view the organizations handler uses, so the sidebar can
    // draw an organization's logo off this one bootstrap call rather than
    // fetching each organization separately.
    organizations: await organizationViews(orgs),
  });
}

/** PATCH /me — display name. `null` clears it back to the email fallback. */
async function updateMe(
  event: APIGatewayProxyEventV2,
  auth: UserAuthContext,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event, updateSchema);
  if (!body) return badRequest('name must be a string of 1-120 characters, or null');
  if (body.name === undefined) return badRequest('No updatable fields provided');

  const [updated] = await db
    .update(schema.users)
    .set({ name: body.name })
    .where(eq(schema.users.id, auth.userId))
    .returning();

  return ok({ user: await view({ ...auth, name: updated.name ?? null }) });
}

/**
 * PUT /me/avatar — replace the profile picture. The declared content type is
 * checked against the bytes themselves before anything is stored, and the
 * previous object is dropped only after the row points at the new one, so a
 * failed write never leaves the user with no picture.
 */
async function putMyAvatar(
  event: APIGatewayProxyEventV2,
  auth: UserAuthContext,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody(event, avatarSchema);
  if (!body) return badRequest('contentType and base64 data are required');
  const upload = decodeImageUpload(body);
  if (!upload.ok) return badRequest(upload.message);

  const key = await putAvatar(auth.userId, upload.contentType, upload.bytes);
  await db
    .update(schema.users)
    .set({ avatarKey: key })
    .where(eq(schema.users.id, auth.userId));
  if (auth.avatarKey) await deleteImage(auth.avatarKey);

  return ok({ user: await view({ ...auth, avatarKey: key }) });
}

/** DELETE /me/avatar — back to initials. */
async function deleteMyAvatar(auth: UserAuthContext): Promise<APIGatewayProxyResultV2> {
  if (auth.avatarKey) {
    await db
      .update(schema.users)
      .set({ avatarKey: null })
      .where(eq(schema.users.id, auth.userId));
    await deleteImage(auth.avatarKey);
  }
  return ok({ user: await view({ ...auth, avatarKey: null }) });
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  let auth: UserAuthContext;
  try {
    auth = await requireAuth(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  switch (routeKey(event)) {
    case 'GET /me':
      return getMe(auth);
    case 'PATCH /me':
      return updateMe(event, auth);
    case 'PUT /me/avatar':
      return putMyAvatar(event, auth);
    case 'DELETE /me/avatar':
      return deleteMyAvatar(auth);
    default:
      return methodNotAllowed(event.requestContext.http.method, 'GET, PATCH, PUT, DELETE');
  }
};

export const handler = apiHandler(restHandler);
