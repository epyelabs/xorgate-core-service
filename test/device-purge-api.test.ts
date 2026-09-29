import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/devices/{id}/purges` (plans/device-wf-data-delete, Phase 1 §1.8): the HTTP
 * skin. Who is refused and how, what the POST records and hands to the queue,
 * and the two 409s. The job itself is `device-purge-job.test.ts`.
 *
 * The gates are reproduced, not mocked away: the fake `requireOrgWideContext`
 * applies the role and workspace rules the real one does, and the fake
 * `requireOrgContext` only the role rule, so the handler's CHOICE of gate per
 * route is what is under test.
 */

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

interface FakeAuth {
  userId: string | null;
  apiKeyId: string | null;
  organizationId: string;
  membershipRole: string;
  allowedWorkspaceId: string | null;
}
let auth: FakeAuth;

const { AuthError } = await vi.importActual<typeof import('../src/middleware/auth')>('../src/middleware/auth');

const roleGate = (roles?: string[]) => {
  if (roles && !roles.includes(auth.membershipRole)) {
    throw new AuthError(`Requires one of: ${roles.join(', ')}.`, 403, 'INSUFFICIENT_ROLE');
  }
};
const requireOrgContext = vi.fn(async (_e: unknown, roles?: string[]) => {
  roleGate(roles);
  return auth;
});
const requireOrgWideContext = vi.fn(async (_e: unknown, roles?: string[]) => {
  roleGate(roles);
  if (auth.allowedWorkspaceId !== null) {
    throw new AuthError('workspace-scoped token; operation is organization-wide.', 403, 'WORKSPACE_SCOPED');
  }
  return auth;
});
vi.mock('../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth')>('../src/middleware/auth');
  return { ...actual, requireOrgContext, requireOrgWideContext };
});

let orgWorkspaceIds: string[];
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => orgWorkspaceIds,
  isWorkspaceScoped: () => false,
}));

const enqueueModelJob = vi.fn();
vi.mock('../src/services/model-jobs', () => ({ enqueueModelJob }));

// ---- db fake ---------------------------------------------------------------
let devices: Record<string, { id: string; workspaceId: string }>;
let pendingOffer: { id: string } | undefined;
let activePurge: Record<string, unknown> | undefined;
let purges: Record<string, unknown>[];
const inserted: Record<string, unknown>[] = [];
const updates: { vals: Record<string, unknown> }[] = [];
let executeCalls = 0;

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const values = (where: unknown): string[] => {
    const out: string[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (Array.isArray(node.queryChunks)) node.queryChunks.forEach(walk);
      if (node.value !== undefined && !Array.isArray(node.value) && typeof node.value !== 'object') {
        out.push(String(node.value));
      }
    };
    walk(where);
    return out;
  };
  const db = {
    query: {
      devices: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = values(where).find((v) => v in devices);
          if (!id) return undefined;
          return orgWorkspaceIds.includes(devices[id].workspaceId) ? devices[id] : undefined;
        },
      },
      deviceTransferOffers: { findFirst: async () => pendingOffer },
      devicePurges: {
        findFirst: async ({ where }: { where: unknown }) => {
          const bound = values(where);
          const byId = purges.find((p) => bound.includes(p.id as string));
          return byId ?? activePurge;
        },
        findMany: async ({ limit }: { limit: number }) => purges.slice(0, limit),
      },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          inserted.push(v);
          return [{ ...v, cursor: null, error: null, startedAt: null, finishedAt: null, leaseUntil: null }];
        },
      }),
    }),
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ vals });
        },
      }),
    }),
    execute: async () => {
      executeCalls += 1;
      // count queries answer `n`; the span query answers from/to. One shape serves both.
      return { rows: [{ n: executeCalls, from: '2026-09-01T00:00:00.000Z', to: '2026-09-28T00:00:00.000Z' }] };
    },
  };
  return { schema, db };
});

const { handleDevicePurgeRoutes } = await import('../src/handlers/device-purges');

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG = 'cccccccc-0000-4000-8000-00000000000a';
const PURGE = '01997a00-0000-7000-8000-000000000001';

function event(routeKey: string, over: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  const [method] = routeKey.split(' ');
  return {
    version: '2.0',
    rawPath: routeKey.split(' ')[1],
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method }, requestId: 'req-1' },
    pathParameters: { id: DEVICE },
    isBase64Encoded: false,
    ...over,
  } as unknown as APIGatewayProxyEventV2;
}
const call = (routeKey: string, over: Partial<APIGatewayProxyEventV2> = {}) =>
  handleDevicePurgeRoutes(event(routeKey, over), routeKey, DEVICE);
const post = (body: unknown) => call('POST /devices/{id}/purges', { body: JSON.stringify(body) });
const status = (r: unknown) => (r as { statusCode: number }).statusCode;
const parse = (r: unknown) => JSON.parse((r as { body: string }).body);

beforeEach(() => {
  vi.clearAllMocks();
  auth = { userId: 'user-1', apiKeyId: null, organizationId: ORG, membershipRole: 'owner', allowedWorkspaceId: null };
  orgWorkspaceIds = [WS];
  devices = { [DEVICE]: { id: DEVICE, workspaceId: WS } };
  pendingOffer = undefined;
  activePurge = undefined;
  purges = [];
  inserted.length = 0;
  updates.length = 0;
  executeCalls = 0;
  enqueueModelJob.mockResolvedValue(undefined);
});

describe('POST /devices/{id}/purges', () => {
  it('records the row, queues the job and answers 202', async () => {
    const res = await post({ scopes: ['media', 'workflows', 'media'] });
    expect(status(res)).toBe(202);
    const { purge } = parse(res);
    expect(purge.status).toBe('queued');
    expect(purge.scopes).toEqual(['media', 'workflows']);
    expect(purge.deviceId).toBe(DEVICE);
    expect(purge.workspaceId).toBe(WS);
    expect(purge.organizationId).toBe(ORG);
    expect(purge.requestedBy).toBe('user-1');
    expect(purge.stalled).toBe(false);
    expect(typeof purge.cutoff).toBe('string');
    expect(enqueueModelJob).toHaveBeenCalledWith({ kind: 'device_purge', purgeId: purge.id });
    expect(requireOrgWideContext).toHaveBeenCalledWith(expect.anything(), ['owner', 'admin']);
  });

  it('names the API key when a key asked', async () => {
    auth = { ...auth, userId: null, apiKeyId: 'key-9' };
    const res = await post({ scopes: ['telemetry'] });
    expect(parse(res).purge.requestedBy).toBe('key-9');
  });

  it('admits admin, refuses member and viewer with INSUFFICIENT_ROLE', async () => {
    auth.membershipRole = 'admin';
    expect(status(await post({ scopes: ['media'] }))).toBe(202);
    for (const role of ['member', 'viewer']) {
      auth.membershipRole = role;
      const res = await post({ scopes: ['media'] });
      expect(status(res)).toBe(403);
      expect(parse(res).error.code).toBe('INSUFFICIENT_ROLE');
    }
    expect(enqueueModelJob).toHaveBeenCalledTimes(1);
  });

  it('refuses a workspace-scoped session token whatever its role', async () => {
    auth.allowedWorkspaceId = WS;
    const res = await post({ scopes: ['media'] });
    expect(status(res)).toBe(403);
    expect(parse(res).error.code).toBe('WORKSPACE_SCOPED');
    expect(inserted).toHaveLength(0);
  });

  it('is a 404 for a device outside the caller\'s workspaces', async () => {
    devices[DEVICE].workspaceId = 'ffffffff-0000-4000-8000-000000000001';
    const res = await post({ scopes: ['media'] });
    expect(status(res)).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it('rejects an empty, missing or unknown scope list', async () => {
    for (const body of [{}, { scopes: [] }, { scopes: 'media' }, { scopes: ['media', 'identity'] }]) {
      const res = await post(body);
      expect(status(res)).toBe(400);
    }
    expect(inserted).toHaveLength(0);
  });

  it('is a 409 PURGE_IN_PROGRESS while another purge holds a live lease', async () => {
    activePurge = { id: PURGE, status: 'running', leaseUntil: new Date(Date.now() + 60_000) };
    const res = await post({ scopes: ['media'] });
    expect(status(res)).toBe(409);
    expect(parse(res).error.code).toBe('PURGE_IN_PROGRESS');
    expect(parse(res).error.details.purgeId).toBe(PURGE);
    expect(inserted).toHaveLength(0);
  });

  it('closes a stalled purge as failed and starts a new one', async () => {
    activePurge = { id: PURGE, status: 'running', leaseUntil: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    const res = await post({ scopes: ['media'] });
    expect(status(res)).toBe(202);
    expect(updates[0].vals).toMatchObject({ status: 'failed', error: 'abandoned' });
    expect(inserted).toHaveLength(1);
  });

  it('is a 409 TRANSFER_PENDING while a cross-org offer is open', async () => {
    pendingOffer = { id: 'offer-1' };
    const res = await post({ scopes: ['media'] });
    expect(status(res)).toBe(409);
    expect(parse(res).error.code).toBe('TRANSFER_PENDING');
    expect(inserted).toHaveLength(0);
  });

  it('marks the row failed and answers 502 when the queue refuses the message', async () => {
    enqueueModelJob.mockRejectedValueOnce(new Error('sqs down'));
    const res = await post({ scopes: ['media'] });
    expect(status(res)).toBe(502);
    expect(parse(res).error.code).toBe('PURGE_DISPATCH_FAILED');
    expect(updates.at(-1)?.vals).toMatchObject({ status: 'failed', error: 'DISPATCH_FAILED' });
  });
});

describe('GET routes', () => {
  it('preview answers the four counts and the readings span', async () => {
    const res = await call('GET /devices/{id}/purges/preview');
    expect(status(res)).toBe(200);
    expect(parse(res)).toEqual({
      workflows: { attachments: 1, runs: 2 },
      telemetry: { sessions: 3, readingsFrom: '2026-09-01T00:00:00.000Z', readingsTo: '2026-09-28T00:00:00.000Z' },
      media: { sessions: 4 },
    });
    expect(requireOrgContext).toHaveBeenCalledWith(expect.anything(), ['owner', 'admin']);
  });

  it('reads are allowed to a workspace-scoped token (the device is in its scope)', async () => {
    auth.allowedWorkspaceId = WS;
    expect(status(await call('GET /devices/{id}/purges'))).toBe(200);
  });

  it('reads still need owner|admin', async () => {
    auth.membershipRole = 'member';
    expect(status(await call('GET /devices/{id}/purges/preview'))).toBe(403);
  });

  it('list clamps limit to 20 and returns newest first as given by the store', async () => {
    purges = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, status: 'succeeded', leaseUntil: null }));
    const res = await call('GET /devices/{id}/purges', { queryStringParameters: { limit: '100' } });
    expect(parse(res).purges).toHaveLength(20);
    expect(parse(res).purges[0]).toMatchObject({ id: 'p0', stalled: false });
    const dflt = await call('GET /devices/{id}/purges');
    expect(parse(dflt).purges).toHaveLength(10);
  });

  it('get answers the row with stalled computed, and 404 for an unknown id', async () => {
    purges = [{ id: PURGE, status: 'running', leaseUntil: new Date(Date.now() - 2 * 60 * 60 * 1000) }];
    const res = await handleDevicePurgeRoutes(
      event('GET /devices/{id}/purges/{purgeId}', { pathParameters: { id: DEVICE, purgeId: PURGE } }),
      'GET /devices/{id}/purges/{purgeId}',
      DEVICE,
    );
    expect(status(res)).toBe(200);
    expect(parse(res).purge.stalled).toBe(true);
    const missing = await handleDevicePurgeRoutes(
      event('GET /devices/{id}/purges/{purgeId}', { pathParameters: { id: DEVICE, purgeId: 'nope' } }),
      'GET /devices/{id}/purges/{purgeId}',
      DEVICE,
    );
    expect(status(missing)).toBe(404);
  });
});
