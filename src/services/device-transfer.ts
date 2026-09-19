import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { publishDeviceConfigOnly } from './device-config';
import { ensureThingScopeAttributes, type ScopeAttributeResult } from './device-scope';
import { ensureChannelTags } from './live-credentials';
import type { DeviceConfigDocument } from '../config-registry/index';

/**
 * Moving a device from one tenancy to another.
 *
 * This productises an operation that was performed by hand four times on
 * 2026-09-18, the first of which caused a ~50-minute production outage. Read
 * `plans/transfer-device-ownership/README.md` §2.2 and §2.3 before changing
 * anything here; what follows is the short version.
 *
 * **A device's tenancy is three facts that must agree**, written in three
 * different places, and they cannot be one transaction:
 *
 *   1. `devices.workspace_id` — what the API and the console filter on.
 *   2. The IoT thing attributes `xgOrgId`/`xgWorkspaceId` — the ENFORCEMENT
 *      half. The device policy interpolates them to decide which telemetry
 *      topic this thing may publish on.
 *   3. The `scope` block of the retained config message — the INSTRUCTION
 *      half. It tells the device which topic to publish on.
 *
 * **Order is the whole game.** (3) before (2), adjacent, with nothing slow
 * between them. Reversed, a running agent is pinned to a topic the broker has
 * just stopped accepting; IoT Core closes the connection on an unauthorized
 * publish, so it reconnects into the same state, every ~3 s, with no remote
 * exit — the 2026-09-18 outage, which ended only with an SSH'd process restart.
 * Done in the right order and adjacent, the measured cost is one disconnect and
 * ~3 s of recovery.
 *
 * Two refinements the bench added on 2026-09-19 that are easy to get wrong:
 *
 * - **Never bump `config_rev` to force the republish.** The reconciler
 *   republishes whenever `report.rev < config_rev`, so a device that cannot
 *   converge gets kicked on every reconnect — that is what took one thing's
 *   `version` from 118 to 255 in minutes. The agent applies `scope` OUTSIDE its
 *   rev guard, so publishing at the UNCHANGED rev takes effect anyway.
 * - **The attribute write ARMS the trap; it does not spring it.** AWS IoT
 *   resolves `${iot:Connection.Thing.Attributes[…]}` at CONNECT time, so an
 *   established session keeps its old resolution: after a foreign-workspace flip
 *   the bench published happily for 42 s with zero reconnects. A botched
 *   transfer can therefore look perfect for hours and strand on the next LTE
 *   blip. Nothing in this file may treat "it is still publishing" as proof.
 *
 * **A transfer does not touch the device.** Certificates and identity never
 * change (the one shared device policy carries no literal tenancy), and the
 * scope is never persisted on the device. So an OFFLINE device is transferred
 * exactly like an online one — steps 3 and 4 stage the new tenancy in the cloud
 * and the retained message waits on the broker until it next connects. Offline
 * is a normal success, reported as a warning, never an error. It is in fact
 * strictly SAFER than online: the trap above exists only because a running agent
 * is pinned to a topic, and an offline device has no such process.
 *
 * Structured like `device-teardown.ts`, and for the same reasons: one primitive
 * behind several callers (same-org transfer, offer-accept, bulk), a DB half that
 * is authoritative and an AWS half that is best-effort and logged, and a summary
 * object so the caller decides what to surface rather than this file guessing.
 */

/** How long a `pending` row can plausibly be a transfer still in flight. */
const STALE_TRANSFER_MS = 2 * 60 * 1000;

/**
 * A pre-flight failure with the HTTP status the route should return.
 *
 * Thrown only from validation, never from the ordered sequence — once the first
 * write lands, the outcome is a `TransferSummary` with warnings, because a
 * partially applied transfer is something the caller has to be told about
 * precisely, not something an exception can express.
 */
export class TransferError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

