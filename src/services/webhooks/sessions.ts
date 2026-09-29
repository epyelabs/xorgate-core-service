import { eq, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db/index';
import { isoSql } from '../../utils/sql';
import { emitWebhookEvent, type EmitWebhookEventArgs, type WebhookDb } from './emit';

/**
 * Session lifecycle webhooks (xorgate-webhooks Phase 3, README §4, D2, D3).
 *
 * Five events, all routed per device through `webhook_routes` (fan-out reads
 * `data.deviceId`), all written to the outbox in the same transaction as the
 * state change that detected them:
 *
 * - `*_session.started`: the ingest's session INSERT returned a row, i.e. this
 *   call created the session ("first segment ingested", not "recording began").
 * - `*_session.ended`: the advisory close flipped the row open -> closed.
 * - `telemetry_session.completed`: the `completed_fired_at` claim, once the
 *   overview and insights are built.
 *
 * A straggler segment reopens a closed session; the next close emits a NEW
 * `ended` (the key carries `last_segment_at`) with `reopened: true`, and a new
 * `completed` after it. The backfill (`reconcileTelemetryIndex`) creates
 * sessions already closed and never emits `started` or `ended`; `completed`
 * is emitted only for a close that emitted its `ended` (see
 * `emitTelemetrySessionCompleted`), so a backfilled session emits nothing at all.
 *
 * `organizationId` / `workspaceId` are resolved at emit time from
 * `devices.workspace_id` (a transfer moves the device). The close statements
 * return them as scalar subqueries, so a pass costs no extra round trip per
 * row. A device with no workspace cannot be routed: skipped with a log line,
 * like presence.
 */

// ---- dedupe keys (the P1 conventions; ISO = toISOString() shape) ----------

export const mediaStartedKey = (sessionId: string): string => `media_session:${sessionId}:started`;
export const mediaEndedKey = (sessionId: string, lastSegmentAt: string): string =>
  `media_session:${sessionId}:ended:${lastSegmentAt}`;
export const telemetryStartedKey = (sessionId: string): string => `telemetry_session:${sessionId}:started`;
export const telemetryEndedKey = (sessionId: string, lastSegmentAt: string): string =>
  `telemetry_session:${sessionId}:ended:${lastSegmentAt}`;
export const telemetryCompletedKey = (sessionId: string, completedFiredAt: string): string =>
  `telemetry_session:${sessionId}:completed:${completedFiredAt}`;

// ---- scope ----------------------------------------------------------------

export interface SessionScope {
  organizationId: string | null;
  workspaceId: string | null;
}

/**
 * The device's tenant, on the caller's handle (inside the ingest transaction).
 * Same join as `deviceScope()` in services/device-scope.ts, which cannot take
 * a `tx` and pulls in the IoT client.
 */
export async function sessionScope(dbx: WebhookDb, deviceId: string): Promise<SessionScope> {
  const rows = await dbx
    .select({ workspaceId: schema.devices.workspaceId, organizationId: schema.workspaces.organizationId })
    .from(schema.devices)
    .leftJoin(schema.workspaces, eq(schema.devices.workspaceId, schema.workspaces.id))
    .where(eq(schema.devices.id, deviceId))
    .limit(1);
  return { organizationId: rows[0]?.organizationId ?? null, workspaceId: rows[0]?.workspaceId ?? null };
}

/** `workspace_id` + `organization_id` of the row's device, as RETURNING / SELECT columns. */
export const scopeColumnsSql = (deviceIdCol: SQL): SQL => sql`
  (SELECT dv.workspace_id FROM devices dv WHERE dv.id = ${deviceIdCol}) AS workspace_id,
  (SELECT w.organization_id FROM devices dv JOIN workspaces w ON w.id = dv.workspace_id WHERE dv.id = ${deviceIdCol}) AS organization_id`;

function unroutable(type: string, sessionId: string, deviceId: string): null {
  console.warn('session-webhooks: device has no workspace, event not emitted', { type, sessionId, deviceId });
  return null;
}

// ---- started ----------------------------------------------------------------

export interface MediaStartedInput {
  sessionId: string;
  deviceId: string;
  streamKey: string;
  startedAt: Date;
  timeSource: string | null;
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  /** The seq of the segment that created the session; not necessarily 0. */
  firstSeq: number;
}

export function mediaStartedData(s: MediaStartedInput): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    deviceId: s.deviceId,
    streamKey: s.streamKey,
    startedAt: s.startedAt.toISOString(),
    timeSource: s.timeSource,
    codec: s.codec,
    width: s.width,
    height: s.height,
    fps: s.fps,
    firstSeq: s.firstSeq,
  };
}

