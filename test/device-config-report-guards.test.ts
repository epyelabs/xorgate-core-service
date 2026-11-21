import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';

/**
 * The WHERE clauses that make the report mirror safe, pinned
 * (plans/support-other-camera-models, Phase 2 review S2 and N1).
 *
 * `device-config-report-camera-sensors.test.ts` scripts what each UPDATE
 * returns, so it cannot notice a guard being deleted. Here the fake database is
 * ONE ROW that HONOURS the guards it finds in the handler's real WHERE clause
 * (rendered to SQL with drizzle's own dialect) and applies every write whose
 * guards pass. Remove a guard from the handler and the fake applies a write it
 * should have refused, and a test below fails:
 *
 *   - the report UPDATE's `ts` guard: an older report must not replace a newer
 *     one, and must not trigger anything;
 *   - the withdrawal's `config_rev` equality: a cloud write that landed between
 *     the read and the withdrawal must not be overwritten by a stale snapshot;
 *   - the withdrawal's report-identity condition: a newer report stored in
 *     between is the one to judge by.
 */

interface DeviceState {
  config: Record<string, unknown> | null;
  configRev: number;
  reportedConfig: { ts: number; [k: string]: unknown } | null;
  simulated: boolean;
  agent: string;
}
let state: DeviceState;
/** Runs just before the Nth UPDATE (1-based) is evaluated: "meanwhile, elsewhere". */
let meanwhile: Record<number, () => void>;
/** Every WHERE the handler built, as SQL text, in order. */
let wheres: string[];
let updates: number;

const dialect = new PgDialect();
const param = (sql: string, params: unknown[], re: RegExp): unknown => {
  const m = re.exec(sql);
  return m ? params[Number(m[1]) - 1] : undefined;
};

/** Evaluate the guards this fake knows against the row. Unknown text is ignored. */
function guardsPass(sql: string, params: unknown[]): boolean {
  // eq(devices.config_rev, <rev read>)
  const rev = param(sql, params, /"config_rev" = \$(\d+)/);
  if (rev !== undefined && Number(rev) !== state.configRev) return false;
  // reported_config is null or coalesce((reported_config->>'ts')::bigint, 0) <= <ts>
  const notOlder = param(sql, params, /->>'ts'\)::bigint, 0\) <= \$(\d+)::bigint/);
  if (notOlder !== undefined && state.reportedConfig && state.reportedConfig.ts > Number(notOlder)) {
    return false;
  }
  // (reported_config->>'ts')::bigint = <ts>
  const same = param(sql, params, /->>'ts'\)::bigint = \$(\d+)::bigint/);
  if (same !== undefined && (!state.reportedConfig || state.reportedConfig.ts !== Number(same))) {
    return false;
  }
  return true;
}

vi.mock('../src/db/index', () => ({
  schema: realSchema,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            updates += 1;
            meanwhile[updates]?.();
            const { sql, params } = dialect.sqlToQuery(where);
            wheres.push(sql);
            if (!guardsPass(sql, params)) return [];
            if ('reportedConfig' in values) {
              state.reportedConfig = values.reportedConfig as DeviceState['reportedConfig'];
            }
            if ('config' in values) {
              state.config = values.config as DeviceState['config'];
              state.configRev += 1;
            }
            return [
              {
                config: state.config,
                configRev: state.configRev,
                simulated: state.simulated,
                agent: state.agent,
              },
            ];
          },
        }),
      }),
    }),
  },
}));

const publishDeviceConfig = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../src/services/device-config', () => ({
  publishDeviceConfig: (...a: unknown[]) => publishDeviceConfig(...a),
  deviceHardwareBlock: async () => null,
  deviceDeclaresObd: async () => false,
}));

const { handler, republishGuard } = await import('../src/handlers/device-config-report');

const DEVICE = 'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7';
const OLD_CAPS = ['sms.read', 'sms.clear', 'obd.scan', 'obd.forget'];
const NEW_CAPS = [...OLD_CAPS, 'camera.sensors'];
const SEED = { cameras: { cam0: { sensor: 'imx708' }, cam1: { sensor: 'imx290' } } };
const T0 = 1_800_000_000_000;

const agentBlock = (capabilities: string[]) => ({
  mode: 'real',
  build: { version: capabilities.includes('camera.sensors') ? 'v0.2.0' : 'v0.1.1' },
  capabilities,
  runtime: 'rust',
});
const report = (overrides: Record<string, unknown> = {}) => ({
  topicDeviceId: DEVICE,
  v: 1,
  deviceId: DEVICE,
  ts: T0,
  rev: 1,
  origin: 'boot',
  effective: { agent: agentBlock(OLD_CAPS) },
  status: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  republishGuard.reset();
  state = {
    config: { cameraSensors: SEED },
    configRev: 1,
    reportedConfig: null,
    simulated: false,
    agent: 'rust',
  };
  meanwhile = {};
  wheres = [];
  updates = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the fake row honours the guards (so the tests below mean something)', () => {
  it('the uncontended withdrawal goes through', async () => {
    await handler(report());
    expect(state.config).toEqual({});
    expect(state.configRev).toBe(2);
    expect(publishDeviceConfig).toHaveBeenCalledWith(DEVICE, {}, 2);
  });
});