export interface TransferActor {
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface TransferInput {
  deviceId: string;
  toWorkspaceId: string;
  actor: TransferActor;
  /** Set when the transfer came from an accepted cross-org offer; recorded for the audit trail. */
  offerId?: string;
}

export interface TransferTenancy {
  workspaceId: string;
  organizationId: string;
}

/**
 * Whether the DEVICE has adopted the new tenancy yet.
 *
 * `confirmed` means the device itself said so: agent v0.0.6+ reports
 * `effective.telemetryScope` on every config report, and that block is the only
 * cloud-side evidence a transfer actually landed. `reported_config.rev` is NOT
 * evidence — a scope change deliberately does not move the rev.
 *
 * `unknown` is its own state and must never be collapsed into `pending` or into
 * `confirmed`. An agent older than v0.0.6 sends no `telemetryScope` at all, so
 * its absence means "this device has never told us", which is a different thing
 * from "it has told us and it is behind".
 */
export type TransferAdoption = 'confirmed' | 'pending' | 'unknown';

export interface TransferSummary {
  /** The `device_transfers` row, for the audit trail and for support questions. */
  transferId: string;
  deviceId: string;
  from: TransferTenancy;
  to: TransferTenancy;
  crossOrg: boolean;
  /** Template names detached by the cross-org sweep. Empty for a same-org move. */
  detachedWorkflowAttachments: string[];
  kvsChannelsRetagged: number;
  /** What the thing-attribute write did. `failed` is a degraded success — see `warnings`. */
  scopeAttributes: ScopeAttributeResult;
  adoption: TransferAdoption;
  warnings: string[];
}

export interface TransferBlocker {
  code: string;
  message: string;
}

export interface TransferPreview {
  deviceId: string;
  deviceName: string | null;
  serial: string | null;
  from: TransferTenancy & { workspaceName: string; organizationName: string };
  to: TransferTenancy & { workspaceName: string; organizationName: string };
  crossOrg: boolean;
  /**
   * Attachments the cross-org sweep would detach, named so the operator can
   * reconsider BEFORE confirming. Empty for a same-org move — templates are
   * org-scoped and the organization is not changing.
   */
  workflowAttachments: { id: string; templateId: string; templateName: string }[];
  /** Workflow runs currently executing for this device; they are left to finish. */
  runningWorkflowRuns: number;
  /** Recording sessions still accepting segment uploads; they keep uploading. */
  openMediaSessions: number;
  /** Workspace-scoped session tokens naming the SOURCE workspace; they lose the device. */
  staleSessionTokens: number;
  kvsChannels: number;
  /**
   * Always true, and stated rather than implied: every historical telemetry row
   * and every recorded segment is device-keyed and travels with the device.
   * For a cross-org transfer that is a data-disclosure event (README §3.1, Q4).
   */
  carriesHistory: true;
  /** Non-empty means the transfer would be refused; each carries the status the route returns. */
  blockers: TransferBlocker[];
  warnings: string[];
}

interface DeviceTenancyRow {
  id: string;
  name: string | null;
  serial: string;
  status: string;
  workspaceId: string;
  workspaceName: string;
  organizationId: string;
  organizationName: string;
  config: DeviceConfigDocument | null;
  configRev: number;
  reportedConfig: Record<string, unknown> | null;
}

/** The device plus its resolved tenancy, or null when the device is gone. */
async function deviceTenancy(deviceId: string): Promise<DeviceTenancyRow | null> {
  const rows = await db
    .select({
      id: schema.devices.id,
      name: schema.devices.name,
      serial: schema.devices.serial,
      status: schema.devices.status,
      workspaceId: schema.devices.workspaceId,
      workspaceName: schema.workspaces.name,
      organizationId: schema.workspaces.organizationId,
      organizationName: schema.organizations.name,
      config: schema.devices.config,
      configRev: schema.devices.configRev,
      reportedConfig: schema.devices.reportedConfig,
    })
    .from(schema.devices)
    .innerJoin(schema.workspaces, eq(schema.devices.workspaceId, schema.workspaces.id))
    .innerJoin(
      schema.organizations,
      eq(schema.workspaces.organizationId, schema.organizations.id),
    )
    .where(eq(schema.devices.id, deviceId))
    .limit(1);
  return (rows[0] as DeviceTenancyRow | undefined) ?? null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
}

async function workspaceTenancy(workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      organizationId: schema.workspaces.organizationId,
      organizationName: schema.organizations.name,
    })
    .from(schema.workspaces)
    .innerJoin(
      schema.organizations,
      eq(schema.workspaces.organizationId, schema.organizations.id),
    )
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return (rows[0] as WorkspaceRow | undefined) ?? null;
}