/** Inside the media ingest transaction, only when the session INSERT returned a row. */
export async function emitMediaSessionStarted(dbx: WebhookDb, s: MediaStartedInput): Promise<string | null> {
  const scope = await sessionScope(dbx, s.deviceId);
  if (!scope.organizationId) return unroutable('media_session.started', s.sessionId, s.deviceId);
  return emitWebhookEvent(dbx, {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    type: 'media_session.started',
    dedupeKey: mediaStartedKey(s.sessionId),
    data: mediaStartedData(s),
  });
}

export interface TelemetryStartedInput {
  sessionId: string;
  deviceId: string;
  startedAt: Date;
  rateHz: number | null;
  timeSource: string | null;
}

export function telemetryStartedData(s: TelemetryStartedInput): Record<string, unknown> {
  return {
    sessionId: s.sessionId,
    deviceId: s.deviceId,
    startedAt: s.startedAt.toISOString(),
    rateHz: s.rateHz,
    timeSource: s.timeSource,
  };
}

/** Inside the telemetry ingest transaction, only when `indexSegment` reports `created`. */
export async function emitTelemetrySessionStarted(dbx: WebhookDb, s: TelemetryStartedInput): Promise<string | null> {
  const scope = await sessionScope(dbx, s.deviceId);
  if (!scope.organizationId) return unroutable('telemetry_session.started', s.sessionId, s.deviceId);
  return emitWebhookEvent(dbx, {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    type: 'telemetry_session.started',
    dedupeKey: telemetryStartedKey(s.sessionId),
    data: telemetryStartedData(s),
  });
}

// ---- ended: media -----------------------------------------------------------

/** One row of `mediaCloseSql`'s RETURNING (snake_case from SQL; ISO strings). */
export interface MediaClosedRow {
  id: string;
  device_id: string;
  stream_key: string;
  started_at: string;
  ended_at: string | null;
  last_segment_at: string;
  reopened: boolean;
  segment_count: number | string;
  total_bytes: number | string;
  total_duration_ms: number | string;
  workspace_id: string | null;
  organization_id: string | null;
}

/**
 * The media advisory close as ONE statement: flip every stale open row to
 * closed, stamp `ended_fired_at`, and return what the event needs, including
 * the PREVIOUS `ended_fired_at` (read through the locked subquery; Aurora is
 * PostgreSQL 17, no `RETURNING OLD`) and the segment rollups.
 *
 * `FOR UPDATE SKIP LOCKED`: the sweeper and a close-on-read (API Lambda) can
 * run at once; each row is closed by exactly one of them, and a row an ingest
 * is reopening right now is left for the next pass. The outer
 * `m.status = 'open'` is belt and braces.
 */
export function mediaCloseSql(staleSecs: number, deviceId?: string): SQL {
  const secs = sql.raw(String(Math.max(0, Math.round(staleSecs))));
  return sql`
    UPDATE media_sessions m
    SET status = 'closed', ended_fired_at = now()
    FROM (
      SELECT id, ended_fired_at AS prev_fired FROM media_sessions
      WHERE status = 'open'
        ${deviceId ? sql`AND device_id = ${deviceId}::uuid` : sql``}
        AND coalesce(last_segment_at, created_at) < now() - make_interval(secs => ${secs})
      FOR UPDATE SKIP LOCKED
    ) c
    WHERE m.id = c.id AND m.status = 'open'
    RETURNING m.id, m.device_id, m.stream_key,
      ${isoSql(sql`m.started_at`)} AS started_at,
      ${isoSql(sql`m.ended_at`)} AS ended_at,
      ${isoSql(sql`coalesce(m.last_segment_at, m.created_at)`)} AS last_segment_at,
      (c.prev_fired IS NOT NULL) AS reopened,
      (SELECT count(*)::int FROM media_segments s WHERE s.session_id = m.id) AS segment_count,
      (SELECT coalesce(sum(s.size_bytes), 0)::bigint FROM media_segments s WHERE s.session_id = m.id) AS total_bytes,
      (SELECT coalesce(sum(s.duration_ms), 0)::bigint FROM media_segments s WHERE s.session_id = m.id) AS total_duration_ms,
      ${scopeColumnsSql(sql`m.device_id`)}
  `;
}

