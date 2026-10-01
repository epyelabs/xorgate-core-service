import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Device SMS inbox, core half (plans/device-sms-inbox, Phase 2 §3.4; shapes
 * in contract.md §2-5): the three routes on the device-commands Lambda and
 * the IoT-rule ingest Lambda, against one in-memory `device_sms_reads`.
 *
 * The db fake is semantic rather than a call recorder: it reads the bound
 * values out of each drizzle `where` and applies them to the rows (id, device
 * and status constraints; the ingest's `created_at < (select ...)` cleanup
 * for a delete that names both a device and a read). That is what lets the
 * retention and the late/duplicate/cross-device cases be asserted on the
 * resulting table instead of on the shape of the statements.
 *
 * The auth fake applies the role list the handler passes, so the handler's
 * CHOICE of gate (none) is what is under test.
 */

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

interface FakeAuth {
  userId: string | null;
  apiKeyId: string | null;
  organizationId: string;
  membershipRole: string;
}
/** null = the caller is not a member of the organization. */
let auth: FakeAuth | null;

const { AuthError } = await vi.importActual<typeof import('../src/middleware/auth')>('../src/middleware/auth');

const requireOrgContext = vi.fn(async (_e: unknown, roles?: string[]) => {
  if (!auth) throw new AuthError('Not a member of this organization.', 403, 'FORBIDDEN');
  if (roles && !roles.includes(auth.membershipRole)) {
    throw new AuthError(`Requires one of: ${roles.join(', ')}.`, 403, 'INSUFFICIENT_ROLE');
  }
  return auth;
});
vi.mock('../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth')>('../src/middleware/auth');
  return { ...actual, requireOrgContext };
});

let orgWorkspaceIds: string[];
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => orgWorkspaceIds,
  isWorkspaceScoped: () => false,
}));

const publishDeviceCommand = vi.fn();
vi.mock('../src/services/device-command', () => ({ publishDeviceCommand }));

// ---- ids --------------------------------------------------------------------
const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const OTHER_DEVICE = 'dddddddd-0000-4000-8000-000000000002';
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG = 'cccccccc-0000-4000-8000-00000000000a';
const DEVICE_IDS = new Set([DEVICE, OTHER_DEVICE]);
const STATUSES = new Set(['pending', 'ok', 'error', 'expired']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- db fake ----------------------------------------------------------------
interface DeviceRow {
  id: string;
  name: string | null;
  serial: string | null;
  status: string;
  workspaceId: string;
  reportedConfig: unknown;
}
type ReadRow = Record<string, any> & { id: string; deviceId: string; status: string; createdAt: Date };

let devices: Record<string, DeviceRow>;
let reads: ReadRow[];

/** Every scalar bound into a drizzle SQL tree (params and raw template values). */
function bound(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') return void out.push(n);
    if (typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (Array.isArray(n.queryChunks)) return n.queryChunks.forEach(walk);
    // A drizzle Param.
    if ('encoder' in n && 'value' in n) {
      if (Array.isArray(n.value)) n.value.forEach(walk);
      else if (typeof n.value === 'string') out.push(n.value);
    }
  };
  walk(node);
  return out;
}

interface Constraints {
  ids: string[];
  devices: string[];
  statuses: string[];
}
function constraints(where: unknown): Constraints {
  const values = bound(where);
  return {
    ids: values.filter((v) => UUID_RE.test(v) && !DEVICE_IDS.has(v)),
    devices: values.filter((v) => DEVICE_IDS.has(v)),
    statuses: values.filter((v) => STATUSES.has(v)),
  };
}
function matches(row: ReadRow, c: Constraints): boolean {
  if (c.ids.length && !c.ids.includes(row.id)) return false;
  if (c.devices.length && !c.devices.includes(row.deviceId)) return false;
  if (c.statuses.length && !c.statuses.includes(row.status)) return false;
  return true;
}

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    query: {
      devices: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = bound(where).find((v) => v in devices);
          if (!id) return undefined;
          return orgWorkspaceIds.includes(devices[id].workspaceId) ? devices[id] : undefined;
        },
      },
      deviceSmsReads: {
        findFirst: async ({ where, orderBy }: { where: unknown; orderBy?: unknown }) => {
          const hits = reads.filter((r) => matches(r, constraints(where)));
          // The only ordered read is /latest: newest completion first.
          if (orderBy) hits.sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
          return hits[0] ? { ...hits[0] } : undefined;
        },
      },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          const row = {
            errorCode: null,
            errorMessage: null,
            result: null,
            completedAt: null,
            ...v,
          } as ReadRow;
          reads.push(row);
          return [{ ...row }];
        },
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (where: unknown) => {
          const apply = () => {
            const hit = reads.filter((r) => matches(r, constraints(where)));
            hit.forEach((r) => Object.assign(r, vals));
            return hit.map((r) => ({ ...r }));
          };
          const p = Promise.resolve().then(apply);
          return Object.assign(p, { returning: () => p });
        },
      }),
    }),
    delete: () => ({
      where: (where: unknown) => ({
        returning: async () => {
          const c = constraints(where);
          // The ingest cleanup: device = $1 AND created_at < (created_at of read $2).
          if (c.devices.length !== 1 || c.ids.length !== 1) throw new Error('unexpected delete shape');
          const ref = reads.find((r) => r.id === c.ids[0]);
          if (!ref) return [];
          const gone = reads.filter(
            (r) => r.deviceId === c.devices[0] && r.createdAt.getTime() < ref.createdAt.getTime(),
          );
          reads = reads.filter((r) => !gone.includes(r));
          return gone.map((r) => ({ id: r.id }));
        },
      }),
    }),
  };
  return { schema, db };
});