/**
 * Read the device's own account of which telemetry topic it is publishing on.
 *
 * Returns null when the device has never reported one, which is every device on
 * an agent older than v0.0.6 as well as every device that has never connected.
 */
function reportedScope(
  reportedConfig: Record<string, unknown> | null | undefined,
): { organizationId?: string; workspaceId?: string; scoped?: boolean } | null {
  const effective = (reportedConfig as { effective?: Record<string, unknown> } | null)
    ?.effective;
  const scope = effective?.telemetryScope;
  if (!scope || typeof scope !== 'object') return null;
  return scope as { organizationId?: string; workspaceId?: string; scoped?: boolean };
}

/** Has the device confirmed it is publishing under `to`? */
export function transferAdoption(
  reportedConfig: Record<string, unknown> | null | undefined,
  to: TransferTenancy,
): TransferAdoption {
  const scope = reportedScope(reportedConfig);
  if (!scope) return 'unknown';
  return scope.organizationId === to.organizationId && scope.workspaceId === to.workspaceId
    ? 'confirmed'
    : 'pending';
}

/**
 * Templates this device is attached to whose organization is not `organizationId`.
 *
 * The finding this sweep exists for (README §3.2, item 5): `workflow_attachments`
 * is device-keyed and points at an org-scoped `workflow_templates` row, so a
 * device that changes organization keeps executing a template its new owner
 * cannot see and its former owner no longer owns. Phrased as "not the
 * destination org" rather than "the source org" on purpose — that is the
 * property that actually matters, and it also catches an attachment that was
 * already orphaned before this transfer.
 */
async function orphanedAttachments(
  deviceId: string,
  organizationId: string,
): Promise<{ id: string; templateId: string; templateName: string }[]> {
  const rows = await db
    .select({
      id: schema.workflowAttachments.id,
      templateId: schema.workflowTemplates.id,
      templateName: schema.workflowTemplates.name,
    })
    .from(schema.workflowAttachments)
    .innerJoin(
      schema.workflowTemplates,
      eq(schema.workflowAttachments.templateId, schema.workflowTemplates.id),
    )
    .where(
      and(
        eq(schema.workflowAttachments.deviceId, deviceId),
        ne(schema.workflowTemplates.organizationId, organizationId),
      ),
    );
  return rows;
}

/**
 * Attachments a move to ANY other organization would detach.
 *
 * The offer flow (Phase 4) needs this and `orphanedAttachments` cannot serve it:
 * at offer-creation time the DESTINATION organization is unknown, so the
 * question is not "which attachments does the destination not own" but "which
 * would be orphaned by an organization change at all" — which is every
 * attachment whose template belongs to the device's current organization, i.e.
 * every attachment it has.
 *
 * README §4.5 is the reason this is computed at CREATION rather than at accept:
 * the SOURCE is the party that loses the attachments and the source is not
 * present when the offer is accepted, so by then it is too late to reconsider.
 */
