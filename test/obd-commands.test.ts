import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `obd_scan` / `obd_forget` on the device-commands Lambda
 * (plans/obd2-bluetooth-integration, P3 backend): routes, role gates, the
 * OBD-model fence, the online check, and the 60 s per-device scan rate limit
 * (one conditional UPDATE on `devices.obd_scan_requested_at`).
 *
 * The db fake applies the claim rule semantically: an UPDATE that sets
 * `obdScanRequestedAt` and binds a threshold Date in its WHERE is the claim
 * (NULL or older than the threshold passes); one without a bound Date is the
 * release after a failed publish.
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
vi.mock('../src/services/device-command', async () => {
  const actual = await vi.importActual<typeof import('../src/services/device-command')>(
    '../src/services/device-command',
  );
  return { ...actual, publishDeviceCommand };
});

/** Which devices are on a model that declares peripherals.obd. */
let obdDevices: Set<string>;
const deviceDeclaresObd = vi.fn(async (id: string) => obdDevices.has(id));
vi.mock('../src/services/device-config', () => ({ deviceDeclaresObd }));

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const PLAIN_DEVICE = 'dddddddd-0000-4000-8000-000000000002';
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';

interface DeviceRow {
  id: string;
  name: string | null;
  serial: string | null;
  status: string;
  workspaceId: string;
  obdScanRequestedAt: Date | null;
}
let devices: Record<string, DeviceRow>;

function boundStrings(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') return void out.push(n);
    if (typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (Array.isArray(n.queryChunks)) return n.queryChunks.forEach(walk);
    if ('encoder' in n && 'value' in n && typeof n.value === 'string') out.push(n.value);
  };
  walk(node);
  return out;
}
function boundDates(node: unknown): Date[] {
  const out: Date[] = [];
  const walk = (n: any): void => {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (n instanceof Date) return void out.push(n);
    if (Array.isArray(n)) return n.forEach(walk);
    if (Array.isArray(n.queryChunks)) return n.queryChunks.forEach(walk);
    if ('encoder' in n && 'value' in n) walk(n.value);
  };
  walk(node);
  return out;
}

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const db = {
    query: {
      devices: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = boundStrings(where).find((v) => v in devices);
          if (!id) return undefined;
          return orgWorkspaceIds.includes(devices[id].workspaceId) ? { ...devices[id] } : undefined;
        },
      },
    },
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: (where: unknown) => {
          const apply = () => {
            const id = boundStrings(where).find((v) => v in devices);
            if (!id) return [];
            const row = devices[id];
            const [threshold] = boundDates(where);
            if (threshold) {
              const last = row.obdScanRequestedAt;
              if (last !== null && !(last.getTime() < threshold.getTime())) return [];
            }
            Object.assign(row, vals);
            return [{ id: row.id }];
          };
          const p = Promise.resolve().then(apply);
          return Object.assign(p, { returning: () => p });
        },
      }),
    }),
  };
  return { schema, db };
});

const { handler } = await import('../src/handlers/device-commands');

function event(routeKey: string, deviceId = DEVICE): APIGatewayProxyEventV2 {
  const [method, path] = routeKey.split(' ');
  return {
    version: '2.0',
    routeKey: `${method} /v1${path}`,
    rawPath: `/v1${path}`,
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method }, requestId: 'req-1' },
    pathParameters: { id: deviceId },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}
const status = (r: unknown) => (r as { statusCode: number }).statusCode;
const parse = (r: unknown) => JSON.parse((r as { body: string }).body);
const scan = (deviceId = DEVICE) => handler(event('POST /devices/{id}/commands/obd-scan', deviceId));
const forget = (deviceId = DEVICE) => handler(event('POST /devices/{id}/commands/obd-forget', deviceId));

beforeEach(() => {
  vi.useRealTimers();
  auth = { userId: 'user-1', apiKeyId: null, organizationId: 'org', membershipRole: 'member' };
  orgWorkspaceIds = [WS];
  obdDevices = new Set([DEVICE]);
  devices = {
    [DEVICE]: { id: DEVICE, name: 'Bench', serial: 'S1', status: 'online', workspaceId: WS, obdScanRequestedAt: null },
    [PLAIN_DEVICE]: { id: PLAIN_DEVICE, name: 'Plain', serial: 'S2', status: 'online', workspaceId: WS, obdScanRequestedAt: null },
  };
  publishDeviceCommand.mockReset();
  publishDeviceCommand.mockImplementation(async (deviceId: string, command: string) => ({
    v: 1,
    requestId: 'req-uuid',
    command,
    ts: 1,
    expiresAt: 60_001,
  }));
  requireOrgContext.mockClear();
  deviceDeclaresObd.mockClear();
});

