import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DROPS_PER_RUN,
  DEFAULT_RETENTION_DAYS,
  MAINTAINED_MONTH_OFFSETS,
  MIN_RETENTION_DAYS,
  PARTITION_AUTOVACUUM_OPTS,
  boundary,
  monthStartUtc,
  parseUpperBound,
  partitionAutovacuumClause,
  partitionName,
  planRetention,
  retentionConfig,
  type PartitionInfo,
} from '../src/services/telemetry-partitions';

// ---------------------------------------------------------------------------
// Month arithmetic — untested until phase 4, and the thing a missing partition
// hard-fails ingestion over. Names and boundaries must match the literals in
// drizzle/manual/001_telemetry_partition.sql byte for byte.
// ---------------------------------------------------------------------------

describe('monthStartUtc / partitionName / boundary', () => {
  const jul = new Date('2026-07-15T14:23:11.000Z');

  it('produces the manual/001 bootstrap names for the months it created', () => {
    expect(partitionName(monthStartUtc(jul, -1))).toBe('telemetry_readings_2026_06');
    expect(partitionName(monthStartUtc(jul, 0))).toBe('telemetry_readings_2026_07');
  });

  it('produces the manual/001 boundary literal form', () => {
    expect(boundary(monthStartUtc(jul, 0))).toBe('2026-07-01 00:00:00+00');
    expect(boundary(monthStartUtc(jul, 1))).toBe('2026-08-01 00:00:00+00');
  });

  it('zero-pads single-digit months', () => {
    const jan = new Date('2027-01-04T00:00:00.000Z');
    expect(partitionName(monthStartUtc(jan, 0))).toBe('telemetry_readings_2027_01');
    expect(boundary(monthStartUtc(jan, 0))).toBe('2027-01-01 00:00:00+00');
  });

  it('rolls over the year at the +1/+2 offsets the maintainer pre-creates', () => {
    const nov = new Date('2026-11-15T02:00:00.000Z');
    expect(MAINTAINED_MONTH_OFFSETS.map((o) => partitionName(monthStartUtc(nov, o)))).toEqual([
      'telemetry_readings_2026_11',
      'telemetry_readings_2026_12',
      'telemetry_readings_2027_01',
    ]);
    // The +2 partition's own upper edge must also roll — a Dec 1 → Jan 1 bound.
    expect(boundary(monthStartUtc(nov, 3))).toBe('2027-02-01 00:00:00+00');
  });

  it('is stable regardless of where in the month "now" falls', () => {
    for (const day of ['01T00:00:00.000Z', '15T02:00:00.000Z', '31T23:59:59.999Z']) {
      expect(partitionName(monthStartUtc(new Date(`2026-08-${day}`), 0))).toBe(
        'telemetry_readings_2026_08',
      );
    }
  });

  it('does not drift when the local timezone is behind UTC', () => {
    // The 1st of a month at 00:30 UTC is still the PREVIOUS month locally in
    // the Americas. Using local getMonth() here would create the wrong
    // partition and ingestion would fail for a day.
    expect(partitionName(monthStartUtc(new Date('2026-09-01T00:30:00.000Z'), 0))).toBe(
      'telemetry_readings_2026_09',
    );
  });
});

describe('partitionAutovacuumClause', () => {
  it('turns the insert scale factor off in favour of a flat threshold', () => {
    // A size-proportional trigger is exactly what leaves the visibility map
    // stale on a big append-only partition, so the scale factor must be 0.
    expect(PARTITION_AUTOVACUUM_OPTS.autovacuum_vacuum_insert_scale_factor).toBe(0);
    expect(partitionAutovacuumClause()).toBe(
      'autovacuum_vacuum_insert_threshold = 100000, autovacuum_vacuum_insert_scale_factor = 0',
    );
  });
});

// ---------------------------------------------------------------------------
// Partition bound parsing — retention keys off this, so anything it cannot
// confidently read must come back null ("never droppable").
// ---------------------------------------------------------------------------