export async function attachmentsAtRiskOnOrgChange(
  deviceId: string,
  organizationId: string,
): Promise<{ id: string; templateId: string; templateName: string }[]> {
  return db
    .select({
      id: schema.workflowAttachments.id,
      templateId: schema.workflowTemplates.id,
      templateName: schema.workflowTemplates.name,
    })
    .from(schema.workflowAttachments)
    .innerJoin(
      schema.workflowTemplates,
      eq(schema.workflowAttachments.templateId, schema.workflowTemplates.id),
    )
    .where(
      and(
        eq(schema.workflowAttachments.deviceId, deviceId),
        eq(schema.workflowTemplates.organizationId, organizationId),
      ),
    );
}

async function countRows(
  query: Promise<{ n: number }[]>,
): Promise<number> {
  const rows = await query;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Sweep — and where possible FINISH — transfers left `pending` by an
 * interrupted request.
 *
 * A `pending` row is in flight for the couple of seconds the ordered sequence
 * takes. Anything older than `STALE_TRANSFER_MS` is a Lambda that died partway,
 * and leaving it would block every future transfer of that device forever, so
 * this runs lazily from the pre-flight rather than from a scheduled job — the
 * same reasoning that makes `device_registrations` lazy-expire on read.
 *
 * The repair is the interesting half. If the DB write landed (the device's
 * workspace already equals `to_workspace_id`) then the tenancy change is real
 * and the only question is whether the device was ever told. Re-running the
 * PUBLISH and then the attribute write is idempotent and is the only safe
 * repair: re-asserting the attributes ALONE would be exactly the forbidden
 * direction — enforcement ahead of instruction — for a transfer that died
 * between steps 2 and 3, where the config carrying the new scope was never sent.
 */
export async function reconcileStaleTransfers(deviceId: string): Promise<void> {
  const stale = await db
    .select({
      id: schema.deviceTransfers.id,
      toWorkspaceId: schema.deviceTransfers.toWorkspaceId,
      toOrganizationId: schema.deviceTransfers.toOrganizationId,
    })
    .from(schema.deviceTransfers)
    .where(
      and(
        eq(schema.deviceTransfers.deviceId, deviceId),
        eq(schema.deviceTransfers.status, 'pending'),
        lt(schema.deviceTransfers.createdAt, new Date(Date.now() - STALE_TRANSFER_MS)),
      ),
    );
  if (stale.length === 0) return;

  const device = await deviceTenancy(deviceId);
  for (const row of stale) {
    const landed = device?.workspaceId === row.toWorkspaceId;
    let repaired = false;
    if (landed && device) {
      // Steps 3 + 4 again, in order and adjacent. Idempotent: the retained
      // message is replaced with an identical one at the same rev, and the
      // attribute write (precheck ON here — this is not the hot path and the
      // read is what stops a redundant UpdateThing) is a no-op when it already
      // matches.
      try {
        const scope = await publishDeviceConfigOnly(deviceId, device.config, device.configRev);
        if (scope) await ensureThingScopeAttributes(deviceId, scope);
        repaired = true;
      } catch (err) {
        console.warn(`[device-transfer] could not finish interrupted transfer ${row.id}`, err);
      }
    }
    await db
      .update(schema.deviceTransfers)
      .set({
        status: repaired ? 'completed' : 'failed',
        stage: repaired ? 'attributes' : 'db',
        completedAt: new Date(),
        error: repaired
          ? 'interrupted mid-sequence; finished by the stale-transfer sweep'
          : 'interrupted mid-sequence and not finishable; no tenancy change was recorded',
      })
      .where(
        and(
          eq(schema.deviceTransfers.id, row.id),
          eq(schema.deviceTransfers.status, 'pending'),
        ),
      );
    console.warn(
      '[device-transfer]',
      JSON.stringify({ swept: row.id, deviceId, landed, repaired }),
    );
  }
}

/** A transfer already in flight for this device, after the stale sweep. */
async function transferInProgress(deviceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.deviceTransfers.id })
    .from(schema.deviceTransfers)
    .where(
      and(
        eq(schema.deviceTransfers.deviceId, deviceId),
        eq(schema.deviceTransfers.status, 'pending'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Everything the ordered sequence would do, with no writes.
 *
 * Drives the confirmation dialog, which has to be able to name what it is about
 * to detach BEFORE the operator confirms — by accept time it is too late to
 * reconsider. Blockers are RETURNED rather than thrown, because a preview whose
 * job is to describe an impossible transfer honestly is more useful than one
 * that 409s.
 *
 * The one thing it cannot preview is the cross-org sweep for an offer that has
 * no destination yet (Phase 4): at offer-creation time the destination
 * organization is unknown, so the caller asks for the preview against its own
 * organization and reads `workflowAttachments` as "these detach IF the
 * destination is a different organization".
 */
export async function previewTransfer(
  deviceId: string,
  toWorkspaceId: string,
): Promise<TransferPreview> {
  const device = await deviceTenancy(deviceId);
  if (!device) {
    throw new TransferError(`Device "${deviceId}" not found`, 404, 'NOT_FOUND');
  }
  const target = await workspaceTenancy(toWorkspaceId);
  if (!target) {
    throw new TransferError(`Workspace "${toWorkspaceId}" not found`, 404, 'NOT_FOUND');
  }

  const crossOrg = device.organizationId !== target.organizationId;
  const blockers: TransferBlocker[] = [];
  const warnings: string[] = [];

  if (device.workspaceId === target.id) {
    blockers.push({
      code: 'SAME_WORKSPACE',
      message: 'The device is already in that workspace.',
    });
  }

  // The unique index is (workspace_id, serial), so a device whose serial already
  // exists in the destination cannot land there. Caught here so it is a 409 the
  // operator can act on rather than a unique-violation 500.
  const collision = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.workspaceId, target.id),
        eq(schema.devices.serial, device.serial),
        ne(schema.devices.id, device.id),
      ),
    )
    .limit(1);
  if (collision.length > 0) {
    blockers.push({
      code: 'SERIAL_COLLISION',
      message:
        `A device with serial "${device.serial}" already exists in the destination ` +
        'workspace. Serials are unique per workspace.',
    });
  }

  await reconcileStaleTransfers(deviceId);
  if (await transferInProgress(deviceId)) {
    blockers.push({
      code: 'TRANSFER_IN_PROGRESS',
      message: 'Another transfer of this device is already in progress.',
    });
  }

  const workflowAttachments = crossOrg
    ? await orphanedAttachments(deviceId, target.organizationId)
    : [];

  const [runningWorkflowRuns, openMediaSessions, staleSessionTokens, kvsChannels] =
    await Promise.all([
      countRows(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.workflowRuns)
          .where(
            and(
              eq(schema.workflowRuns.deviceId, deviceId),
              eq(schema.workflowRuns.status, 'running'),
            ),
          ),
      ),
      countRows(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.mediaSessions)
          .where(
            and(
              eq(schema.mediaSessions.deviceId, deviceId),
              eq(schema.mediaSessions.status, 'open'),
            ),
          ),
      ),
      countRows(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.sessionTokens)
          .where(
            and(
              eq(schema.sessionTokens.workspaceId, device.workspaceId),
              sql`${schema.sessionTokens.revokedAt} is null`,
              sql`${schema.sessionTokens.expiresAt} > now()`,
            ),
          ),
      ),
      countRows(
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.kvsChannels)
          .where(eq(schema.kvsChannels.deviceId, deviceId)),
      ),
    ]);

  if (device.status !== 'online') {
    warnings.push(
      'The device is not currently online. The transfer still completes — the new ' +
        'tenancy is staged in the cloud and the device adopts it the moment it next ' +
        'connects. Nothing on the device changes and no site visit is needed.',
    );
  }
  if (crossOrg) {
    warnings.push(
      'All historical telemetry and all recorded footage are stored against the ' +
        'device and move with it to the destination organization. Nothing is purged.',
    );
  }
  if (workflowAttachments.length > 0) {
    warnings.push(
      `${workflowAttachments.length} workflow attachment(s) will be detached: ` +
        `${workflowAttachments.map((a) => a.templateName).join(', ')}. The templates ` +
        'belong to the source organization and the destination cannot see them.',
    );
  }
  if (runningWorkflowRuns > 0) {
    warnings.push(
      `${runningWorkflowRuns} workflow run(s) are executing and are left to finish. ` +
        'Their history stays with the organization that started them.',
    );
  }
  if (staleSessionTokens > 0) {
    warnings.push(
      `${staleSessionTokens} live session token(s) are scoped to the source workspace ` +
        'and will stop seeing this device. They are not revoked.',
    );
  }

  return {
    deviceId,
    deviceName: device.name,
    serial: device.serial,
    from: {
      workspaceId: device.workspaceId,
      workspaceName: device.workspaceName,
      organizationId: device.organizationId,
      organizationName: device.organizationName,
    },
    to: {
      workspaceId: target.id,
      workspaceName: target.name,
      organizationId: target.organizationId,
      organizationName: target.organizationName,
    },
    crossOrg,
    workflowAttachments,
    runningWorkflowRuns,
    openMediaSessions,
    staleSessionTokens,
    kvsChannels,
    carriesHistory: true,
    blockers,
    warnings,
  };
}