describe('POST /devices/{id}/commands/obd-scan', () => {
  it('publishes obd_scan, records the slot, and answers 202 with the flat ack', async () => {
    const res = await scan();
    expect(status(res)).toBe(202);
    expect(parse(res)).toEqual({ requestId: 'req-uuid', command: 'obd_scan', expiresAt: 60_001 });
    expect(publishDeviceCommand).toHaveBeenCalledWith(DEVICE, 'obd_scan');
    expect(devices[DEVICE].obdScanRequestedAt).toBeInstanceOf(Date);
  });

  it('takes the any-member gate, like refresh-state', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      devices[DEVICE].obdScanRequestedAt = null;
      auth = { ...auth!, membershipRole: role };
      expect(status(await scan()), role).toBe(202);
    }
    expect(requireOrgContext).toHaveBeenLastCalledWith(expect.anything(), undefined);
  });

  it('is a 400 NOT_OBD_DEVICE for a device whose model does not declare peripherals.obd, online or not', async () => {
    const res = await scan(PLAIN_DEVICE);
    expect(status(res)).toBe(400);
    expect(parse(res).error.code).toBe('NOT_OBD_DEVICE');
    expect(parse(res).error.message).toContain('peripherals.obd');
    devices[PLAIN_DEVICE].status = 'offline';
    expect(status(await scan(PLAIN_DEVICE))).toBe(400);
    expect(publishDeviceCommand).not.toHaveBeenCalled();
    expect(devices[PLAIN_DEVICE].obdScanRequestedAt).toBeNull();
  });

  it('is a 409 when the device is offline, without consuming the slot', async () => {
    devices[DEVICE].status = 'offline';
    const res = await scan();
    expect(status(res)).toBe(409);
    expect(publishDeviceCommand).not.toHaveBeenCalled();
    expect(devices[DEVICE].obdScanRequestedAt).toBeNull();
  });

  it('is a 403 for a non-member and a 404 for a device outside the caller\'s workspaces', async () => {
    auth = null;
    expect(status(await scan())).toBe(403);
    auth = { userId: 'user-1', apiKeyId: null, organizationId: 'org', membershipRole: 'member' };
    orgWorkspaceIds = ['bbbbbbbb-0000-4000-8000-000000000001'];
    expect(status(await scan())).toBe(404);
  });

  it('rate-limits to one scan per device per 60 s with a 429 and retryAfterMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    expect(status(await scan())).toBe(202);
    vi.setSystemTime(new Date('2026-10-13T12:00:20Z'));
    const res = await scan();
    expect(status(res)).toBe(429);
    const err = parse(res).error;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.details.retryAfterMs).toBe(40_000);
    expect((res as { headers: Record<string, string> }).headers['Retry-After']).toBe('40');
    expect(publishDeviceCommand).toHaveBeenCalledTimes(1);
    // Another device has its own slot.
    obdDevices.add(PLAIN_DEVICE);
    expect(status(await scan(PLAIN_DEVICE))).toBe(202);
    // The window is over at 60 s.
    vi.setSystemTime(new Date('2026-10-13T12:01:00.001Z'));
    expect(status(await scan())).toBe(202);
    expect(publishDeviceCommand).toHaveBeenCalledTimes(3);
  });

  it('releases the slot and answers 502 COMMAND_PUBLISH_FAILED when the publish fails', async () => {
    const before = new Date('2026-10-13T11:00:00Z');
    devices[DEVICE].obdScanRequestedAt = before;
    publishDeviceCommand.mockRejectedValueOnce(new Error('broker down'));
    const res = await scan();
    expect(status(res)).toBe(502);
    expect(parse(res).error.code).toBe('COMMAND_PUBLISH_FAILED');
    expect(devices[DEVICE].obdScanRequestedAt).toEqual(before);
    // ... so the retry goes straight through.
    expect(status(await scan())).toBe(202);
  });
});

describe('POST /devices/{id}/commands/obd-forget', () => {
  it('publishes obd_forget and answers 202, with no rate limit', async () => {
    expect(status(await forget())).toBe(202);
    expect(status(await forget())).toBe(202);
    expect(publishDeviceCommand).toHaveBeenNthCalledWith(1, DEVICE, 'obd_forget');
    expect(parse(await forget()).command).toBe('obd_forget');
    expect(devices[DEVICE].obdScanRequestedAt).toBeNull();
  });

  it('takes the ordinary write gate: owner/admin/member 202, viewer 403 INSUFFICIENT_ROLE', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      auth = { ...auth!, membershipRole: role };
      expect(status(await forget()), role).toBe(202);
    }
    auth = { ...auth!, membershipRole: 'viewer' };
    const res = await forget();
    expect(status(res)).toBe(403);
    expect(parse(res).error.code).toBe('INSUFFICIENT_ROLE');
    expect(requireOrgContext).toHaveBeenLastCalledWith(expect.anything(), ['owner', 'admin', 'member']);
  });

  it('is a 400 NOT_OBD_DEVICE for a plain device and a 409 for an offline OBD device', async () => {
    expect(parse(await forget(PLAIN_DEVICE)).error.code).toBe('NOT_OBD_DEVICE');
    devices[DEVICE].status = 'offline';
    expect(status(await forget())).toBe(409);
    expect(publishDeviceCommand).not.toHaveBeenCalled();
  });
});

describe('the existing commands', () => {
  it('keep their gates and skip the OBD fence', async () => {
    auth = { ...auth!, membershipRole: 'member' };
    expect(status(await handler(event('POST /devices/{id}/reboot', PLAIN_DEVICE)))).toBe(403);
    expect(status(await handler(event('POST /devices/{id}/refresh-state', PLAIN_DEVICE)))).toBe(202);
    auth = { ...auth!, membershipRole: 'admin' };
    expect(status(await handler(event('POST /devices/{id}/reboot', PLAIN_DEVICE)))).toBe(202);
    expect(status(await handler(event('POST /devices/{id}/power-off', PLAIN_DEVICE)))).toBe(202);
    expect(status(await handler(event('POST /devices/{id}/update', PLAIN_DEVICE)))).toBe(202);
    expect(deviceDeclaresObd).not.toHaveBeenCalled();
  });
});