describe('the withdrawal UPDATE is guarded on the rev it read', () => {
  it('the WHERE carries the config_rev equality and the report identity', async () => {
    await handler(report());
    expect(wheres).toHaveLength(2);
    expect(wheres[1]).toMatch(/"devices"\."id" = \$1/);
    expect(wheres[1]).toMatch(/"devices"\."config_rev" = \$\d/);
    expect(wheres[1]).toMatch(/\("devices"\."reported_config"->>'ts'\)::bigint = \$\d::bigint/);
  });

  it('a concurrent PATCH of ANOTHER namespace between read and withdrawal is not overwritten', async () => {
    // The handler read rev 1 with { cameraSensors }. Before its second UPDATE,
    // an operator saves timeSync: the row is now rev 2 with both namespaces.
    meanwhile[2] = () => {
      state.config = { cameraSensors: SEED, timeSync: { offlineSources: false } };
      state.configRev = 2;
    };
    await handler(report());

    // Without the rev guard the withdrawal would have written its stale
    // snapshot (`{}`) over the operator's save. The save survives, whole.
    expect(state.config).toEqual({ cameraSensors: SEED, timeSync: { offlineSources: false } });
    expect(state.configRev).toBe(2);
    // Nothing was published from the stale snapshot either.
    expect(publishDeviceConfig).not.toHaveBeenCalledWith(DEVICE, {}, expect.anything());
  });

  it('…and the device\'s next report then withdraws from the CURRENT document', async () => {
    meanwhile[2] = () => {
      state.config = { cameraSensors: SEED, timeSync: { offlineSources: false } };
      state.configRev = 2;
    };
    await handler(report());
    meanwhile = {};
    await handler(report({ ts: T0 + 5_000, rev: 2, origin: 'cloud' }));
    expect(state.config).toEqual({ timeSync: { offlineSources: false } });
    expect(state.configRev).toBe(3);
    expect(publishDeviceConfig).toHaveBeenLastCalledWith(
      DEVICE,
      { timeSync: { offlineSources: false } },
      3,
    );
  });

  it('a concurrent PATCH of cameraSensors itself wins as well', async () => {
    const operator = { cameras: { cam0: { sensor: 'imx219' } } };
    meanwhile[2] = () => {
      state.config = { cameraSensors: operator };
      state.configRev = 2;
    };
    await handler(report());
    expect(state.config).toEqual({ cameraSensors: operator });
    expect(state.configRev).toBe(2);
  });
});

describe('the withdrawal judges by the report that is still stored (N1)', () => {
  it('a newer, capable report stored in between keeps the value', async () => {
    // This invocation carries an old agent's report. Before its withdrawal
    // runs, a newer report from a capable agent is stored by another
    // invocation. The value must be judged by that one.
    meanwhile[2] = () => {
      state.reportedConfig = { ts: T0 + 50, effective: { agent: agentBlock(NEW_CAPS) } };
    };
    await handler(report());
    expect(state.config).toEqual({ cameraSensors: SEED });
    expect(state.configRev).toBe(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });
});

describe('the report UPDATE is guarded on the device clock', () => {
  it('the WHERE carries the ts guard', async () => {
    await handler(report());
    expect(wheres[0]).toMatch(/"devices"\."reported_config" is null/);
    expect(wheres[0]).toMatch(/coalesce\(\("devices"\."reported_config"->>'ts'\)::bigint, 0\) <= \$\d::bigint/);
  });

  it('an OLDER report does not replace a newer stored one, and withdraws nothing', async () => {
    // The stored report is newer and capable; an older, incapable one arrives
    // late (out-of-order delivery to a concurrent invocation).
    const newer = { ts: T0 + 60_000, effective: { agent: agentBlock(NEW_CAPS) } };
    state.reportedConfig = newer;
    await handler(report({ ts: T0 }));

    expect(state.reportedConfig).toBe(newer);
    // Without the ts guard the old report would be stored and, lacking the
    // capability, would delete the value of a capable device.
    expect(state.config).toEqual({ cameraSensors: SEED });
    expect(state.configRev).toBe(1);
    expect(updates).toBe(1);
    expect(publishDeviceConfig).not.toHaveBeenCalled();
  });

  it('a report with the SAME ts (a redelivery) is stored again and is harmless', async () => {
    await handler(report());
    expect(state.configRev).toBe(2);
    await handler(report());
    // Nothing left to withdraw; the device is behind (rev 1 < 2), so the
    // ordinary self-heal republishes the current document.
    expect(state.config).toEqual({});
    expect(state.configRev).toBe(2);
  });

  it('a first report (nothing stored) passes', async () => {
    state.config = { gnssAntBias: true };
    await handler(report({ effective: { agent: agentBlock(NEW_CAPS) } }));
    expect(state.reportedConfig).toMatchObject({ ts: T0 });
    expect(updates).toBe(1);
  });
});

describe('the local merge keeps its own rev guard', () => {
  it('a cloud write between the read and the merge wins', async () => {
    state.config = { gnssAntBias: true };
    state.configRev = 7;
    meanwhile[2] = () => {
      state.config = { gnssAntBias: false };
      state.configRev = 8;
    };
    await handler(
      report({
        rev: 7,
        origin: 'local',
        effective: { agent: agentBlock(NEW_CAPS) },
        changed: { timeSync: { offlineSources: false } },
      }),
    );
    expect(state.config).toEqual({ gnssAntBias: false });
    expect(state.configRev).toBe(8);
  });
});