const { handler: commandsHandler } = await import('../src/handlers/device-commands');
const { handler: ingest } = await import('../src/handlers/device-sms-result');

// ---- helpers ----------------------------------------------------------------
function event(
  routeKey: string,
  over: { body?: string; readId?: string; deviceId?: string } = {},
): APIGatewayProxyEventV2 {
  const [method, path] = routeKey.split(' ');
  return {
    version: '2.0',
    routeKey: `${method} /v1${path}`,
    rawPath: `/v1${path}`,
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method }, requestId: 'req-1' },
    pathParameters: { id: over.deviceId ?? DEVICE, ...(over.readId ? { readId: over.readId } : {}) },
    body: over.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}
const status = (r: unknown) => (r as { statusCode: number }).statusCode;
const parse = (r: unknown) => JSON.parse((r as { body: string }).body);
const call = (routeKey: string, over: Parameters<typeof event>[1] = {}) => commandsHandler(event(routeKey, over));
const post = (body?: unknown) =>
  call('POST /devices/{id}/sms-reads', { body: body === undefined ? undefined : JSON.stringify(body) });
const getRead = (readId: string, deviceId = DEVICE) =>
  call('GET /devices/{id}/sms-reads/{readId}', { readId, deviceId });
const getLatest = (deviceId = DEVICE) => call('GET /devices/{id}/sms-reads/latest', { deviceId });

const capable = { effective: { agent: { capabilities: ['sms.read'], build: { version: 'abc' } } } };

