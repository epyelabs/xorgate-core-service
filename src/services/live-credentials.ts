import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { KinesisVideoClient, TagResourceCommand } from '@aws-sdk/client-kinesis-video';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { scopedTelemetryTopic } from './device-scope';

/**
 * Vending scoped credentials for the live plane.
 *
 * ## Why this is an assumed role rather than a Cognito identity
 *
 * Design note N2 recorded the constraint that shaped this phase:
 * `GetCredentialsForIdentity` accepts no inline session policy, so credentials
 * vended through a Cognito identity can only be narrowed by attaching named IoT
 * policies to that identity — which is where every size and count limit lives.
 *
 * The way out is to stop using a Cognito identity. AWS IoT requires an attached
 * AWS IoT policy only for **Cognito-federated** principals; a plain STS assumed
 * role is authorized for MQTT by its IAM policy alone (verified on dev, Phase
 * 4). So vending is `sts:AssumeRole` against one static ceiling role, narrowed
 * per request by an inline session policy naming literal ids. That buys:
 *
 * - no per-scope AWS resource to create, attach, version or garbage-collect;
 * - no 10-attached-policies-per-principal and no 2048-byte-per-policy ceiling
 *   on the number of devices a credential can reach, because the policy names
 *   a topic PATTERN rather than a device list;
 * - a workspace boundary expressed the same way on both planes.
 *
 * The role is the ceiling, this file is the grant. A bug here can only ever
 * narrow-to-wrong within "some xorgate tenant's live plane"; it cannot reach
 * anything the role does not already allow.
 *
 * ## Why the topics have to change
 *
 * `xorgate/devices/{deviceId}/telemetry` carries neither an organization nor a
 * workspace, so no topic-pattern policy can express a tenant boundary over it.
 * The scoped plane is
 * `xorgate/orgs/{orgId}/ws/{workspaceId}/devices/{deviceId}/telemetry`, and
 * DEVICES PUBLISH IT THEMSELVES (`services/device-scope.ts`), which is the
 * mechanism the user chose on 2026-08-13 after the evaluation. The alternative
 * that was measured and rejected — a cloud Lambda republishing every message
 * onto the scoped topic — is recorded in the Phase 4 handoff with its numbers.
 */

const sts = new STSClient({});
const kvs = new KinesisVideoClient({});

/** Both planes cap at an hour, and the SDK re-mints at ~50 minutes. */
export const MAX_TTL_SECONDS = 3600;
export const DEFAULT_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 300;

export const ORG_TAG_KEY = 'xorgate:organizationId';
export const WORKSPACE_TAG_KEY = 'xorgate:workspaceId';

export interface LiveCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

export interface LiveScope {
  organizationId: string;
  /** The one workspace this credential may reach, or null for the whole org. */
  workspaceId: string | null;
}

function region(): string {
  return process.env.AWS_REGION ?? 'us-east-1';
}

function account(): string {
  return process.env.AWS_ACCOUNT_ID!;
}

/**
 * The MQTT client id prefix a vended credential must use.
 *
 * The ceiling role scopes `iot:Connect` to `client/xgl-*`. Device ids are bare
 * UUIDs and first-party browser client ids start with the identity-pool prefix
 * `us-east-1:`, so a vended credential's client id can collide with neither and
 * cannot displace either session. (MQTT displaces the older connection on a
 * client-id collision; that is the availability defect Phase 1 closed for the
 * first-party plane, and this keeps it closed for the third-party one.)
 */
export const LIVE_CLIENT_ID_PREFIX = 'xgl-';

/** Re-exported so the policy builder and the topic builder stay one import apart. */
export { scopedTelemetryTopic };

/** `ttlSeconds` from a request body, rejected rather than clamped. */
export function resolveLiveTtlSeconds(
  raw: unknown,
): { ok: true; ttlSeconds: number } | { ok: false; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, ttlSeconds: DEFAULT_TTL_SECONDS };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, message: 'ttlSeconds must be an integer number of seconds' };
  }
  if (raw < MIN_TTL_SECONDS || raw > MAX_TTL_SECONDS) {
    return {
      ok: false,
      message: `ttlSeconds must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`,
    };
  }
  return { ok: true, ttlSeconds: raw };
}

