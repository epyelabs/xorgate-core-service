import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import * as realSchema from '../src/db/schema';

/**
 * disable_telemetry_recording (2026-08-04): `recording.telemetry.enabled` is the
 * master switch for telemetry history, and the on-device batch path is its SOLE
 * writer. The live 1 Hz plane therefore writes NO `telemetry_readings` row, ever —
 * not while recording is on (the batch path owns history), and not while it is off
 * (nothing should write). The former D4 authority split is gone with it.
 *
 * ⚠ The gate is history-only. `device_latest`, the throttled heartbeat and the
 * workflow triggers stay unconditional (destroy-kvs-recorder decision A). Gating
 * `device_latest` is exactly the 2026-07-27 bug: the old `persist_telemetry`
 * opted-out branch upserted only the `recording.*` / `media.recording` gauges, so
 * `lte.gnss_health` never landed and the GNSS health badge froze. The
 * "FULL row set" test below is that bug's standing regression guard.
 *
 * `db` is mocked because the handler talks to the RDS Data API; the real drizzle
 * schema is reused so any insert target would be the genuine table object.
 */

const insertValues = vi.fn(async () => undefined);
const insertInto = vi.fn(() => ({ values: insertValues }));
const execute = vi.fn(async () => undefined);
const findFirst = vi.fn(async () => undefined);

vi.mock('../src/db/index', () => ({
  db: {
    insert: insertInto,
    execute,
    query: { devices: { findFirst } },
  },
  schema: realSchema,
}));

// Keep the workflow hook inert — it is unrelated to persistence and would reach SQS.
vi.mock('../src/services/workflow-triggers', () => ({
  evaluateTelemetryTriggers: vi.fn(async () => undefined),
}));

const { handler } = await import('../src/handlers/telemetry-ingest');
const { evaluateTelemetryTriggers } = await import('../src/services/workflow-triggers');

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';

/**
 * A realistic 1 Hz payload carrying the GNSS-health metric the old opted-out
 * branch used to drop, plus an on-device `media.recording` gauge it did keep.
 * `metrics` is group -> field -> leaf; `ts` is epoch ms.
 */
function payload(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    deviceId: DEVICE,
    ts: Date.parse('2026-07-27T18:00:00.000Z'),
    topicDeviceId: DEVICE,
    metrics: {
      lte: { gnss_health: { value: 3 }, resets_24h: { value: 0 } },
      cpu: { temp: { value: 48.5, unit: '°C' } },
    },
    media: { recording: { value: true } },
    ...over,
  };
}

/** A full on-device recording status block (the D4 authority-split signal). */
function recordingStatus(enabled: boolean) {
  return {
    enabled,
    sessionId: null,
    backlogBytes: 0,
    backlogSegments: 0,
    droppedSegments: 0,
    uploading: false,
    lastUploadAt: null,
  };
}

/**
 * Flatten a drizzle `SQL` into inspectable text. `queryChunks` mixes StringChunks
 * (`.value` = string[]), bound Params (`.value` = the value) and nested SQL
 * fragments, so this recurses rather than assuming a flat shape.
 */
function sqlText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(sqlText).join(' ');
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.queryChunks)) return sqlText(o.queryChunks);
  if ('value' in o) return sqlText(o.value);
  return '';
}

/** Every SQL fragment passed to `db.execute`, flattened to inspectable text. */
function executedSql(): string[] {
  return execute.mock.calls.map((c) => sqlText(c[0] as unknown as SQL));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('telemetry-ingest: the live plane never writes telemetry history', () => {
  it('writes NO telemetry_readings row while recording is off', async () => {
    // The headline behaviour change. Recording off ⇒ nothing writes history at all:
    // the batch path is idle by definition and the live plane no longer stands in
    // for it. (This is the case the old `persist_telemetry = false` gate covered
    // and that decision A had turned back ON; it is off again, deliberately, and
    // now for the whole table rather than per device.)
    await handler(payload());

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('writes NO telemetry_readings row while recording is on either', async () => {
    // Recording on ⇒ the S3 segment → telemetry-batch-ingest path is the sole
    // writer. A live insert here would duplicate history; the tall/narrow table has
    // no unique key to catch it.
    await handler(payload({ recording: recordingStatus(true) }));

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('writes NO telemetry_readings row when the payload omits `recording` entirely', async () => {
    // `recording` is optional in the payload schema, so an older agent sends
    // nothing. There is no branch left to key off it — absent behaves like every
    // other case (README Q3).
    await handler(payload({ recording: undefined }));

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('never reads the persist_telemetry flag (the gate and its cache are gone)', async () => {
    await handler(payload());
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('upserts device_latest with the FULL row set, not just the recorder gauges', async () => {
    // ⚠ The 2026-07-27 regression guard. The old opted-out branch filtered
    // device_latest down to `recording.*` / `media.recording`, so gnss_health could
    // never land and the GNSS health badge froze. This plan's gate is history-only:
    // device_latest keeps the full row set with recording off.
    await handler(payload());

    const upserts = executedSql().filter((s) => s.includes('device_latest'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toContain('lte.gnss_health');
    expect(upserts[0]).toContain('lte.resets_24h');
    expect(upserts[0]).toContain('cpu.temp');
  });

  it('upserts device_latest with the FULL row set while recording is on, too', async () => {
    // The realtime plane is indifferent to the recording setting in both directions.
    await handler(payload({ recording: recordingStatus(true) }));

    const upserts = executedSql().filter((s) => s.includes('device_latest'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toContain('lte.gnss_health');
    expect(upserts[0]).toContain('cpu.temp');
  });

  it('keeps the heartbeat isolated from a device_latest upsert failure', async () => {
    // First `execute` is the device_latest upsert; the heartbeat is the next one.
    execute.mockRejectedValueOnce(new Error('data api throttled'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handler(payload())).resolves.toBeUndefined();

    // The heartbeat UPDATE must still have run despite the failed upsert.
    expect(executedSql().some((s) => s.includes('last_seen_at'))).toBe(true);
    err.mockRestore();
  });

  it('still runs the heartbeat and workflow triggers with recording off', async () => {
    // Neither is gated — the offline-sweeper would otherwise flip an actively
    // publishing device to 'offline', and payload-driven triggers must keep firing.
    await handler(payload());

    expect(executedSql().some((s) => s.includes('last_seen_at'))).toBe(true);
    expect(evaluateTelemetryTriggers).toHaveBeenCalledTimes(1);
  });

  it('drops a payload whose body deviceId disagrees with its topic', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler(payload({ topicDeviceId: '00000000-0000-4000-8000-000000000000' }));

    expect(insertInto).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