let seq = 0;
function seedRead(over: Partial<ReadRow> & { createdAt: Date }): ReadRow {
  seq += 1;
  const row: ReadRow = {
    id: `01990000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    deviceId: DEVICE,
    workspaceId: WS,
    organizationId: ORG,
    requestedBy: 'user-1',
    limit: 10,
    status: 'pending',
    errorCode: null,
    errorMessage: null,
    result: null,
    completedAt: null,
    ...over,
  };
  reads.push(row);
  return row;
}

const message = {
  id: 'SM:3+SM:4',
  storage: 'SM',
  indexes: [3, 4],
  from: '+15550000000',
  fromType: 'international',
  sentAt: '2026-08-11T20:05:59-04:00',
  unread: true,
  text: 'hello',
  binary: false,
  incomplete: false,
  truncated: false,
};
function reply(requestId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topicDeviceId: DEVICE,
    v: 1,
    deviceId: DEVICE,
    requestId,
    ts: 1_759_333_337_000,
    status: 'ok',
    error: null,
    durationMs: 3512,
    storage: { SM: { used: 7, total: 40 }, ME: { used: 23, total: 23 } },
    total: 30,
    skipped: 0,
    partial: false,
    messages: [message],
    ...over,
  };
}
const ago = (ms: number) => new Date(Date.now() - ms);

beforeEach(() => {
  vi.clearAllMocks();
  auth = { userId: 'user-1', apiKeyId: null, organizationId: ORG, membershipRole: 'owner' };
  orgWorkspaceIds = [WS];
  devices = {
    [DEVICE]: { id: DEVICE, name: 'Bench', serial: 'SN1', status: 'online', workspaceId: WS, reportedConfig: capable },
    [OTHER_DEVICE]: {
      id: OTHER_DEVICE,
      name: 'Other',
      serial: 'SN2',
      status: 'online',
      workspaceId: WS,
      reportedConfig: capable,
    },
  };
  reads = [];
  seq = 0;
  publishDeviceCommand.mockImplementation(async (_d: string, command: string, opts: { requestId: string }) => ({
    v: 1,
    requestId: opts.requestId,
    command,
    ts: Date.now(),
    expiresAt: Date.now() + 60_000,
  }));
});

// ---- POST -------------------------------------------------------------------
describe('POST /devices/{id}/sms-reads', () => {
  it('records a pending read, publishes read_sms with the row id as requestId, and answers 202', async () => {
    const res = await post({ limit: 25 });
    expect(status(res)).toBe(202);
    const body = parse(res);
    expect(body).toMatchObject({
      deviceId: DEVICE,
      status: 'pending',
      limit: 25,
      requestedBy: 'user-1',
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      result: null,
    });
    expect(body).not.toHaveProperty('organizationId');
    expect(body).not.toHaveProperty('workspaceId');
    expect(publishDeviceCommand).toHaveBeenCalledWith(DEVICE, 'read_sms', {
      args: { limit: 25 },
      requestId: body.id,
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ id: body.id, workspaceId: WS, organizationId: ORG, status: 'pending' });
  });

  it('takes the any-member gate: every role, viewer included, gets 202', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      auth = { userId: `u-${role}`, apiKeyId: null, organizationId: ORG, membershipRole: role };
      expect(status(await post())).toBe(202);
    }
    // No role list is passed to the gate.
    for (const [, roles] of requireOrgContext.mock.calls) expect(roles).toBeUndefined();
  });

  it('is a 403 for a caller outside the organization', async () => {
    auth = null;
    const res = await post();
    expect(status(res)).toBe(403);
    expect(reads).toHaveLength(0);
    expect(publishDeviceCommand).not.toHaveBeenCalled();
  });

  it('is a 404 for a device outside the caller\'s workspaces', async () => {
    devices[DEVICE].workspaceId = 'ffffffff-0000-4000-8000-000000000001';
    const res = await post();
    expect(status(res)).toBe(404);
    expect(parse(res).error.code).toBe('NOT_FOUND');
    expect(reads).toHaveLength(0);
  });

  it('is a 409 DEVICE_OFFLINE when the device is not online', async () => {
    devices[DEVICE].status = 'offline';
    const res = await post();
    expect(status(res)).toBe(409);
    expect(parse(res).error.code).toBe('DEVICE_OFFLINE');
    expect(reads).toHaveLength(0);
    expect(publishDeviceCommand).not.toHaveBeenCalled();
  });

  it('is a 409 UNSUPPORTED_AGENT when the agent does not advertise sms.read', async () => {
    for (const reportedConfig of [
      null,
      { effective: {} },
      { effective: { agent: { build: { version: 'old' } } } },
      { effective: { agent: { capabilities: 'sms.read' } } },
      { effective: { agent: { capabilities: ['ota'] } } },
    ]) {
      devices[DEVICE].reportedConfig = reportedConfig;
      const res = await post();
      expect(status(res)).toBe(409);
      expect(parse(res).error.code).toBe('UNSUPPORTED_AGENT');
    }
    expect(reads).toHaveLength(0);
  });

  it('defaults the limit to 10 and clamps numbers to 1..50', async () => {
    const cases: [unknown, number][] = [
      [undefined, 10],
      [{}, 10],
      [{ limit: null }, 10],
      [{ limit: 0 }, 1],
      [{ limit: -5 }, 1],
      [{ limit: 51 }, 50],
      [{ limit: 1000 }, 50],
      [{ limit: 12.9 }, 12],
    ];
    for (const [body, limit] of cases) {
      const res = await post(body);
      expect(status(res), JSON.stringify(body)).toBe(202);
      expect(parse(res).limit).toBe(limit);
    }
  });

  it('is a 400 VALIDATION_ERROR for a non-numeric limit or a bad body', async () => {
    for (const body of [{ limit: 'ten' }, { limit: '25' }, { limit: true }, [1], 'x']) {
      const res = await post(body);
      expect(status(res), JSON.stringify(body)).toBe(400);
      expect(parse(res).error.code).toBe('VALIDATION_ERROR');
    }
    const res = await call('POST /devices/{id}/sms-reads', { body: '{not json' });
    expect(status(res)).toBe(400);
    expect(reads).toHaveLength(0);
  });

  it('marks the row error and answers 502 COMMAND_PUBLISH_FAILED when the publish fails', async () => {
    publishDeviceCommand.mockRejectedValueOnce(new Error('iot down'));
    const res = await post();
    expect(status(res)).toBe(502);
    expect(parse(res).error.code).toBe('COMMAND_PUBLISH_FAILED');
    expect(parse(res).error.details.readId).toBe(reads[0].id);
    expect(reads[0]).toMatchObject({ status: 'error', errorCode: 'publish_failed' });
    expect(reads[0].completedAt).toBeInstanceOf(Date);
  });
});

// ---- GET {readId} -----------------------------------------------------------
describe('GET /devices/{id}/sms-reads/{readId}', () => {
  it('returns the row', async () => {
    const row = seedRead({ createdAt: ago(2_000) });
    const res = await getRead(row.id);
    expect(status(res)).toBe(200);
    expect(parse(res)).toMatchObject({ id: row.id, status: 'pending', result: null });
  });

  it('expires a pending row older than 45 s, stores it, and returns it as expired', async () => {
    const row = seedRead({ createdAt: ago(46_000) });
    const res = await getRead(row.id);
    expect(status(res)).toBe(200);
    expect(parse(res)).toMatchObject({ status: 'expired', errorCode: 'timeout' });
    expect(parse(res).completedAt).not.toBeNull();
    expect(reads[0]).toMatchObject({ status: 'expired', errorCode: 'timeout' });
  });

  it('leaves a pending row inside the window alone', async () => {
    const row = seedRead({ createdAt: ago(30_000) });
    expect(parse(await getRead(row.id)).status).toBe('pending');
    expect(reads[0].status).toBe('pending');
  });

  it('works while the device is offline (polling an in-flight read)', async () => {
    const row = seedRead({ createdAt: ago(2_000), status: 'ok', completedAt: ago(1_000), result: { total: 0 } });
    devices[DEVICE].status = 'offline';
    expect(status(await getRead(row.id))).toBe(200);
  });

  it('is a 404 for an unknown id, another device\'s read, or a non-uuid id', async () => {
    const mine = seedRead({ createdAt: ago(1_000) });
    const theirs = seedRead({ createdAt: ago(1_000), deviceId: OTHER_DEVICE });
    expect(status(await getRead('01990000-0000-7000-8000-ffffffffffff'))).toBe(404);
    expect(status(await getRead(theirs.id))).toBe(404);
    expect(status(await getRead('not-a-uuid'))).toBe(404);
    expect(status(await getRead(mine.id))).toBe(200);
  });

  it('serves any member, viewer included, and refuses a non-member', async () => {
    const row = seedRead({ createdAt: ago(1_000) });
    auth = { userId: 'v', apiKeyId: null, organizationId: ORG, membershipRole: 'viewer' };
    expect(status(await getRead(row.id))).toBe(200);
    auth = null;
    expect(status(await getRead(row.id))).toBe(403);
  });
});

// ---- GET latest ---------------------------------------------------------------
describe('GET /devices/{id}/sms-reads/latest', () => {
  it('returns the newest ok read with its result, even while the device is offline', async () => {
    seedRead({ createdAt: ago(10_000), status: 'ok', completedAt: ago(9_000), result: { total: 1 } });
    const newest = seedRead({ createdAt: ago(5_000), status: 'ok', completedAt: ago(4_000), result: { total: 2 } });
    seedRead({ createdAt: ago(1_000), status: 'error', errorCode: 'modem_busy', completedAt: ago(500) });
    devices[DEVICE].status = 'offline';
    const res = await getLatest();
    expect(status(res)).toBe(200);
    expect(parse(res)).toMatchObject({ id: newest.id, status: 'ok', result: { total: 2 } });
  });

  it('is a 404 NO_SMS_READ when the device was never read (successfully)', async () => {
    seedRead({ createdAt: ago(1_000), status: 'error', errorCode: 'no_sim', completedAt: ago(500) });
    seedRead({ createdAt: ago(1_000), deviceId: OTHER_DEVICE, status: 'ok', completedAt: ago(500) });
    const res = await getLatest();
    expect(status(res)).toBe(404);
    expect(parse(res).error.code).toBe('NO_SMS_READ');
  });

  it('is routed as the literal, never parsed as a readId', async () => {
    const res = await getLatest();
    expect(parse(res).error.code).toBe('NO_SMS_READ'); // not the NOT_FOUND of a bad readId
  });

  it('is a 404 NOT_FOUND for a device outside the caller\'s workspaces', async () => {
    orgWorkspaceIds = ['ffffffff-0000-4000-8000-000000000001'];
    const res = await getLatest();
    expect(status(res)).toBe(404);
    expect(parse(res).error.code).toBe('NOT_FOUND');
  });
});

// ---- ingest -------------------------------------------------------------------
describe('device-sms-result ingest', () => {
  it('stores an ok reply on its pending row, minus the envelope', async () => {
    const row = seedRead({ createdAt: ago(3_000) });
    await ingest(reply(row.id));
    expect(reads[0]).toMatchObject({ status: 'ok', errorCode: null, errorMessage: null });
    expect(reads[0].completedAt).toBeInstanceOf(Date);
    expect(reads[0].result).toEqual({
      storage: { SM: { used: 7, total: 40 }, ME: { used: 23, total: 23 } },
      total: 30,
      skipped: 0,
      partial: false,
      durationMs: 3512,
      messages: [message],
    });
    // and the API serves it
    expect(parse(await getRead(row.id))).toMatchObject({ status: 'ok', result: { total: 30 } });
  });

  it('maps a device failure to error with the device status as errorCode', async () => {
    const row = seedRead({ createdAt: ago(3_000) });
    await ingest(reply(row.id, { status: 'modem_busy', error: 'EBUSY /dev/ttyUSB3', messages: [], total: 0 }));
    expect(reads[0]).toMatchObject({
      status: 'error',
      errorCode: 'modem_busy',
      errorMessage: 'EBUSY /dev/ttyUSB3',
      result: null,
    });
  });

  it('lands a slow reply on a row the GET already expired', async () => {
    const row = seedRead({ createdAt: ago(50_000), status: 'expired', errorCode: 'timeout', completedAt: ago(4_000) });
    await ingest(reply(row.id));
    expect(reads[0]).toMatchObject({ status: 'ok', errorCode: null });
  });

  it('ignores a reply published by another device (topic wins over body)', async () => {
    const row = seedRead({ createdAt: ago(3_000) });
    await ingest(reply(row.id, { topicDeviceId: OTHER_DEVICE, deviceId: OTHER_DEVICE }));
    expect(reads[0].status).toBe('pending');
    // and a body claiming to be the right device from the wrong topic is dropped too
    await ingest(reply(row.id, { topicDeviceId: OTHER_DEVICE }));
    expect(reads[0].status).toBe('pending');
  });

  it('ignores a duplicate reply for a row that is already terminal', async () => {
    const row = seedRead({ createdAt: ago(3_000) });
    await ingest(reply(row.id));
    const stored = { ...reads[0] };
    await ingest(reply(row.id, { status: 'error', error: 'late dup', messages: [], total: 0 }));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ status: 'ok', result: stored.result });
  });

  it('ok deletes the device\'s older rows only: not a newer pending row, not other devices\' rows', async () => {
    const oldOk = seedRead({ createdAt: ago(60_000), status: 'ok', completedAt: ago(59_000), result: { total: 1 } });
    const oldErr = seedRead({ createdAt: ago(40_000), status: 'error', errorCode: 'no_sim', completedAt: ago(39_000) });
    const oldExpired = seedRead({ createdAt: ago(30_000), status: 'expired', errorCode: 'timeout' });
    const target = seedRead({ createdAt: ago(10_000) });
    const newerPending = seedRead({ createdAt: ago(1_000) });
    const otherOld = seedRead({ createdAt: ago(60_000), deviceId: OTHER_DEVICE, status: 'ok', completedAt: ago(59_000) });

    await ingest(reply(target.id));

    const left = reads.map((r) => r.id).sort();
    expect(left).toEqual([target.id, newerPending.id, otherOld.id].sort());
    expect(left).not.toContain(oldOk.id);
    expect(left).not.toContain(oldErr.id);
    expect(left).not.toContain(oldExpired.id);
    expect(parse(await getLatest()).id).toBe(target.id);
  });

  it('an error deletes nothing and does not displace the stored copy', async () => {
    const stored = seedRead({ createdAt: ago(60_000), status: 'ok', completedAt: ago(59_000), result: { total: 1 } });
    const failing = seedRead({ createdAt: ago(5_000) });
    await ingest(reply(failing.id, { status: 'no_modem', error: 'no modem', messages: [], total: 0 }));
    expect(reads).toHaveLength(2);
    expect(parse(await getLatest()).id).toBe(stored.id);
  });

  it('drops invalid, oversized and topic-less payloads without touching the table', async () => {
    const row = seedRead({ createdAt: ago(3_000) });
    await ingest(reply(row.id, { requestId: 'not-a-uuid' }));
    await ingest(reply(row.id, { v: 2 }));
    await ingest(reply(row.id, { messages: Array.from({ length: 51 }, () => message) }));
    await ingest(reply(row.id, { topicDeviceId: undefined }));
    await ingest(reply(row.id, { messages: [{ ...message, text: 'x'.repeat(15_000) }], padding: 'y'.repeat(130_000) }));
    await ingest(null);
    expect(reads[0].status).toBe('pending');
  });

  it('never logs message text or sender numbers', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const row = seedRead({ createdAt: ago(3_000) });
    await ingest(reply(row.id));
    await ingest(reply(row.id, { messages: [{ ...message, unread: 'yes' }] })); // invalid -> issue log
    const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain(message.from);
    expect(logged).not.toContain('hello');
    log.mockRestore();
    error.mockRestore();
  });
});
