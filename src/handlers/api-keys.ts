import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgWideContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { API_KEY_PREFIX, apiKeyPrefix, hashApiKey } from '../services/api-key-auth';
import type { MembershipRole } from '../types/index';
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

const VALID_SCOPES = ['edge', 'cloud', 'client'] as const;

/**
 * Roles a key may be minted with, most privileged first. A key acts with this
 * role wherever `requireOrgContext` runs, so the existing role gates apply to it
 * unchanged: `member` (the default) writes devices, workspaces and device
 * registrations but cannot touch memberships, API keys or organization settings.
 */
const KEY_ROLES: readonly MembershipRole[] = ['owner', 'admin', 'member', 'viewer'];
const DEFAULT_KEY_ROLE: MembershipRole = 'member';

/**
 * A caller may not mint a key more privileged than they are themselves.
 * Minting is already gated to owner|admin, so without this an `admin` could mint
 * an `owner` key and then use it to delete the organization. Same shape as the
 * membership role ladder, expressed as a rank so the comparison is one `<=`.
 */
const ROLE_RANK: Record<MembershipRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

// Prefix and hash both come from the verification module rather than being
// restated here: two copies of the hash function is exactly the drift that would
// mint keys nothing can verify, silently.
function generatePlaintextKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'DELETE';
    auth = await requireOrgWideContext(
      event,
      writeMethod ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  switch (method) {
    case 'GET': {
      // Standardized list dialect (utils/list-params). Default order preserves
      // the prior behaviour (newest first).
      const parsed = parseListParams(event, {
        sortable: ['createdAt', 'name'],
        defaultSort: 'createdAt',
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy } = parsed;

      const where = eq(schema.apiKeys.organizationId, auth.organizationId);
      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.apiKeys)
        .where(where);
      const total = Number(totalRows[0]?.total ?? 0);

      const sortCol =
        sortBy === 'name' ? schema.apiKeys.name : schema.apiKeys.createdAt;
      const rows = await db.query.apiKeys.findMany({
        where,
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });
      // Never return hashedKey to clients — strip it from list responses.
      const sanitized = rows.map(({ hashedKey: _h, ...rest }) => rest);
      return ok({ api_keys: sanitized, page: pageMeta(parsed, total) });
    }
    case 'POST': {
      let body: { name?: string; scope?: string; role?: string; expiresAt?: string | null };
      try {
        body = JSON.parse(event.body ?? '{}');
      } catch {
        return badRequest('Invalid JSON body');
      }
      const name = body.name?.trim();
      const scope = body.scope as (typeof VALID_SCOPES)[number] | undefined;
      if (!name) return badRequest('name is required');
      if (!scope || !VALID_SCOPES.includes(scope)) {
        return badRequest(`scope must be one of: ${VALID_SCOPES.join(', ')}`);
      }

      const role = (body.role ?? DEFAULT_KEY_ROLE) as MembershipRole;
      if (!KEY_ROLES.includes(role)) {
        return badRequest(`role must be one of: ${KEY_ROLES.join(', ')}`);
      }
      if (ROLE_RANK[role] > ROLE_RANK[auth.membershipRole]) {
        return forbidden(
          `Cannot mint a "${role}" key: you are "${auth.membershipRole}". ` +
            'A key may not be more privileged than the caller minting it.',
        );
      }

      // Opt-in expiry. `null` and omitted both mean "never expires", which is
      // what every key minted before Phase 2 is.
      let expiresAt: Date | null = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
        if (typeof body.expiresAt !== 'string') {
          return badRequest('expiresAt must be an ISO-8601 date-time string or null');
        }
        const parsed = new Date(body.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          return badRequest('expiresAt is not a valid ISO-8601 date-time');
        }
        if (parsed.getTime() <= Date.now()) {
          return badRequest('expiresAt must be in the future');
        }
        expiresAt = parsed;
      }

      const plaintext = generatePlaintextKey();
      const hashedKey = hashApiKey(plaintext);

      const [row] = await db
        .insert(schema.apiKeys)
        .values({
          organizationId: auth.organizationId,
          name,
          hashedKey,
          scope,
          role,
          expiresAt,
          keyPrefix: apiKeyPrefix(plaintext),
        })
        .returning();

      // Plaintext key is returned exactly once at creation time.
      const { hashedKey: _h, ...rest } = row;
      return created({ api_key: rest, plaintext_key: plaintext });
    }
    case 'DELETE': {
      if (!id) return badRequest('api_key id required in path');
      const deleted = await db
        .delete(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.id, id),
            eq(schema.apiKeys.organizationId, auth.organizationId),
          ),
        )
        .returning({ id: schema.apiKeys.id });
      if (deleted.length === 0) return notFound(`API key "${id}" not found`);
      return { statusCode: 204, body: '' };
    }
    default:
      return methodNotAllowed(method, 'GET, POST, DELETE');
  }
};

export const handler = apiHandler(restHandler);