export function mediaEndedData(r: MediaClosedRow): Record<string, unknown> {
  return {
    sessionId: r.id,
    deviceId: r.device_id,
    streamKey: r.stream_key,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    lastSegmentAt: r.last_segment_at,
    segmentCount: Number(r.segment_count),
    totalBytes: Number(r.total_bytes),
    totalDurationMs: Number(r.total_duration_ms),
    reopened: Boolean(r.reopened),
  };
}

export function mediaEndedEvents(rows: ReadonlyArray<MediaClosedRow>): EmitWebhookEventArgs[] {
  const out: EmitWebhookEventArgs[] = [];
  for (const r of rows) {
    if (!r.organization_id) {
      unroutable('media_session.ended', r.id, r.device_id);
      continue;
    }
    out.push({
      organizationId: r.organization_id,
      workspaceId: r.workspace_id,
      type: 'media_session.ended',
      dedupeKey: mediaEndedKey(r.id, r.last_segment_at),
      data: mediaEndedData(r),
    });
  }
  return out;
}

// ---- ended: telemetry -------------------------------------------------------

export interface TelemetryClosedRow {
  id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  last_segment_at: string;
  reopened: boolean;
  segment_count: number | string;
  sample_count: number | string;
  byte_count: number | string;
  workspace_id: string | null;
  organization_id: string | null;
}

/**
 * The telemetry advisory close as ONE statement (same shape and locking as
 * `mediaCloseSql`). `reopened` = the session has fired `completed` before
 * (`completed_fired_at` is not touched by the close, so RETURNING shows the
 * previous value); that is the phase file's "has ended before" signal and
 * needs no column of its own.
 */
export function telemetryCloseSql(staleSecs: number, deviceId?: string): SQL {
  const secs = sql.raw(String(Math.max(0, Math.round(staleSecs))));
  return sql`
    UPDATE telemetry_sessions t
    SET status = 'closed', updated_at = now()
    FROM (
      SELECT id FROM telemetry_sessions
      WHERE status = 'open'
        ${deviceId ? sql`AND device_id = ${deviceId}::uuid` : sql``}
        AND last_segment_at < now() - make_interval(secs => ${secs})
      FOR UPDATE SKIP LOCKED
    ) c
    WHERE t.id = c.id AND t.status = 'open'
    RETURNING t.id, t.device_id,
      ${isoSql(sql`t.started_at`)} AS started_at,
      ${isoSql(sql`t.ended_at`)} AS ended_at,
      ${isoSql(sql`t.last_segment_at`)} AS last_segment_at,
      (t.completed_fired_at IS NOT NULL) AS reopened,
      t.segment_count, t.sample_count, t.byte_count,
      ${scopeColumnsSql(sql`t.device_id`)}
  `;
}

export function telemetryEndedData(r: TelemetryClosedRow): Record<string, unknown> {
  return {
    sessionId: r.id,
    deviceId: r.device_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    lastSegmentAt: r.last_segment_at,
    segmentCount: Number(r.segment_count),
    sampleCount: Number(r.sample_count),
    byteCount: Number(r.byte_count),
    reopened: Boolean(r.reopened),
  };
}

