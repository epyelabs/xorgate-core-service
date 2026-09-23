import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The half of partition maintenance that only Postgres can answer: does the
 * handler's DDL actually do what it claims against a real partitioned
 * `telemetry_readings`, and — the DoD that matters most — does the SHIPPED
 * (dormant) configuration really delete nothing?
 *
 * `telemetry-partitions.test.ts` covers the month arithmetic, the bound parser
 * and the retention planner without a database. This file runs the REAL
 * handler against the dev cluster, because the failure this guards against is
 * not a logic bug: it is "the DDL was subtly wrong" or "the gate was wired to
 * the wrong env var", and neither shows up in a pure test.
 *
 * Opt-in — it executes DDL against a real database, so `npm test` skips it:
 *
 *   XORGATE_LIVE_DB=1 npx vitest run test/partition-maintenance.live.test.ts
 *
 * ⚠ SAFETY. The default run deliberately never arms retention. `runHandler()`
 * clears TELEMETRY_RETENTION_ENABLED before importing, so even a developer
 * with it exported in their shell cannot make this file drop a partition. The
 * "retention is armed" behaviour is asserted against the pure planner in
 * telemetry-partitions.test.ts, where dropping nothing is guaranteed by
 * construction.
 *
 * Everything the default run DOES write is idempotent: `CREATE TABLE IF NOT
 * EXISTS` for months 0/+1/+2 (which already exist in steady state) and
 * `ALTER TABLE ... SET` for the autovacuum options. There is no cleanup step
 * because there is nothing to clean up.
 *
 * THE ARMED DRILL (telemetry-session-artifacts P5, 5.3). A SECOND, separately
 * opted-in describe block runs the SAME handler with retention ARMED and
 * proves one real drop against dev: the partitions the pure planner says are
 * eligible are gone afterwards, nothing else moved, no orphan table was left
 * behind by a half-finished detach, and the artifact guard held back any
 * month with an unbuilt telemetry session. It DELETES DATA on the cluster it
 * points at. Two more opt-ins on top of XORGATE_LIVE_DB=1:
 *
 *   XORGATE_LIVE_RETENTION_DROP=1 TELEMETRY_RETENTION_DAYS=<n> \
 *     XORGATE_LIVE_DB=1 npx vitest run test/partition-maintenance.live.test.ts
 *
 * `TELEMETRY_RETENTION_DAYS` is REQUIRED for the drill (no silent default),
 * must be >= 31 (the planner refuses less), and is the window the drill
 * drops behind. Record the run in the plan's PROGRESS.md: this file is the
 * evidence trail, not a routine test. Never point it at prod.
 */

const LIVE = process.env.XORGATE_LIVE_DB === '1';
const d = LIVE ? describe : describe.skip;
const DRILL = LIVE && process.env.XORGATE_LIVE_RETENTION_DROP === '1';
const drill = DRILL ? describe : describe.skip;
// Captured before the safety `delete` below so the drill can re-arm with it.
const DRILL_DAYS = process.env.TELEMETRY_RETENTION_DAYS;

const RESOURCE_ARN = 'arn:aws:rds:us-east-1:111910761410:cluster:epye-sandbox-db';
const SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:111910761410:secret:epye-sandbox/xorgate-db-credentials-PxoDqV';
const DATABASE = process.env.XORGATE_LIVE_DB_NAME ?? 'xorgatedb_dev';

// ⚠ Must run BEFORE anything imports src/db/index.ts — that module reads these
// at import time and caches the client, so setting them inside a test is too
// late (the driver then reports "ARN cannot be null or empty").
process.env.DB_CLUSTER_ARN = RESOURCE_ARN;
process.env.DB_SECRET_ARN = SECRET_ARN;
process.env.DB_NAME = DATABASE;
process.env.AWS_REGION ??= 'us-east-1';
delete process.env.TELEMETRY_RETENTION_ENABLED; // see the ⚠ above
if (RESOURCE_ARN.includes('865609249890')) throw new Error('never point the live test at prod');

