import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { IoTClient, AttachPolicyCommand, DetachPolicyCommand } from '@aws-sdk/client-iot';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index';

/**
 * Granting and revoking a browser's access to the live plane.
 *
 * AWS IoT does NOT authorize MQTT for Cognito-federated principals through
 * their IAM role alone: it also requires an IoT policy attached to the Cognito
 * IDENTITY. Granting is therefore `AttachPolicy(browser policy -> identity)`,
 * and revoking is the matching `DetachPolicy`.
 *
 * The bookkeeping table (`iot_policy_attachments`) exists for one reason: a
 * membership-removal path knows a USER id and holds no token, and `GetId` needs
 * a token. Without the recorded identity id there is no way to go from "this
 * user was removed" to "detach this identity". AWS remains the source of truth
 * for the attachment; the table is a lookup index over it.
 */

const cognito = new CognitoIdentityClient({});
const iot = new IoTClient({});

/** Postgres `undefined_table`. */
const UNDEFINED_TABLE = '42P01';

function isMissingTable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes(UNDEFINED_TABLE) || /relation .*iot_policy_attachments.* does not exist/i.test(text);
}

export function browserPolicyName(): string {
  return process.env.BROWSER_IOT_POLICY_NAME!;
}

/** Resolve the Cognito identity id for a caller, from their verified id token. */
export async function resolveIdentityId(idToken: string): Promise<string | undefined> {
  const { IdentityId } = await cognito.send(
    new GetIdCommand({
      IdentityPoolId: process.env.COGNITO_IDENTITY_POOL_ID!,
      Logins: { [process.env.COGNITO_USER_POOL_PROVIDER!]: idToken },
    }),
  );
  return IdentityId;
}

/**
 * Attach the browser policy to `identityId` and record it against `userId`.
 * Idempotent on both halves.
 */
export async function grantLiveAccess(
  userId: string,
  identityId: string,
): Promise<{ policyName: string }> {
  const policyName = browserPolicyName();
  await iot.send(new AttachPolicyCommand({ policyName, target: identityId }));
  await recordAttachment(userId, identityId, policyName);
  return { policyName };
}

/**
 * Detach every policy recorded for `userId` and forget the rows. Returns the
 * identities it detached, which is empty for a user who never used the live
 * plane. Safe to call for any user.
 */
export async function revokeLiveAccessForUser(userId: string): Promise<string[]> {
  const rows = await listAttachments(userId);
  const detached: string[] = [];
  for (const row of rows) {
    await iot.send(
      new DetachPolicyCommand({ policyName: row.policyName, target: row.identityId }),
    );
    detached.push(row.identityId);
  }
  if (rows.length) await forgetAttachmentsForUser(userId);
  return detached;
}

/**
 * Detach the browser policy from one identity (the self-service path, where the
 * caller presented a token and we resolved their own identity).
 */
export async function revokeLiveAccessForIdentity(
  userId: string,
  identityId: string,
): Promise<{ policyName: string }> {
  const policyName = browserPolicyName();
  await iot.send(new DetachPolicyCommand({ policyName, target: identityId }));
  await forgetAttachment(userId, identityId, policyName);
  return { policyName };
}

// --- Bookkeeping. Every write is best-effort against a MISSING TABLE only.
// The `iot_policy_attachments` migration applies out of band (RDS Data API), so
// the code ships before the table exists; until it does, granting still works
// and only the membership-removal detach is inert. Any other DB error still
// throws. Delete these guards once the migration is applied everywhere. ---

async function recordAttachment(
  userId: string,
  identityId: string,
  policyName: string,
): Promise<void> {
  try {
    await db
      .insert(schema.iotPolicyAttachments)
      .values({ userId, identityId, policyName })
      .onConflictDoNothing();
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn('[live-access] iot_policy_attachments missing; attachment not recorded');
      return;
    }
    throw err;
  }
}

async function listAttachments(
  userId: string,
): Promise<{ identityId: string; policyName: string }[]> {
  try {
    const rows = await db.query.iotPolicyAttachments.findMany({
      where: eq(schema.iotPolicyAttachments.userId, userId),
    });
    return rows.map((r) => ({ identityId: r.identityId, policyName: r.policyName }));
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn('[live-access] iot_policy_attachments missing; nothing to detach');
      return [];
    }
    throw err;
  }
}

async function forgetAttachmentsForUser(userId: string): Promise<void> {
  try {
    await db
      .delete(schema.iotPolicyAttachments)
      .where(eq(schema.iotPolicyAttachments.userId, userId));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}

async function forgetAttachment(
  userId: string,
  identityId: string,
  policyName: string,
): Promise<void> {
  try {
    await db
      .delete(schema.iotPolicyAttachments)
      .where(
        and(
          eq(schema.iotPolicyAttachments.userId, userId),
          eq(schema.iotPolicyAttachments.identityId, identityId),
          eq(schema.iotPolicyAttachments.policyName, policyName),
        ),
      );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
}
