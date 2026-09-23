import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * expireSegmentIndexRows (Phase 6.3 + telemetry-session-artifacts P5): the
 * DB-side shadow of the two S3 lifecycle rules. There is no database here;
 * `db.delete` is a recorder and the WHERE clauses are rendered through the
 * pg dialect, so the test pins WHICH tables are expired, on WHICH clock, and
 * that every clock runs one day behind its lifecycle rule.
 */

const deletes: { table: string; where: string }[] = [];
const dialect = new PgDialect();

vi.mock('../src/db/index', async () => {
  const realSchema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const { getTableName } = await import('drizzle-orm');
  return {
    schema: realSchema,
    db: {
      delete: (table: Parameters<typeof getTableName>[0]) => ({
        where: (cond: unknown) => ({
          returning: async () => {
            const { sql } = dialect.sqlToQuery(cond as never);
            deletes.push({ table: getTableName(table), where: sql });
            return [];
          },
        }),
      }),
    },
  };
});

vi.mock('../src/services/workflow-triggers', () => ({ evaluateSessionCompletedTriggers: vi.fn() }));

process.env.SEGMENT_RETENTION_DAYS = '90';
process.env.TELEMETRY_ARTIFACT_RETENTION_DAYS = '365';
const { expireSegmentIndexRows, indexExpiryCutoff } = await import('../src/services/media-sessions');

describe('expireSegmentIndexRows', () => {
  beforeEach(() => {
    deletes.length = 0;
  });

  it('expires the media index one day behind the 90 d rule and the telemetry index one day behind the 365 d rule', async () => {
    const counts = await expireSegmentIndexRows();
    expect(counts).toEqual({ segments: 0, sessions: 0, ingestLog: 0, telemetrySegments: 0, telemetrySessions: 0 });
    expect(deletes.map((d) => d.table)).toEqual([
      'media_segments',
      'media_sessions',
      'telemetry_segments',
      'telemetry_sessions',
      'telemetry_ingest_log',
    ]);
    const by = Object.fromEntries(deletes.map((d) => [d.table, d.where]));
    expect(by.media_segments).toContain('make_interval(days => 91)');
    expect(by.media_sessions).toContain('make_interval(days => 91)');
    expect(by.telemetry_segments).toContain('make_interval(days => 366)');
    expect(by.telemetry_sessions).toContain('make_interval(days => 366)');
    // The ingest-log row is the duplicate-delivery guard of a 365-day object:
    // it must outlive the object, so it left the media clock in P5.
    expect(by.telemetry_ingest_log).toContain('make_interval(days => 366)');
    expect(by.telemetry_ingest_log).not.toContain('91');
  });

  it('only removes sessions with zero segments AND no arrival inside the window', async () => {
    await expireSegmentIndexRows();
    const by = Object.fromEntries(deletes.map((d) => [d.table, d.where]));
    expect(by.media_sessions).toMatch(/not exists \(select 1 from "media_segments"/);
    expect(by.telemetry_sessions).toMatch(/not exists \(select 1 from "telemetry_segments"/);
    expect(by.telemetry_sessions).toContain('"telemetry_sessions"."last_segment_at" <');
  });

  it('segments expire by their server arrival clock', async () => {
    await expireSegmentIndexRows();
    const by = Object.fromEntries(deletes.map((d) => [d.table, d.where]));
    expect(by.media_segments).toContain('"media_segments"."uploaded_at" <');
    expect(by.telemetry_segments).toContain('"telemetry_segments"."uploaded_at" <');
    expect(by.telemetry_ingest_log).toContain('"telemetry_ingest_log"."ingested_at" <');
  });

  it('indexExpiryCutoff is retention + 1 day, never below 1', () => {
    expect(dialect.sqlToQuery(indexExpiryCutoff(365)).sql).toBe('now() - make_interval(days => 366)');
    expect(dialect.sqlToQuery(indexExpiryCutoff(0)).sql).toBe('now() - make_interval(days => 1)');
    expect(dialect.sqlToQuery(indexExpiryCutoff(-5)).sql).toBe('now() - make_interval(days => 1)');
  });
});