export function telemetryEndedEvents(rows: ReadonlyArray<TelemetryClosedRow>): EmitWebhookEventArgs[] {
  const out: EmitWebhookEventArgs[] = [];
  for (const r of rows) {
    if (!r.organization_id) {
      unroutable('telemetry_session.ended', r.id, r.device_id);
      continue;
    }
    out.push({
      organizationId: r.organization_id,
      workspaceId: r.workspace_id,
      type: 'telemetry_session.ended',
      dedupeKey: telemetryEndedKey(r.id, r.last_segment_at),
      data: telemetryEndedData(r),
    });
  }
  return out;
}

// ---- completed --------------------------------------------------------------

export interface TelemetryCompletedInput {
  id: string;
  deviceId: string;
  organizationId: string | null;
  workspaceId: string | null;
  /** ISO strings in the toISOString() shape (from SQL, so the keys match the `ended` row's). */
  startedAtIso: string;
  endedAtIso: string | null;
  lastSegmentAtIso: string;
  segmentCount: number;
  sampleCount: number | string;
  byteCount: number | string;
  insights: unknown;
  distanceM: number | null;
  durationMs: number | string | null;
  maxSpeedKph: number | null;
  /** `completed_fired_at` BEFORE this claim: non-null = a reopened session completing again. */
  previousCompletedFiredAt: string | null;
}

/**
 * The replay manifest over the session's recorded span: its
 * `telemetry.sessions[]` entry carries the overview (presigned per request).
 * `?sessionId=` would not do: that parameter takes a MEDIA session id.
 */
export function overviewApiPath(deviceId: string, startedAtIso: string, endedAtIso: string | null): string {
  const fromMs = Date.parse(startedAtIso);
  const endMs = endedAtIso ? Date.parse(endedAtIso) : fromMs;
  // The manifest needs from < to; a one-sample session gets a 1 s window.
  const to = new Date(Math.max(endMs, fromMs + 1000)).toISOString();
  const qs = new URLSearchParams({ from: startedAtIso, to });
  return `/v1/devices/${deviceId}/replay-manifest?${qs.toString()}`;
}

export function telemetryCompletedData(s: TelemetryCompletedInput): Record<string, unknown> {
  return {
    sessionId: s.id,
    deviceId: s.deviceId,
    startedAt: s.startedAtIso,
    endedAt: s.endedAtIso,
    lastSegmentAt: s.lastSegmentAtIso,
    segmentCount: Number(s.segmentCount),
    sampleCount: Number(s.sampleCount),
    byteCount: Number(s.byteCount),
    reopened: s.previousCompletedFiredAt !== null,
    insights: s.insights ?? null,
    distanceM: s.distanceM ?? null,
    durationMs: s.durationMs === null || s.durationMs === undefined ? null : Number(s.durationMs),
    maxSpeedKph: s.maxSpeedKph ?? null,
    overview: { apiPath: overviewApiPath(s.deviceId, s.startedAtIso, s.endedAtIso) },
  };
}

/**
 * The `completed` outbox row for one claimed session, on the claim's `tx`.
 *
 * Emitted only when this close emitted its `ended` (the row with key
 * `telemetryEndedKey(id, last_segment_at)` exists). That is what keeps the
 * backfill silent: `reconcileTelemetryIndex` creates sessions already
 * closed, so no close ever emits their `ended`, and the housekeeping pass that
 * builds their overview would otherwise emit a `completed` for history. The
 * same rule skips sessions that closed before Phase 3 was deployed. Workflow
 * triggers are unaffected (they keep firing for every claim, as before).
 */
export async function emitTelemetrySessionCompleted(
  dbx: WebhookDb,
  s: TelemetryCompletedInput,
  completedFiredAtIso: string,
): Promise<string | null> {
  if (!s.organizationId) return unroutable('telemetry_session.completed', s.id, s.deviceId);
  const ended = await dbx
    .select({ id: schema.webhookEvents.id })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.dedupeKey, telemetryEndedKey(s.id, s.lastSegmentAtIso)))
    .limit(1);
  if (ended.length === 0) return null;
  return emitWebhookEvent(dbx, {
    organizationId: s.organizationId,
    workspaceId: s.workspaceId,
    type: 'telemetry_session.completed',
    dedupeKey: telemetryCompletedKey(s.id, completedFiredAtIso),
    data: telemetryCompletedData(s),
  });
}
