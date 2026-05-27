import { createHash, randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import {
  badRequest,
  created,
  methodNotAllowed,
  notFound,
  ok,
} from '../utils/responses';

const VALID_SCOPES = ['edge', 'cloud', 'client'] as const;

function generatePlaintextKey(): string {
  return `xg_${randomBytes(24).toString('base64url')}`;
}

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const id = event.pathParameters?.id;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'DELETE';
    auth = await requireOrgContext(
      event,
      writeMethod ? ['owner', 'admin'] : undefined,
    );
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  switch (method) {
    case 'GET': {
      const rows = await db.query.apiKeys.findMany({
        where: eq(schema.apiKeys.organizationId, auth.organizationId),
        orderBy: [desc(schema.apiKeys.createdAt)],
      });
      // Never return hashedKey to clients — strip it from list responses.
      const sanitized = rows.map(({ hashedKey: _h, ...rest }) => rest);
      return ok({ api_keys: sanitized });
    }
    case 'POST': {
      let body: { name?: string; scope?: string };
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

      const plaintext = generatePlaintextKey();
      const hashedKey = hashKey(plaintext);

      const [row] = await db
        .insert(schema.apiKeys)
        .values({
          organizationId: auth.organizationId,
          name,
          hashedKey,
          scope,
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