/** Run the REAL handler, with retention still forcibly off. */
async function runHandler(): Promise<void> {
  delete process.env.TELEMETRY_RETENTION_ENABLED;
  const { handler } = await import('../src/handlers/partition-maintenance');
  await handler();
}

async function query<T = Record<string, unknown>>(sqlText: string): Promise<T[]> {
  const { db } = await import('../src/db/index');
  const { sql } = await import('drizzle-orm');
  const res = await db.execute<T>(sql.raw(sqlText));
  return res.rows;
}

const monthName = (offset: number): string => {
  const now = new Date();
  const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `telemetry_readings_${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
};

d('partition-maintenance against the dev cluster', () => {
  let before: { relname: string; n: string }[] = [];

  beforeAll(async () => {
    before = await query<{ relname: string; n: string }>(`
      select c.relname, coalesce(c.reltuples, 0)::bigint::text as n
      from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'telemetry_readings'::regclass order by 1
    `);
    await runHandler();
  }, 120_000);

  it('the parent is genuinely partitioned', async () => {
    const [row] = await query<{ relkind: string }>(
      `select relkind::text as relkind from pg_class where relname = 'telemetry_readings'`,
    );
    expect(row.relkind).toBe('p');
  });

  it('months 0/+1/+2 exist after a run', async () => {
    const names = (
      await query<{ relname: string }>(`
        select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'telemetry_readings'::regclass
      `)
    ).map((r) => r.relname);
    for (const offset of [0, 1, 2]) expect(names).toContain(monthName(offset));
  });

  it('a DEFAULT partition exists — a skewed clock must never hard-fail an insert', async () => {
    const [row] = await query<{ n: string }>(`
      select count(*)::text as n from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'telemetry_readings'::regclass
        and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
    `);
    expect(Number(row.n)).toBe(1);
  });

  it('applies the append-only autovacuum settings to every month it maintains', async () => {
    // The settings that keep the visibility map warm; without them index-only
    // scans degrade into full heap fetches as the partition grows.
    for (const offset of [0, 1, 2]) {
      const [row] = await query<{ opts: string | null }>(
        `select array_to_string(reloptions, ',') as opts from pg_class where relname = '${monthName(offset)}'`,
      );
      expect(row.opts ?? '').toContain('autovacuum_vacuum_insert_threshold=100000');
      expect(row.opts ?? '').toContain('autovacuum_vacuum_insert_scale_factor=0');
    }
  });

  it('THE DEFAULT CONFIGURATION DELETES NOTHING', async () => {
    // The headline retention DoD. A run with no retention env set must leave
    // every partition exactly where it was.
    const after = await query<{ relname: string; n: string }>(`
      select c.relname, coalesce(c.reltuples, 0)::bigint::text as n
      from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'telemetry_readings'::regclass order by 1
    `);
    const beforeNames = before.map((r) => r.relname);
    const afterNames = after.map((r) => r.relname);
    // Every partition that existed still exists. (The run may ADD a month, at a
    // month boundary — that is maintenance, not deletion.)
    for (const name of beforeNames) expect(afterNames).toContain(name);
    // And nothing was orphaned by a half-finished detach.
    const orphans = await query<{ relname: string }>(`
      select relname from pg_class c
      where c.relname like 'telemetry_readings\\_%'
        and c.relkind = 'r'
        and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    `);
    expect(orphans.map((o) => o.relname)).toEqual([]);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const snapshot = async () =>
      (
        await query<{ relname: string }>(`
          select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'telemetry_readings'::regclass order by 1
        `)
      ).map((r) => r.relname);
    const first = await snapshot();
    await runHandler();
    expect(await snapshot()).toEqual(first);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The armed drill (see the header). Skipped unless explicitly opted in.
// ---------------------------------------------------------------------------

interface LivePartition {
  relname: string;
  bound: string | null;
  n: string;
}

async function livePartitions(): Promise<LivePartition[]> {
  return query<LivePartition>(`
    select c.relname, pg_get_expr(c.relpartbound, c.oid) as bound, coalesce(c.reltuples, 0)::bigint::text as n
    from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'telemetry_readings'::regclass order by 1
  `);
}

drill('partition-maintenance ARMED DRILL against the dev cluster (deletes data)', () => {
  let before: LivePartition[] = [];
  let expectedDrops: string[] = [];
  let expectedHolds: string[] = [];
  let rowsBefore: Record<string, number> = {};

  beforeAll(async () => {
    if (!DRILL_DAYS) throw new Error('the drill needs TELEMETRY_RETENTION_DAYS (>= 31) set explicitly');
    const { planRetention, parseUpperBound, parseLowerBound, retentionConfig } = await import(
      '../src/services/telemetry-partitions'
    );
    before = await livePartitions();
    const cfg = retentionConfig({
      TELEMETRY_RETENTION_ENABLED: 'true',
      TELEMETRY_RETENTION_DAYS: DRILL_DAYS,
      TELEMETRY_RETENTION_MAX_DROPS: process.env.TELEMETRY_RETENTION_MAX_DROPS,
    });
    const plan = planRetention(
      before.map((p) => ({ name: p.relname, upperBound: parseUpperBound(p.bound), lowerBound: parseLowerBound(p.bound) })),
      new Date(),
      cfg,
    );
    if (plan.refusal) throw new Error(`planner refused: ${plan.refusal}`);
    // Mirror the handler's artifact guard so the drill knows what it expects.
    for (const p of plan.drop) {
      const lower = parseLowerBound(before.find((b) => b.relname === p.name)!.bound)!;
      const [row] = await query<{ n: string }>(`
        select count(*)::text as n from telemetry_sessions
        where started_at < '${p.upperBound!.toISOString()}'::timestamptz
          and coalesce(ended_at, started_at) >= '${lower.toISOString()}'::timestamptz
          and overview_key is null
      `);
      (Number(row.n) > 0 ? expectedHolds : expectedDrops).push(p.name);
    }
    for (const name of expectedDrops) {
      const [row] = await query<{ n: string }>(`select count(*)::text as n from "${name}"`);
      rowsBefore[name] = Number(row.n);
    }
    console.log(
      `[drill] window ${cfg.days} d, cutoff ${plan.cutoff.toISOString()}; will drop ${JSON.stringify(expectedDrops)} ` +
        `(rows ${JSON.stringify(rowsBefore)}), hold ${JSON.stringify(expectedHolds)}, defer ${JSON.stringify(plan.deferred.map((p) => p.name))}`,
    );
    process.env.TELEMETRY_RETENTION_ENABLED = 'true';
    process.env.TELEMETRY_RETENTION_DAYS = DRILL_DAYS;
    try {
      const { handler } = await import('../src/handlers/partition-maintenance');
      await handler();
    } finally {
      delete process.env.TELEMETRY_RETENTION_ENABLED;
    }
  }, 300_000);

  it('the drill had something to drop (otherwise it proved nothing: pick a window that does)', () => {
    expect(expectedDrops.length).toBeGreaterThan(0);
  });

  it('exactly the eligible, unguarded partitions are gone', async () => {
    const after = (await livePartitions()).map((p) => p.relname);
    for (const name of expectedDrops) expect(after).not.toContain(name);
    for (const name of expectedHolds) expect(after).toContain(name);
    for (const p of before) {
      if (!expectedDrops.includes(p.relname)) expect(after).toContain(p.relname);
    }
  });

  it('a dropped partition is gone as a table too (detach + drop both ran)', async () => {
    const orphans = await query<{ relname: string }>(`
      select relname from pg_class c
      where c.relname like 'telemetry_readings\\_%' and c.relkind = 'r'
        and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)
    `);
    expect(orphans.map((o) => o.relname)).toEqual([]);
  });

  it('the DEFAULT partition and the current month survive whatever the window', async () => {
    const after = await livePartitions();
    expect(after.filter((p) => p.bound === 'DEFAULT').length).toBe(1);
    expect(after.map((p) => p.relname)).toContain(monthName(0));
  });
});
