import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index';
import { isoSql } from '../utils/sql';
import { dispatchWebhookEvents, emitWebhookEvent, type WebhookDb } from './webhooks/emit';

/**
 * Device presence edges (xorgate-webhooks Phase 2, README D6).
 *
 * `devices.status` has four writers. Each is now a conditional UPDATE that
 * also stamps `status_changed_at` and RETURNs only the rows it actually
 * flipped, so exactly one writer sees each transition and emits exactly one
 * `device.online` / `device.offline` outbox row (dedupe key
 * `device:<id>:<online|offline>:<status_changed_at ISO>`).
 *
 * Aurora is PostgreSQL 17 (no `RETURNING OLD`), so the →online claim reads the
 * previous status through `UPDATE … FROM (SELECT … FOR UPDATE)`: the row lock
 * makes a concurrent claimer wait and then re-check its WHERE against the new
 * row version, so only one of them sees `offline|provisioned` as the previous
 * status. The heartbeat bump and the claim are ONE statement, which keeps the
 * 1 Hz telemetry path at the statement count it had before (zero rows in
 * steady state, one row every 15 s for the throttled bump).
 */

export type OnlineSource = 'connect' | 'telemetry';
export type OfflineSource = 'graceful' | 'lwt' | 'sweeper';

/** One flipped row, as the claim statements return it (snake_case from SQL). */
interface EdgeRow {
  id: string;
  workspace_id: string | null;
  organization_id: string | null;
  serial: string;
  name: string | null;
  status: string;
  previous_status: string;
  status_changed_at: string;
  last_seen_at: string | null;
}

export interface PresenceEdge {
  deviceId: string;
  workspaceId: string | null;
  organizationId: string | null;
  serial: string;
  name: string | null;
  status: 'online' | 'offline';
  previousStatus: string;
  /** ISO string with ms precision, identical to `Date#toISOString()`. */
  statusChangedAt: string;
  lastSeenAt: string | null;
  source: OnlineSource | OfflineSource;
}

/** timestamptz -> the exact `toISOString()` shape, computed in SQL (no TZ games on the Data API). */
const iso = isoSql;

const HEARTBEAT_THROTTLE = sql`interval '15 seconds'`;

/**
 * Heartbeat + →online claim in one statement.
 *
 * `throttle: true` (telemetry, 1 Hz) keeps the old behaviour of bumping
 * `last_seen_at` at most every 15 s, but a device that is not `online` is
 * always matched so the edge is never throttled away. `throttle: false`
 * (the connect message) always bumps. Decommissioned rows get the bump but
 * never change status (as before).
 */
export function onlineClaimSql(deviceId: string, opts: { throttle: boolean }): SQL {
  const due = opts.throttle
    ? sql`(last_seen_at IS NULL OR last_seen_at < now() - ${HEARTBEAT_THROTTLE} OR status IN ('offline', 'provisioned'))`
    : sql`true`;
  return sql`
    UPDATE devices d
    SET last_seen_at = now(),
        status = CASE WHEN p.prev = 'decommissioned' THEN p.prev ELSE 'online' END,
        status_changed_at = CASE WHEN p.prev IN ('offline', 'provisioned') THEN now() ELSE d.status_changed_at END,
        updated_at = now()
    FROM (
      SELECT id, status AS prev FROM devices
      WHERE id = ${deviceId}::uuid AND ${due}
      FOR UPDATE
    ) p
    WHERE d.id = p.id
    RETURNING d.id, d.workspace_id,
      (SELECT w.organization_id FROM workspaces w WHERE w.id = d.workspace_id) AS organization_id,
      d.serial, d.name, d.status, p.prev AS previous_status,
      ${iso(sql`d.status_changed_at`)} AS status_changed_at,
      ${iso(sql`d.last_seen_at`)} AS last_seen_at
  `;
}

/**
 * online→offline claim. `deviceId` for the status topic (one device); omit it
 * for the sweeper, which flips every `online` row whose `last_seen_at` is older
 * than `staleSecs`.
 */
export function offlineClaimSql(target: { deviceId: string } | { staleSecs: number }): SQL {
  const where =
    'deviceId' in target
      ? sql`id = ${target.deviceId}::uuid`
      : sql`(last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => ${sql.raw(String(Math.max(0, Math.round(target.staleSecs))))}))`;
  return sql`
    UPDATE devices d
    SET status = 'offline', status_changed_at = now(), updated_at = now()
    WHERE ${where} AND status = 'online'
    RETURNING d.id, d.workspace_id,
      (SELECT w.organization_id FROM workspaces w WHERE w.id = d.workspace_id) AS organization_id,
      d.serial, d.name, d.status, 'online' AS previous_status,
      ${iso(sql`d.status_changed_at`)} AS status_changed_at,
      ${iso(sql`d.last_seen_at`)} AS last_seen_at
  `;
}