describe('parseUpperBound', () => {
  it('reads the exclusive upper bound of a monthly range', () => {
    expect(
      parseUpperBound(
        "FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00')",
      )?.toISOString(),
    ).toBe('2026-08-01T00:00:00.000Z');
  });

  it('returns null for the DEFAULT partition', () => {
    expect(parseUpperBound('DEFAULT')).toBeNull();
  });

  it('returns null for anything it does not understand, so the data survives', () => {
    expect(parseUpperBound(null)).toBeNull();
    expect(parseUpperBound(undefined)).toBeNull();
    expect(parseUpperBound('')).toBeNull();
    expect(parseUpperBound("FOR VALUES IN ('a', 'b')")).toBeNull();
    expect(parseUpperBound("FOR VALUES FROM ('2026-07-01 00:00:00+00') TO (MAXVALUE)")).toBeNull();
    expect(parseUpperBound("FOR VALUES FROM ('x') TO ('not-a-date')")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retention config — the dormant-by-default gate is the whole point.
// ---------------------------------------------------------------------------

describe('retentionConfig', () => {
  it('is DISABLED with no environment at all', () => {
    expect(retentionConfig({})).toEqual({
      enabled: false,
      days: DEFAULT_RETENTION_DAYS,
      maxDropsPerRun: DEFAULT_MAX_DROPS_PER_RUN,
    });
  });

  it('only the exact string "true" arms it', () => {
    for (const v of ['1', 'yes', 'TRUE', 'True', 'on', '', 'false', ' true']) {
      expect(retentionConfig({ TELEMETRY_RETENTION_ENABLED: v }).enabled).toBe(false);
    }
    expect(retentionConfig({ TELEMETRY_RETENTION_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('takes a window and a drop ceiling from the environment', () => {
    expect(
      retentionConfig({
        TELEMETRY_RETENTION_ENABLED: 'true',
        TELEMETRY_RETENTION_DAYS: '180',
        TELEMETRY_RETENTION_MAX_DROPS: '1',
      }),
    ).toEqual({ enabled: true, days: 180, maxDropsPerRun: 1 });
  });

  it('falls back to the defaults on junk rather than to zero', () => {
    const cfg = retentionConfig({
      TELEMETRY_RETENTION_DAYS: 'abc',
      TELEMETRY_RETENTION_MAX_DROPS: '-4',
    });
    expect(cfg.days).toBe(DEFAULT_RETENTION_DAYS);
    expect(cfg.maxDropsPerRun).toBe(DEFAULT_MAX_DROPS_PER_RUN);
  });

  it('defaults to a window at least as long as the batch-ingest age limit', () => {
    // DEFAULT_MAX_AGE_MS in services/telemetry-batch.ts is 90 days: retention
    // must never delete a month a late segment upload could still write into.
    expect(DEFAULT_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// The planner. Every guardrail the phase file asked for is a case here.
// ---------------------------------------------------------------------------

const p = (name: string, upper: string | null): PartitionInfo => ({
  name,
  upperBound: upper === null ? null : new Date(upper),
});

const FLEET: PartitionInfo[] = [
  p('telemetry_readings_2026_01', '2026-02-01T00:00:00Z'),
  p('telemetry_readings_2026_02', '2026-03-01T00:00:00Z'),
  p('telemetry_readings_2026_03', '2026-04-01T00:00:00Z'),
  p('telemetry_readings_2026_07', '2026-08-01T00:00:00Z'),
  p('telemetry_readings_2026_08', '2026-09-01T00:00:00Z'),
  p('telemetry_readings_default', null),
];

const NOW = new Date('2026-08-04T17:00:00Z');
const armed = { enabled: true, days: 90, maxDropsPerRun: 3 };

describe('planRetention', () => {
  it('drops NOTHING when disabled, however old the partitions are', () => {
    const plan = planRetention(FLEET, NOW, { ...armed, enabled: false });
    expect(plan.drop).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.refusal).toBe('retention disabled');
  });

  it('drops only partitions whose WHOLE range is past the cutoff', () => {
    const plan = planRetention(FLEET, NOW, armed);
    // Cutoff is 2026-05-06. Jan/Feb/Mar end before it; July ends 2026-08-01,
    // which is well inside the window, so it stays.
    expect(plan.drop.map((x) => x.name)).toEqual([
      'telemetry_readings_2026_01',
      'telemetry_readings_2026_02',
      'telemetry_readings_2026_03',
    ]);
  });

  it('uses the UPPER bound, so the current month is never eligible', () => {
    // A lower-bound test would drop 2026_08 the moment the cutoff crossed
    // 2026-08-01 — i.e. it would delete the partition being written to.
    const plan = planRetention(FLEET, new Date('2026-10-25T00:00:00Z'), { ...armed, days: 31 });
    expect(plan.drop.map((x) => x.name)).not.toContain('telemetry_readings_2026_08');
  });

  it('NEVER drops the DEFAULT partition', () => {
    // Even with an absurdly long horizon and a huge drop ceiling.
    const plan = planRetention(FLEET, new Date('2030-01-01T00:00:00Z'), {
      enabled: true,
      days: 31,
      maxDropsPerRun: 100,
    });
    expect(plan.drop.map((x) => x.name)).not.toContain('telemetry_readings_default');
    expect(plan.drop).toHaveLength(5);
  });

  it('caps drops per run and REPORTS what it held back', () => {
    const plan = planRetention(FLEET, new Date('2030-01-01T00:00:00Z'), {
      ...armed,
      maxDropsPerRun: 2,
    });
    expect(plan.drop).toHaveLength(2);
    expect(plan.deferred).toHaveLength(3);
    // Oldest first, so repeated runs converge instead of thrashing.
    expect(plan.drop.map((x) => x.name)).toEqual([
      'telemetry_readings_2026_01',
      'telemetry_readings_2026_02',
    ]);
  });

  it('refuses a window below the minimum instead of deleting everything', () => {
    const plan = planRetention(FLEET, NOW, { ...armed, days: 3 });
    expect(plan.drop).toEqual([]);
    expect(plan.refusal).toContain(`below the ${MIN_RETENTION_DAYS}d minimum`);
  });

  it('a clock skewed far into the future still cannot delete more than the ceiling', () => {
    // The scenario the ceiling exists for: `now()` jumps years ahead.
    const plan = planRetention(FLEET, new Date('2099-01-01T00:00:00Z'), armed);
    expect(plan.drop).toHaveLength(DEFAULT_MAX_DROPS_PER_RUN);
    expect(plan.deferred).toHaveLength(2);
  });

  it('a clock skewed into the past drops nothing', () => {
    const plan = planRetention(FLEET, new Date('2025-01-01T00:00:00Z'), armed);
    expect(plan.drop).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('reports the cutoff it used even when it drops nothing', () => {
    const plan = planRetention([], NOW, armed);
    expect(plan.cutoff.toISOString()).toBe('2026-05-06T17:00:00.000Z');
    expect(plan.drop).toEqual([]);
  });

  it('the DEFAULT configuration deletes nothing on the live dev partition set', () => {
    // The DoD: verify the shipped configuration is inert. This is the exact
    // partition list `xorgatedb_dev` has after the phase 4 migration.
    const dev: PartitionInfo[] = [
      p('telemetry_readings_2026_06', '2026-07-01T00:00:00Z'),
      p('telemetry_readings_2026_07', '2026-08-01T00:00:00Z'),
      p('telemetry_readings_2026_08', '2026-09-01T00:00:00Z'),
      p('telemetry_readings_2026_09', '2026-10-01T00:00:00Z'),
      p('telemetry_readings_2026_10', '2026-11-01T00:00:00Z'),
      p('telemetry_readings_default', null),
    ];
    expect(planRetention(dev, NOW, retentionConfig({})).drop).toEqual([]);
    // And even if someone arms it without choosing a window, the 90-day
    // default still keeps every one of dev's partitions.
    expect(
      planRetention(dev, NOW, retentionConfig({ TELEMETRY_RETENTION_ENABLED: 'true' })).drop,
    ).toEqual([]);
  });
});
