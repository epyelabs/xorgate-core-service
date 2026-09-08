import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { tsParam } from '../utils/sql';
import type { TelemetrySample } from '@xorgate/workflow-engine';

/**
 * The one sanctioned telemetry-history read for the v2 engine, shared by the
 * Lambda engine target (direct reads through the EngineSourceReader seam) and
 * the M4 dispatcher-side input materialization for Fargate runs
 * (workflow-engine-v2.ts), so the two paths cannot drift: a fusion graph
 * replayed on the container sees exactly the rows the Lambda engine would
 * have read. Raw stored values, no unit conversion (M2 decision 6).
 */

// Memory guard for the in-process run; the history API serves at most 5k rows,
// so this is generous headroom, not a tuning knob.
export const MAX_TELEMETRY_ROWS = 100_000;

export async function readTelemetryWindow(query: {
  deviceId: string;
  metrics: string[];
  window: { fromMs: number; toMs: number };
}): Promise<TelemetrySample[]> {
  const { deviceId, metrics, window } = query;
  const rows = await db
    .select({
      ts: schema.telemetryReadings.ts,
      metric: schema.telemetryReadings.metric,
      value: schema.telemetryReadings.value,
    })
    .from(schema.telemetryReadings)
    .where(
      and(
        eq(schema.telemetryReadings.deviceId, deviceId),
        inArray(schema.telemetryReadings.metric, metrics),
        sql`${schema.telemetryReadings.ts} >= ${tsParam(new Date(window.fromMs).toISOString())}`,
        sql`${schema.telemetryReadings.ts} < ${tsParam(new Date(window.toMs).toISOString())}`,
      ),
    )
    .orderBy(asc(schema.telemetryReadings.ts))
    .limit(MAX_TELEMETRY_ROWS);
  if (rows.length === MAX_TELEMETRY_ROWS) {
    console.warn('telemetry-window: window truncated', { deviceId, metrics });
  }
  // Rows are per-metric; group them into one sample per timestamp.
  const byTs = new Map<number, Record<string, number>>();
  for (const row of rows) {
    if (row.value === null) continue;
    const ts = row.ts.getTime();
    (byTs.get(ts) ?? byTs.set(ts, {}).get(ts)!)[row.metric] = row.value;
  }
  return [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, signals]) => ({ ts, signals }));
}