/** Rows the claim returned that are real edges (the online claim also returns plain bumps). */
export function edgesFrom(
  rows: ReadonlyArray<EdgeRow> | undefined,
  source: OnlineSource | OfflineSource,
): PresenceEdge[] {
  const out: PresenceEdge[] = [];
  for (const r of rows ?? []) {
    const status = r.status === 'online' || r.status === 'offline' ? r.status : null;
    if (!status || r.previous_status === status) continue;
    if (status === 'online' && r.previous_status !== 'offline' && r.previous_status !== 'provisioned') continue;
    out.push({
      deviceId: r.id,
      workspaceId: r.workspace_id ?? null,
      organizationId: r.organization_id ?? null,
      serial: r.serial,
      name: r.name ?? null,
      status,
      previousStatus: r.previous_status,
      statusChangedAt: r.status_changed_at,
      lastSeenAt: r.last_seen_at ?? null,
      source,
    });
  }
  return out;
}

export function presenceDedupeKey(edge: Pick<PresenceEdge, 'deviceId' | 'status' | 'statusChangedAt'>): string {
  return `device:${edge.deviceId}:${edge.status}:${edge.statusChangedAt}`;
}

export function presenceEventData(edge: PresenceEdge): Record<string, unknown> {
  return {
    deviceId: edge.deviceId,
    serial: edge.serial,
    name: edge.name,
    status: edge.status,
    previousStatus: edge.previousStatus,
    lastSeenAt: edge.lastSeenAt,
    source: edge.source,
  };
}

/**
 * Write one outbox row per edge on `dbx` (a `tx` when the caller has one).
 * An edge whose device has no workspace (so no org) cannot be routed and is
 * skipped with a log line. Sequential awaits (Data API).
 */
export async function emitPresenceEdges(dbx: WebhookDb, edges: ReadonlyArray<PresenceEdge>): Promise<string[]> {
  const ids: string[] = [];
  for (const edge of edges) {
    if (!edge.organizationId) {
      console.warn('device-presence: edge on a device with no workspace, not emitted', {
        deviceId: edge.deviceId,
        status: edge.status,
      });
      continue;
    }
    const id = await emitWebhookEvent(dbx, {
      organizationId: edge.organizationId,
      workspaceId: edge.workspaceId,
      type: edge.status === 'online' ? 'device.online' : 'device.offline',
      dedupeKey: presenceDedupeKey(edge),
      data: presenceEventData(edge),
    });
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Claim + emit in ONE transaction (the status topic and the sweeper: not hot,
 * so the extra Begin/Commit calls are fine), then dispatch after commit. A
 * failed emit rolls the claim back and throws, so the invoker's retry sees the
 * edge again: no committed transition without its outbox row.
 */
export async function claimAndEmitPresence(
  claim: SQL,
  source: OnlineSource | OfflineSource,
): Promise<PresenceEdge[]> {
  const { edges, ids } = await db.transaction(async (tx) => {
    const res = await tx.execute<EdgeRow & Record<string, unknown>>(claim);
    const edges = edgesFrom(res?.rows, source);
    const ids = await emitPresenceEdges(tx, edges);
    return { edges, ids };
  });
  await dispatchWebhookEvents(ids);
  return edges;
}

/**
 * The 1 Hz variant: the claim runs on `db` with no transaction (a Begin/Commit
 * pair per frame is not acceptable on the hot path). Only an edge row pays
 * for the outbox insert and SendMessage. The residual window (the Lambda dies
 * between the claim and the insert) loses that one event; it is logged, not
 * retried, because a retry would find the device already online.
 */
export async function claimOnlineFromTelemetry(deviceId: string): Promise<PresenceEdge[]> {
  const res = await db.execute<EdgeRow & Record<string, unknown>>(onlineClaimSql(deviceId, { throttle: true }));
  const edges = edgesFrom(res?.rows, 'telemetry');
  if (edges.length === 0) return edges;
  try {
    const ids = await emitPresenceEdges(db, edges);
    await dispatchWebhookEvents(ids);
  } catch (err) {
    console.error('device-presence: device.online emit failed after the claim committed (event lost)', {
      deviceId,
      statusChangedAt: edges[0]?.statusChangedAt,
      err,
    });
  }
  return edges;
}

/** Status-topic `online:false` source: the LWT carries the CONNECT time as `ts`. */
export const LWT_MIN_AGE_MS = 30_000;
export function offlineSourceFor(ts: number | undefined, now: number = Date.now()): OfflineSource {
  // A graceful stop stamps `ts` at shutdown (age ~0 s). The Last-Will was built
  // at connect and fires >= 1.5 x keepalive (~90 s) after the device went quiet,
  // so its `ts` is always older than that. No `ts` (very old agent): graceful.
  return typeof ts === 'number' && now - ts > LWT_MIN_AGE_MS ? 'lwt' : 'graceful';
}