/**
 * Move a device to another workspace, completely and in the right order.
 *
 * Callers are responsible for AUTHORIZATION — this function checks that the
 * transfer is possible, never that it is permitted. The same-org route proves
 * the caller owns both ends through `resolveWorkspaceScope`; the offer-accept
 * route proves it with the offer code plus a destination-org role check.
 *
 * Throws `TransferError` from pre-flight only. Once the sequence begins it
 * returns a summary — including for a partial failure, whose shape is in
 * `warnings` and in the `device_transfers` row, because "the device moved but
 * the broker was not told" is information a caller has to act on and an
 * exception cannot carry.
 */
export async function transferDevice(input: TransferInput): Promise<TransferSummary> {
  const { deviceId, toWorkspaceId, actor } = input;

  // ---- 1. Pre-flight. Everything that can refuse, before anything is written.
  const preview = await previewTransfer(deviceId, toWorkspaceId);
  const blocker = preview.blockers[0];
  if (blocker) {
    const status =
      blocker.code === 'SAME_WORKSPACE'
        ? 400
        : blocker.code === 'TRANSFER_IN_PROGRESS' || blocker.code === 'SERIAL_COLLISION'
          ? 409
          : 400;
    throw new TransferError(blocker.message, status, blocker.code);
  }

  const from = { workspaceId: preview.from.workspaceId, organizationId: preview.from.organizationId };
  const to = { workspaceId: preview.to.workspaceId, organizationId: preview.to.organizationId };
  const warnings = [...preview.warnings];

  const [transfer] = await db
    .insert(schema.deviceTransfers)
    .values({
      deviceId,
      fromWorkspaceId: from.workspaceId,
      toWorkspaceId: to.workspaceId,
      fromOrganizationId: from.organizationId,
      toOrganizationId: to.organizationId,
      actorUserId: actor.userId ?? null,
      actorApiKeyId: actor.apiKeyId ?? null,
      offerId: input.offerId ?? null,
    })
    .returning();
  const transferId = transfer!.id;

  const fail = async (stage: string, err: unknown): Promise<never> => {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.deviceTransfers)
      .set({ status: 'failed', stage, error: message, completedAt: new Date() })
      .where(eq(schema.deviceTransfers.id, transferId))
      .catch(() => undefined);
    throw err;
  };

  // ---- 2. The DB write. Guarded on the CURRENT workspace so a concurrent
  // transfer of the same device cannot double-apply, and returning the row so
  // step 3 publishes the exact config and rev that are now stored.
  let device;
  try {
    const updated = await db.transaction(async (tx) =>
      tx
        .update(schema.devices)
        .set({ workspaceId: to.workspaceId, updatedAt: new Date() })
        .where(
          and(
            eq(schema.devices.id, deviceId),
            eq(schema.devices.workspaceId, from.workspaceId),
          ),
        )
        .returning(),
    );
    if (updated.length === 0) {
      throw new TransferError(
        'The device moved while the transfer was being prepared; nothing was changed.',
        409,
        'CONCURRENT_MODIFICATION',
      );
    }
    device = updated[0]!;
  } catch (err) {
    await fail('db', err);
    throw err; // unreachable; keeps the control flow legible to the compiler
  }

  // ---- 3 + 4. Instruct, then authorize. NOTHING between them.
  //
  // The rev is the device's CURRENT `config_rev`, deliberately unbumped: the
  // agent applies `scope` outside its rev guard, and bumping it would arm the
  // reconciler's republish-on-every-report loop for a device that cannot
  // converge. `precheck: false` is for this call site ONLY — the transfer
  // already knows the attributes are changing, so the DescribeThing has no
  // answer to give and would sit inside the window that must not straddle a slow
  // call. Everywhere else the precheck stays on, or it is exactly the
  // unconditional UpdateThing that turned one stuck device into a storm.
  let scopeAttributes: ScopeAttributeResult = 'failed';
  try {
    const scope = await publishDeviceConfigOnly(deviceId, device.config, device.configRev);
    if (!scope) {
      // Unreachable in practice — the row was just written and joined — but a
      // null scope would publish a message telling the device it has no tenant.
      throw new Error('device scope could not be resolved immediately after the move');
    }
    // No `stage: 'published'` write here, deliberately. Recording the
    // intermediate stage would be a Data API round trip sitting in the one
    // window README §2.2 says must not straddle a slow call — the 2026-09-18
    // measurement was a 12 s gap costing ~6 s of flapping against <1 s when the
    // two calls are adjacent. Nothing is lost by omitting it: the sweep's repair
    // re-runs BOTH steps and is idempotent, so it never needed to know which of
    // the two had landed.
    scopeAttributes = await ensureThingScopeAttributes(deviceId, scope, { precheck: false });
  } catch (err) {
    // The publish failed, so the device was never told. NOTHING has been
    // authorized — the attribute write is the only thing that could strand a
    // running agent and it has not happened — so the safe move is to put the
    // tenancy back and report that nothing changed. A half-applied transfer
    // nobody can see is worse than a clean failure the operator can retry.
    await db
      .update(schema.devices)
      .set({ workspaceId: from.workspaceId, updatedAt: new Date() })
      .where(eq(schema.devices.id, deviceId))
      .catch((rollbackErr) => {
        console.error('[device-transfer] ROLLBACK FAILED', { deviceId, transferId, rollbackErr });
      });
    // Best-effort: if the failed publish actually landed, this puts the device
    // back on the topic it is still authorized for.
    await publishDeviceConfigOnly(deviceId, device.config, device.configRev).catch(
      () => undefined,
    );
    await fail('publish', err);
    throw err;
  }

  if (scopeAttributes === 'failed') {
    // A degraded success, not a failure. The ownership change is complete and
    // authoritative; what did not happen is the ENFORCEMENT half, so the device
    // is refused on the scoped topic and (on agent v0.0.6+) falls back to the
    // unscoped telemetry plane, which is still ingested by
    // `xorgate_telemetry_ingest`. The next config save re-asserts the attributes
    // through the attributes-first path, which is correct there because the
    // tenancy already matches the row.
    warnings.push(
      'The device moved, but its IoT tenancy attributes could not be written. It ' +
        'will publish on the legacy (unscoped) telemetry plane until they are — ' +
        'saving any setting on the device repairs this. Workspace-scoped ' +
        'credentials will not see its telemetry in the meantime.',
    );
  }

  await db
    .update(schema.deviceTransfers)
    .set({ stage: 'attributes', scopeAttributes })
    .where(eq(schema.deviceTransfers.id, transferId));

  // ---- 5. Re-tag the KVS channels eagerly.
  //
  // `ensureChannelTags` already runs on every live-credential vend and would
  // reconcile this by itself, but only when someone next asks to watch video.
  // Calling it here closes the window rather than leaving it open until a viewer
  // happens to appear. It writes BOTH the org and the workspace tag, so it
  // covers the cross-org case, and it swallows its own failures — a channel that
  // could not be re-tagged fails CLOSED (invisible to scoped credentials) rather
  // than leaking to the old tenant.
  let kvsChannelsRetagged = 0;
  try {
    kvsChannelsRetagged = await ensureChannelTags([from.workspaceId, to.workspaceId]);
  } catch (err) {
    console.warn('[device-transfer] channel re-tag failed', { deviceId, err });
    warnings.push(
      'Video channel tags could not be updated. Video stays unavailable to ' +
        'workspace-scoped credentials until the next live-credential request repairs it.',
    );
  }

  // ---- 6. The cross-org sweep.
  const detachedWorkflowAttachments: string[] = [];
  if (preview.crossOrg && preview.workflowAttachments.length > 0) {
    const ids = preview.workflowAttachments.map((a) => a.id);
    try {
      // `workflow_trigger_state` cascades off the attachment; `workflow_runs`
      // keeps its history through `attachment_id ON DELETE SET NULL`, which is
      // the existing detach contract and is what we want — the runs happened.
      await db
        .delete(schema.workflowAttachments)
        .where(inArray(schema.workflowAttachments.id, ids));
      detachedWorkflowAttachments.push(
        ...preview.workflowAttachments.map((a) => a.templateName),
      );
    } catch (err) {
      console.warn('[device-transfer] attachment detach failed', { deviceId, err });
      warnings.push(
        'Workflow attachments pointing at the source organization\'s templates could ' +
          'not be detached. They will keep firing against templates the new owner ' +
          'cannot see; detach them by hand.',
      );
    }
  }

  // ---- 7. Close the audit row.
  // Re-read rather than reusing the pre-flight snapshot: a report can land
  // between pre-flight and here, and `adoption` is the one field a caller reads
  // as "has the DEVICE caught up", so it has to be as fresh as we can make it.
  const adoption = transferAdoption(await currentReportedConfig(deviceId), to);
  await db
    .update(schema.deviceTransfers)
    .set({
      status: 'completed',
      stage: 'swept',
      detachedWorkflowAttachments,
      warnings,
      completedAt: new Date(),
    })
    .where(eq(schema.deviceTransfers.id, transferId));

  // One structured line per transfer: the audit trail in the logs, matching
  // `device-teardown`'s. `scopeAttributes` and `adoption` are the two fields
  // worth grepping for when someone asks why a transferred device is quiet.
  console.log(
    '[device-transfer]',
    JSON.stringify({
      transferId,
      deviceId,
      from,
      to,
      crossOrg: preview.crossOrg,
      scopeAttributes,
      kvsChannelsRetagged,
      detachedWorkflowAttachments,
      adoption,
      warnings,
    }),
  );

  return {
    transferId,
    deviceId,
    from,
    to,
    crossOrg: preview.crossOrg,
    detachedWorkflowAttachments,
    kvsChannelsRetagged,
    scopeAttributes,
    adoption,
    warnings,
  };
}

/** The device's latest report, re-read so `adoption` reflects the moment of the move. */
async function currentReportedConfig(
  deviceId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ reportedConfig: schema.devices.reportedConfig })
    .from(schema.devices)
    .where(eq(schema.devices.id, deviceId))
    .limit(1);
  return rows[0]?.reportedConfig ?? null;
}