/**
 * The inline session policy for one vend.
 *
 * Exported for the tests, which assert on the document rather than on a live
 * credential: the document IS the boundary, and a test that only checks a
 * successful subscribe proves nothing about what was denied.
 *
 * Note the shape difference between the two planes, which is not an
 * inconsistency but a consequence of what each service can express:
 *
 * - **IoT** authorizes on the topic string, so the scope is literal text inside
 *   an ARN pattern. Constant size regardless of how many devices are in scope.
 * - **KVS** channel names embed only the device id (`{deviceId}-{streamKey}`),
 *   so there is no tenant text in the ARN to match on. The scope is carried by
 *   resource TAGS on the channel instead, matched with a condition. Also
 *   constant size — and the reason `ensureChannelTags` exists.
 */
export function buildSessionPolicy(scope: LiveScope): string {
  const r = region();
  const a = account();
  const ws = scope.workspaceId ?? '*';
  const topicPath = `xorgate/orgs/${scope.organizationId}/ws/${ws}/devices/*/telemetry`;

  // A workspace-scoped credential matches on the workspace tag; an org-scoped
  // one on the organization tag. Never both: matching on the org tag while
  // holding a workspace-scoped credential would hand it the whole organization,
  // which is the exact boundary this phase exists to draw.
  const videoCondition = scope.workspaceId
    ? { [`aws:ResourceTag/${WORKSPACE_TAG_KEY}`]: scope.workspaceId }
    : { [`aws:ResourceTag/${ORG_TAG_KEY}`]: scope.organizationId };

  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'LiveConnect',
        Effect: 'Allow',
        Action: 'iot:Connect',
        Resource: `arn:aws:iot:${r}:${a}:client/${LIVE_CLIENT_ID_PREFIX}*`,
      },
      {
        Sid: 'LiveTelemetry',
        Effect: 'Allow',
        Action: ['iot:Subscribe', 'iot:Receive'],
        Resource: [
          `arn:aws:iot:${r}:${a}:topicfilter/${topicPath}`,
          `arn:aws:iot:${r}:${a}:topic/${topicPath}`,
        ],
      },
      {
        Sid: 'LiveVideo',
        Effect: 'Allow',
        Action: [
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:GetIceServerConfig',
          'kinesisvideo:ConnectAsViewer',
        ],
        Resource: `arn:aws:kinesisvideo:${r}:${a}:channel/*`,
        Condition: { StringEquals: videoCondition },
      },
    ],
  });
}

/**
 * The alternative the phase evaluated and did not pick: no bridge, no scoped
 * topics, and the device set written out one ARN at a time against the topics
 * that already exist.
 *
 * Kept, and kept exported, because it is the thing the measurement is ABOUT.
 * It has one genuine advantage over `buildSessionPolicy` — zero added latency
 * and zero added message volume, since it authorizes the very topic the device
 * already publishes to — and one disqualifying property: the document grows
 * with the device set against a hard 2048-character quota, so the credential
 * stops being mintable at a specific fleet size. `test/live-credentials.test.ts`
 * measures where.
 *
 * `channelArns` are passed rather than derived because a channel ARN carries a
 * creation timestamp that cannot be reconstructed from the channel name.
 */
export function buildEnumeratedSessionPolicy(
  deviceIds: string[],
  channelArns: string[],
): string {
  const r = region();
  const a = account();
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'LiveConnect',
        Effect: 'Allow',
        Action: 'iot:Connect',
        Resource: `arn:aws:iot:${r}:${a}:client/${LIVE_CLIENT_ID_PREFIX}*`,
      },
      {
        Sid: 'LiveTelemetry',
        Effect: 'Allow',
        Action: ['iot:Subscribe', 'iot:Receive'],
        Resource: deviceIds.flatMap((id) => [
          `arn:aws:iot:${r}:${a}:topicfilter/xorgate/devices/${id}/telemetry`,
          `arn:aws:iot:${r}:${a}:topic/xorgate/devices/${id}/telemetry`,
        ]),
      },
      {
        Sid: 'LiveVideo',
        Effect: 'Allow',
        Action: [
          'kinesisvideo:DescribeSignalingChannel',
          'kinesisvideo:GetSignalingChannelEndpoint',
          'kinesisvideo:GetIceServerConfig',
          'kinesisvideo:ConnectAsViewer',
        ],
        // The trailing wildcard stands in for the creation-time component that
        // makes a channel ARN unguessable from its name.
        Resource: channelArns.map((arn) => `${arn.replace(/\/\d+$/, '')}/*`),
      },
    ],
  });
}

