import { routeKey as canonicalRouteKey } from '../utils/route';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { badRequest, conflict, errorResponse, methodNotAllowed, ok } from '../utils/responses';
import {
  CREDENTIAL_PROVIDERS,
  isCredentialProvider,
  isSecretGoneError,
  isValidatableProvider,
  orgSecretName,
  PLATFORM_SECRET_ENV,
  probeCredential,
  setCredentialSchema,
  validateCredentialSchema,
  type CredentialProvider,
} from '../workflows/org-credentials';

/**
 * Per-organization connector credentials (M7): BYO API keys for
 * connector.third_party providers (google_roads, here) and the model.vlm
 * Claude key (anthropic), stored as one Secrets Manager secret per org per
 * provider (xorgate/orgs/<orgId>/<provider>). WRITE-ONLY by design: reads
 * return presence + last-rotated metadata, never the value.
 *
 * Routes (org from X-Organization-Id; reads any member, writes owner/admin):
 *   GET    /organization-credentials
 *     -> { credentials: [{ provider, configured, lastRotatedAt }] }
 *   PUT    /organization-credentials/{provider}         { apiKey }
 *     -> { credential: { provider, configured: true, lastRotatedAt } }
 *   DELETE /organization-credentials/{provider}         -> 204 (idempotent)
 *   POST   /organization-credentials/{provider}/validate  { apiKey? }
 *     -> { validation: { provider, keySource, ok, message } }
 *        keySource: candidate | organization | platform | none
 *        (validate also accepts provider "osm": reachability only, no key)
 *
 * Rotation caveat (M3/M5, unchanged): both engine targets cache secret VALUES
 * for the process/task lifetime, so a rotated or cleared key can lag on a warm
 * Lambda container or a live warm-session task until it recycles. A newly SET
 * org key is picked up on the next run (misses are not cached).
 */

const sm = new SecretsManagerClient({});

function safeJson(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return {};
  }
}

// Missing OR still "scheduled for deletion" after a force delete: both read
// as absent (isSecretGoneError, shared with the engine secrets seam).
const isNotFound = isSecretGoneError;

async function credentialStatus(
  orgId: string,
  provider: CredentialProvider,
): Promise<{ provider: CredentialProvider; configured: boolean; lastRotatedAt: string | null }> {
  try {
    const res = await sm.send(new DescribeSecretCommand({ SecretId: orgSecretName(orgId, provider) }));
    if (res.DeletedDate) return { provider, configured: false, lastRotatedAt: null };
    const rotated = res.LastChangedDate ?? res.CreatedDate ?? null;
    return { provider, configured: true, lastRotatedAt: rotated ? rotated.toISOString() : null };
  } catch (err) {
    if (isNotFound(err)) return { provider, configured: false, lastRotatedAt: null };
    throw err;
  }
}

/** The stored org key, or null when unset (missing, deleted, or empty). */
async function orgKeyValue(orgId: string, provider: CredentialProvider): Promise<string | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: orgSecretName(orgId, provider) }));
    return res.SecretString || null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** The platform key for a provider, or null when the env/secret is absent. */
async function platformKeyValue(provider: CredentialProvider): Promise<string | null> {
  const secretName = process.env[PLATFORM_SECRET_ENV[provider]];
  if (!secretName) return null;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
    return res.SecretString || null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Create-or-rotate. A cleared secret can linger a moment in "scheduled for
 * deletion" even with ForceDeleteWithoutRecovery; retry the create briefly and
 * surface a 409 if it does not clear.
 */
async function putOrgKey(orgId: string, provider: CredentialProvider, apiKey: string): Promise<void> {
  const name = orgSecretName(orgId, provider);
  for (let attempt = 0; ; attempt++) {
    try {
      await sm.send(new CreateSecretCommand({ Name: name, SecretString: apiKey }));
      return;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'ResourceExistsException') {
        await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: apiKey }));
        return;
      }
      const stillDeleting =
        e.name === 'InvalidRequestException' && /deletion/i.test(e.message ?? '');
      if (stillDeleting && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (stillDeleting) {
        throw new ConflictError('The previous key is still being cleared; retry in a few seconds');
      }
      throw err;
    }
  }
}

class ConflictError extends Error {}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const providerParam = event.pathParameters?.provider;

  let auth;
  try {
    auth = await requireOrgWideContext(event, method === 'GET' ? undefined : ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgId = auth.organizationId;

  switch (routeKey) {
    case 'GET /organization-credentials': {
      const credentials = await Promise.all(
        CREDENTIAL_PROVIDERS.map((provider) => credentialStatus(orgId, provider)),
      );
      return ok({ credentials });
    }

    case 'PUT /organization-credentials/{provider}': {
      if (!isCredentialProvider(providerParam)) {
        return badRequest(`provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`);
      }
      const parsed = setCredentialSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      try {
        await putOrgKey(orgId, providerParam, parsed.data.apiKey);
      } catch (err) {
        if (err instanceof ConflictError) return conflict(err.message);
        throw err;
      }
      return ok({
        credential: { provider: providerParam, configured: true, lastRotatedAt: new Date().toISOString() },
      });
    }

    case 'DELETE /organization-credentials/{provider}': {
      if (!isCredentialProvider(providerParam)) {
        return badRequest(`provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`);
      }
      try {
        // Force delete: the default 30-day recovery window would block
        // re-creating the same secret name on the next "set".
        await sm.send(
          new DeleteSecretCommand({
            SecretId: orgSecretName(orgId, providerParam),
            ForceDeleteWithoutRecovery: true,
          }),
        );
      } catch (err) {
        if (!isNotFound(err)) throw err; // clearing an unset key is a no-op
      }
      return { statusCode: 204, body: '' };
    }

    case 'POST /organization-credentials/{provider}/validate': {
      if (!isValidatableProvider(providerParam)) {
        return badRequest(`provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}, osm`);
      }
      const parsed = validateCredentialSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');

      let keySource: 'candidate' | 'organization' | 'platform' | 'none' = 'none';
      let apiKey: string | null = null;
      if (providerParam !== 'osm') {
        if (parsed.data.apiKey) {
          keySource = 'candidate';
          apiKey = parsed.data.apiKey;
        } else {
          apiKey = await orgKeyValue(orgId, providerParam);
          if (apiKey) {
            keySource = 'organization';
          } else {
            apiKey = await platformKeyValue(providerParam);
            if (apiKey) keySource = 'platform';
          }
        }
        if (!apiKey) {
          return ok({
            validation: {
              provider: providerParam,
              keySource: 'none',
              ok: false,
              message: 'No key to validate: no organization key set and no platform default configured',
            },
          });
        }
      }

      try {
        const result = await probeCredential(providerParam, apiKey, fetch);
        return ok({ validation: { provider: providerParam, keySource, ...result } });
      } catch (err) {
        // Network-level failure reaching the provider, not a key verdict.
        return errorResponse(502, 'CREDENTIAL_PROBE_FAILED', 'Could not reach the provider to validate', {
          provider: providerParam,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    default:
      return methodNotAllowed(method, 'GET, PUT, DELETE, POST');
  }
};
