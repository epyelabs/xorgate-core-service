import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { isSecretGoneError, ORG_SECRET_PREFIX } from '../../workflows/org-credentials';
import { generateWebhookSecret } from './signing';

/**
 * One Secrets Manager secret per endpoint (README D5, Q5), following the
 * org-credentials precedent: `xorgate/orgs/<orgId>/webhooks/<endpointId>`,
 * inside the existing IAM grant on `secret:xorgate/orgs/*`. No KMS key, no
 * crypto in app code; the value is JSON:
 *
 *   { current, previous?, previousExpiresAt? }
 *
 * `previous` is the pre-rotation secret, still signed with until
 * `previousExpiresAt` (24 h) so receivers can roll over. The deliver Lambda
 * caches values for its process lifetime keyed by (endpointId, secret_version);
 * a rotation bumps `webhook_endpoints.secret_version`, which is what makes the
 * next delivery miss the cache.
 */

export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface StoredWebhookSecret {
  current: string;
  previous?: string;
  previousExpiresAt?: string;
}

const sm = new SecretsManagerClient({});

export function webhookSecretName(orgId: string, endpointId: string): string {
  return `${ORG_SECRET_PREFIX}${orgId}/webhooks/${endpointId}`;
}

/** Mint and store the first secret of a new endpoint; returns it (shown once). */
export async function createEndpointSecret(orgId: string, endpointId: string): Promise<string> {
  const secret = generateWebhookSecret();
  const value: StoredWebhookSecret = { current: secret };
  const name = webhookSecretName(orgId, endpointId);
  try {
    await sm.send(new CreateSecretCommand({ Name: name, SecretString: JSON.stringify(value) }));
  } catch (err) {
    // Endpoint ids are fresh uuids, so this only happens on a retried create.
    if ((err as { name?: string }).name !== 'ResourceExistsException') throw err;
    await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify(value) }));
  }
  return secret;
}

export async function readEndpointSecret(orgId: string, endpointId: string): Promise<StoredWebhookSecret | null> {
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: webhookSecretName(orgId, endpointId) }));
    if (!res.SecretString) return null;
    const parsed = JSON.parse(res.SecretString) as StoredWebhookSecret;
    return typeof parsed.current === 'string' ? parsed : null;
  } catch (err) {
    if (isSecretGoneError(err)) return null;
    throw err;
  }
}

/**
 * New current secret; the old one stays valid for ROTATION_OVERLAP_MS.
 * Rotating twice inside the window drops the oldest (only one previous is
 * kept). The caller bumps `secret_version` AFTER this resolves.
 */
export async function rotateEndpointSecret(
  orgId: string,
  endpointId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const existing = await readEndpointSecret(orgId, endpointId);
  const secret = generateWebhookSecret();
  const value: StoredWebhookSecret = existing
    ? {
        current: secret,
        previous: existing.current,
        previousExpiresAt: new Date(nowMs + ROTATION_OVERLAP_MS).toISOString(),
      }
    : { current: secret };
  if (existing) {
    await sm.send(
      new PutSecretValueCommand({
        SecretId: webhookSecretName(orgId, endpointId),
        SecretString: JSON.stringify(value),
      }),
    );
  } else {
    // Missing (deleted out of band): recreate rather than fail the rotation.
    await sm.send(
      new CreateSecretCommand({ Name: webhookSecretName(orgId, endpointId), SecretString: JSON.stringify(value) }),
    );
  }
  secretCache.delete(endpointId);
  return secret;
}

/** Idempotent: a missing secret is fine. */
export async function deleteEndpointSecret(orgId: string, endpointId: string): Promise<void> {
  try {
    await sm.send(
      new DeleteSecretCommand({
        SecretId: webhookSecretName(orgId, endpointId),
        ForceDeleteWithoutRecovery: true,
      }),
    );
  } catch (err) {
    if (!isSecretGoneError(err)) throw err;
  }
  secretCache.delete(endpointId);
}

/** The secrets a delivery signs with right now: current, plus previous inside its window. */
export function activeSecrets(value: StoredWebhookSecret, nowMs: number = Date.now()): string[] {
  const out = [value.current];
  if (value.previous && value.previousExpiresAt && Date.parse(value.previousExpiresAt) > nowMs) {
    out.push(value.previous);
  }
  return out;
}

const secretCache = new Map<string, { version: number; value: StoredWebhookSecret }>();

/**
 * The deliver Lambda's read path: cached per (endpointId, secretVersion) for
 * the process lifetime. Throws when the secret is missing (the delivery then
 * fails its attempt and retries on the normal schedule).
 */
export async function signingSecrets(
  orgId: string,
  endpointId: string,
  secretVersion: number,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const hit = secretCache.get(endpointId);
  if (hit && hit.version === secretVersion) return activeSecrets(hit.value, nowMs);
  const value = await readEndpointSecret(orgId, endpointId);
  if (!value) throw new Error('signing secret is missing');
  secretCache.set(endpointId, { version: secretVersion, value });
  return activeSecrets(value, nowMs);
}
