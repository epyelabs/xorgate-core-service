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
 * ⚠ SAFETY. This deliberately never arms retention. `runHandler()` clears
 * TELEMETRY_RETENTION_ENABLED before importing, so even a developer with it
 * exported in their shell cannot make this file drop a partition. The
 * "retention is armed" behaviour is asserted against the pure planner in
 * telemetry-partitions.test.ts, where dropping nothing is guaranteed by
 * construction.
 *
 * Everything it DOES write is idempotent: `CREATE TABLE IF NOT EXISTS` for
 * months 0/+1/+2 (which already exist in steady state) and `ALTER TABLE ... SET`
 * for the autovacuum options. There is no cleanup step because there is
 * nothing to clean up.
 */

const LIVE = process.env.XORGATE_LIVE_DB === '1';
const d = LIVE ? describe : describe.skip;

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
