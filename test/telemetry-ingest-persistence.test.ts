import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import * as realSchema from '../src/db/schema';

/**
 * destroy-kvs-recorder Phase 3, decision A: telemetry persistence is hardwired ON.
 *
 * The `devices.persist_telemetry` gate is gone from `telemetry-ingest`, so live
 * telemetry now reaches `telemetry_readings` + `device_latest` for EVERY device —
 * including one that previously had `persist_telemetry = false`. This is the
 * phase's one real behavior change, and the DoD's most important regression check.
 *
 * It also fixes a latent bug: the removed opted-out branch upserted only the
 * `recording.*` / `media.recording` gauges, so metrics like `lte.gnss_health` never
 * reached `device_latest` for a non-persisting device (freezing the GNSS health
 * badge). These tests pin both the new behavior and that fix.
 *
 * `db` is mocked because the handler talks to the RDS Data API; the real drizzle
 * schema is reused so the insert target is the genuine table object.
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

/** Metric names handed to `db.insert(telemetryReadings).values(...)`. */
function insertedMetrics(): string[] {
  const rows = insertValues.mock.calls[0]?.[0] as unknown as { metric: string }[] | undefined;
  return (rows ?? []).map((r) => r.metric);
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

describe('telemetry-ingest: persistence is unconditional (decision A)', () => {
  it('writes telemetry_readings for a device that previously had persist_telemetry = false', async () => {
    // The mocked `devices.findFirst` returns undefined — i.e. no flags row at all,
    // which under the old code path meant `persistTelemetry: false` (the default)
    // and therefore NO history write. It must write now.
    await handler(payload());

    expect(insertInto).toHaveBeenCalledTimes(1);
    expect(insertInto).toHaveBeenCalledWith(realSchema.telemetryReadings);
    expect(insertedMetrics()).toContain('lte.gnss_health');
  });

  it('never reads the persist_telemetry flag (the gate and its cache are gone)', async () => {
    await handler(payload());
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('upserts device_latest with the FULL row set, not just the recorder gauges', async () => {
    // The bug this fixes: the old non-persisting branch filtered device_latest down
    // to `recording.*` / `media.recording`, so gnss_health could never land.
    await handler(payload());

    const upserts = executedSql().filter((s) => s.includes('device_latest'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toContain('lte.gnss_health');
    expect(upserts[0]).toContain('lte.resets_24h');
    expect(upserts[0]).toContain('cpu.temp');
  });

  it('still honours the on-device authority split: no history write while the device records', async () => {
    // `recording.enabled === true` means the device owns telemetry history via the
    // S3 batch path; live samples would duplicate it. device_latest still updates.
    await handler(payload({ recording: recordingStatus(true) }));

    expect(insertInto).not.toHaveBeenCalled();
    expect(executedSql().some((s) => s.includes('device_latest'))).toBe(true);
  });

  it('keeps the heartbeat isolated from a persist failure', async () => {
    insertValues.mockRejectedValueOnce(new Error('data api throttled'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handler(payload())).resolves.toBeUndefined();

    // The heartbeat UPDATE must still have run despite the failed insert.
    expect(executedSql().some((s) => s.includes('last_seen_at'))).toBe(true);
    err.mockRestore();
  });

  it('drops a payload whose body deviceId disagrees with its topic', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler(payload({ topicDeviceId: '00000000-0000-4000-8000-000000000000' }));

    expect(insertInto).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