/** The AWS quota an inline session policy is measured against. */
export const SESSION_POLICY_MAX_CHARS = 2048;

/**
 * Make sure the signalling channels this vend is ABOUT carry tags matching
 * where their devices actually are.
 *
 * Driven off the database, not off AWS: `kvs_channels.tagged_workspace_id`
 * records the workspace whose tags were last written, so the steady-state cost
 * of this call is one indexed SELECT that returns nothing.
 *
 * **Both directions of drift, which is the part that is easy to get wrong.**
 * The rows it repairs are those where the tag disagrees with the device's
 * current workspace AND either side of that disagreement touches the scope
 * being vended for:
 *
 * - a device that has ARRIVED in this scope (or a channel created before this
 *   phase existed, whose tag is simply absent) — repairing it GRANTS access,
 *   and forgetting it would only mean a blank video panel;
 * - a device that has LEFT this scope but whose channel still carries this
 *   workspace's tag — repairing it REVOKES access, and forgetting it would mean
 *   the former tenant keeps watching a device it no longer has, indefinitely
 *   rather than for a credential lifetime. That second case is why the filter
 *   is an OR over both columns rather than a lookup by current workspace, and
 *   it is the case a first implementation here missed.
 *
 * Because this runs BEFORE the credential is minted, a repair is always
 * reflected in the credential being handed out. So the window in which a moved
 * device stays visible to its former workspace is bounded by ALREADY-VENDED
 * credentials only, which is the ≤1 hour the plan already accepts, rather than
 * by when someone happens to look.
 *
 * Failure is logged and swallowed on purpose. A channel that could not be
 * tagged is a channel a scoped credential cannot view — it fails CLOSED — and
 * turning that into a 500 would take down telemetry vending for a video
 * problem. The next vend retries.
 */
export async function ensureChannelTags(workspaceIds: string[]): Promise<number> {
  if (workspaceIds.length === 0) return 0;

  const stale = await db
    .select({
      id: schema.kvsChannels.id,
      channelArn: schema.kvsChannels.channelArn,
      workspaceId: schema.devices.workspaceId,
      organizationId: schema.workspaces.organizationId,
    })
    .from(schema.kvsChannels)
    .innerJoin(schema.devices, eq(schema.kvsChannels.deviceId, schema.devices.id))
    .innerJoin(schema.workspaces, eq(schema.devices.workspaceId, schema.workspaces.id))
    .where(
      and(
        or(
          inArray(schema.devices.workspaceId, workspaceIds),
          inArray(schema.kvsChannels.taggedWorkspaceId, workspaceIds),
        ),
        or(
          isNull(schema.kvsChannels.taggedWorkspaceId),
          ne(schema.kvsChannels.taggedWorkspaceId, schema.devices.workspaceId),
        ),
      ),
    );

  let tagged = 0;
  for (const row of stale) {
    try {
      await kvs.send(
        new TagResourceCommand({
          ResourceARN: row.channelArn,
          Tags: [
            { Key: ORG_TAG_KEY, Value: row.organizationId },
            { Key: WORKSPACE_TAG_KEY, Value: row.workspaceId },
          ],
        }),
      );
      await db
        .update(schema.kvsChannels)
        .set({ taggedWorkspaceId: row.workspaceId })
        .where(eq(schema.kvsChannels.id, row.id));
      tagged += 1;
    } catch (err) {
      console.warn(
        `[live-credentials] could not tag ${row.channelArn}; it stays unviewable for scoped credentials`,
        err,
      );
    }
  }
  return tagged;
}

/**
 * Exchange a scope for AWS credentials that reach only that scope's live plane.
 *
 * `RoleSessionName` is what shows up in CloudTrail for every MQTT connect and
 * WebRTC handshake the credential makes, so it carries the scope rather than a
 * constant: an operator reading the trail can tell which tenant a session
 * belonged to without joining anything.
 */
export async function vendLiveCredentials(
  scope: LiveScope,
  ttlSeconds: number,
): Promise<LiveCredentials> {
  const sessionName = `xgl-${(scope.workspaceId ?? scope.organizationId).replace(/-/g, '').slice(0, 24)}`;

  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: process.env.LIVE_VEND_ROLE_ARN!,
      RoleSessionName: sessionName,
      DurationSeconds: ttlSeconds,
      Policy: buildSessionPolicy(scope),
    }),
  );

  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error('AssumeRole returned no credentials');
  }

  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration.toISOString(),
  };
}
