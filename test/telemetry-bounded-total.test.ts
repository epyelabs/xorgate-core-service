import { describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { telemetryReadings } from '../src/db/schema';
import { tsParam } from '../src/utils/sql';
import {
  boundedTotalQuery,
  capTotal,
  READINGS_TOTAL_CAP,
} from '../src/services/telemetry-readings';

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const dialect = new PgDialect();
const render = (order: 'asc' | 'desc' = 'desc', cap?: number) =>
  dialect.sqlToQuery(boundedTotalQuery(readingsWhere(), order, cap));

// The same predicate handleReadings builds — device + optional range + metrics.
function readingsWhere() {
  const t = telemetryReadings;
  return and(
    eq(t.deviceId, DEVICE),
    sql`${t.ts} >= ${tsParam('2026-08-01T00:00:00.000Z')}`,
    inArray(t.metric, ['imu.accel_x', 'gps.lat']),
  );
}

describe('capTotal', () => {
  it('caps and flags when more than the cap matches', () => {
    // The query probes with `limit cap + 1`, so cap + 1 is what "more" looks like.
    expect(capTotal(READINGS_TOTAL_CAP + 1)).toEqual({
      total: READINGS_TOTAL_CAP,
      totalIsCapped: true,
    });
  });

  it('reports an exact total when fewer than the cap match', () => {
    expect(capTotal(2_496)).toEqual({ total: 2_496, totalIsCapped: false });
    expect(capTotal(0)).toEqual({ total: 0, totalIsCapped: false });
  });

  it('treats exactly the cap as exact, not capped', () => {
    expect(capTotal(READINGS_TOTAL_CAP)).toEqual({
      total: READINGS_TOTAL_CAP,
      totalIsCapped: false,
    });
  });
});

describe('boundedTotalQuery', () => {
  it('probes cap + 1 rows but spans only the addressable cap', () => {
    const { sql: text } = render();
    // The + 1 is the only thing distinguishing "exactly cap" from "more".
    expect(text).toContain(`limit ${READINGS_TOTAL_CAP + 1}`);
    // ...and the covered span must not include that extra, unreachable row.
    expect(text).toContain(`limit ${READINGS_TOTAL_CAP}\n`);
    expect(text).toContain('from addressable');
  });

  it('stays on the index: distinct + order + limit, no count(distinct)', () => {
    const { sql: text } = render();
    expect(text).toContain('select distinct "telemetry_readings"."ts"');
    expect(text).toContain('count(*)::int');
    expect(text).not.toContain('count(distinct');
    expect(text).not.toContain('group by');
  });

  it('reuses the caller\'s where clause verbatim, params and casts intact', () => {
    const { sql: text, params } = render();
    expect(text).toContain('"telemetry_readings"."device_id" = $1');
    // tsParam's ::timestamptz cast is load-bearing on the Data API.
    expect(text).toContain('$2::timestamptz');
    expect(params).toEqual([
      DEVICE,
      '2026-08-01T00:00:00.000Z',
      'imu.accel_x',
      'gps.lat',
    ]);
  });

  it('inlines the cap rather than binding it', () => {
    // The Data API binds params as stringValue, which Postgres rejects in LIMIT.
    expect(render().params).not.toContain(READINGS_TOTAL_CAP + 1);
    expect(render(undefined, 500).sql).toContain('limit 501');
  });

  it('applies the requested order to both nested limits', () => {
    const desc = render('desc').sql;
    const asc = render('asc').sql;
    expect(desc).toContain('order by "telemetry_readings"."ts" desc');
    expect(desc).toContain('order by ts desc');
    expect(asc).toContain('order by "telemetry_readings"."ts" asc');
    expect(asc).toContain('order by ts asc');
  });

  it('emits the covered span as ISO-8601 UTC strings', () => {
    const { sql: text } = render();
    expect(text).toContain(
      `to_char(min(ts) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as covered_from`,
    );
    expect(text).toContain(
      `to_char(max(ts) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as covered_to`,
    );
  });

  it('is valid with no filter at all', () => {
    const { sql: text, params } = dialect.sqlToQuery(boundedTotalQuery(undefined, 'desc'));
    expect(text).toContain('where true');
    expect(params).toEqual([]);
  });
});
