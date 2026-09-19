import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The transfer routes (transfer-device-ownership Phase 3 + Phase 4.4).
 *
 * This file is about the HTTP skin, not the ordered sequence — `device-transfer.test.ts`
 * owns that. What matters here is who is refused and how:
 *
 *   - `owner|admin` only, matching `DELETE /devices/{id}`. A `member` may edit a
 *     device but must not give it away.
 *   - a workspace-scoped session token is refused outright, because a transfer
 *     spans TWO workspaces and such a credential is confined to one;
 *   - a destination outside the caller's organization is a **404**, never a 403
 *     and never a 400 — confirming another tenant's workspace exists is a leak,
 *     and the negative assertion (the response body does not name the other
 *     tenant) is the one that actually catches a regression.
 *
 * The auth gate is reproduced here rather than mocked away: the fake
 * `requireOrgWideContext` applies the same two rules the real one does, so the
 * handler's CHOICE of gate and role list is what is under test. The middleware's
 * own enforcement is covered by `auth-middleware.test.ts`.
 */

// The middleware builds a Cognito verifier at module load; nothing here goes
// near a JWT, so the constructor just needs to not explode on an absent pool id.
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

const { AuthError } = await vi.importActual<
  typeof import('../src/middleware/auth')
>('../src/middleware/auth');

const requireOrgWideContext = vi.fn(async (_event: unknown, roles?: string[]) => {
  if (roles && !roles.includes(auth.membershipRole)) {
    throw new AuthError(
      `Requires one of: ${roles.join(', ')}. You have: ${auth.membershipRole}.`,
      403,
      'INSUFFICIENT_ROLE',
    );
  }
  if (auth.allowedWorkspaceId !== null) {
    throw new AuthError(
      'This session token is scoped to a single workspace; this operation is organization-wide.',
      403,
      'WORKSPACE_SCOPED',
    );
  }
  return auth;
});
vi.mock('../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
    '../src/middleware/auth',
  );
  return { ...actual, requireOrgWideContext };
});

/** Workspaces the caller's own organization owns. */
let orgWorkspaceIds: string[];
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => orgWorkspaceIds,
  isWorkspaceScoped: () => false,
}));

const transferDevice = vi.fn();
const previewTransfer = vi.fn();
vi.mock('../src/services/device-transfer', async () => {
  const actual = await vi.importActual<typeof import('../src/services/device-transfer')>(
    '../src/services/device-transfer',
  );
  // The REAL TransferError, so the handler's `instanceof` mapping is exercised.
  return { ...actual, transferDevice, previewTransfer };
});

const { TransferError } = await import('../src/services/device-transfer');

/** Device rows visible to `callerOwnsDevice` / the response read, keyed by id. */
let devices: Record<string, Record<string, unknown>>;
let memberships: { userId: string; organizationId: string; role: string }[];
let workspaces: { id: string; organizationId: string }[];

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  /** Pull the literal bind values out of a drizzle expression; enough to match on. */
  const values = (where: unknown): string[] => {
    const out: string[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (Array.isArray(node.queryChunks)) node.queryChunks.forEach(walk);
      if (node.value !== undefined && typeof node.value !== 'object') out.push(String(node.value));
      if (Array.isArray(node.value)) node.value.forEach((v: unknown) => out.push(String(v)));
    };
    walk(where);
    return out;
  };
  const db = {
    // Only `callerOwnsDevice` uses the builder form.
    select: () => {
      const self: Record<string, unknown> = {};
      let where: unknown;
      for (const k of ['from', 'innerJoin']) self[k] = () => self;
      self.where = (w: unknown) => {
        where = w;
        return self;
      };
      self.limit = async () => {
        const bound = values(where);
        const id = bound.find((v) => v in devices);
        if (!id) return [];
        const row = devices[id];
        return orgWorkspaceIds.includes(row.workspaceId as string) ? [{ id }] : [];
      };
      return self;
    },
    query: {
      devices: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = values(where).find((v) => v in devices);
          return id ? devices[id] : undefined;
        },
      },
      memberships: {
        findFirst: async ({ where }: { where: unknown }) => {
          const bound = values(where);
          return memberships.find(
            (m) => bound.includes(m.userId) && bound.includes(m.organizationId),
          );
        },
      },
      workspaces: {
        findFirst: async ({ where }: { where: unknown }) => {
          const bound = values(where);
          return workspaces.find(
            (w) => bound.includes(w.id) && bound.includes(w.organizationId),
          );
        },
      },
    },
  };
  return { schema, db };
});

const { handler } = await import('../src/handlers/device-transfer');

// ---------------------------------------------------------------------------

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const WS_OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_NEW = 'bbbbbbbb-0000-4000-8000-000000000001';
const WS_FOREIGN = 'ffffffff-0000-4000-8000-000000000001';
const ORG_A = 'cccccccc-0000-4000-8000-00000000000a';
const ORG_B = 'cccccccc-0000-4000-8000-00000000000b';

function event(over: Partial<APIGatewayProxyEventV2> & { routeKey: string }): APIGatewayProxyEventV2 {
  const [method] = over.routeKey.split(' ');
  return {
    version: '2.0',
    rawPath: over.routeKey.split(' ')[1],
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method }, requestId: 'req-1' },
    pathParameters: { id: DEVICE },
    isBase64Encoded: false,
    ...over,
  } as unknown as APIGatewayProxyEventV2;
}

function transferEvent(body: Record<string, unknown>): APIGatewayProxyEventV2 {
  return event({ routeKey: 'POST /v1/devices/{id}/transfer', body: JSON.stringify(body) });
}

function previewEvent(query: Record<string, string>): APIGatewayProxyEventV2 {
  return event({
    routeKey: 'GET /v1/devices/{id}/transfer/preview',
    queryStringParameters: query,
  });
}

function parse(result: unknown): any {
  return JSON.parse((result as { body: string }).body);
}

const SUMMARY = {
  transferId: 'tr-1',
  deviceId: DEVICE,
  from: { workspaceId: WS_OLD, organizationId: ORG_A },
  to: { workspaceId: WS_NEW, organizationId: ORG_A },
  crossOrg: false,
  detachedWorkflowAttachments: [],
  kvsChannelsRetagged: 2,
  scopeAttributes: 'written' as const,
  adoption: 'pending' as const,
  warnings: ['device is offline; it will pick this up when it next connects'],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth = {
    userId: 'user-1',
    apiKeyId: null,
    organizationId: ORG_A,
    membershipRole: 'admin',
    allowedWorkspaceId: null,
  };
  orgWorkspaceIds = [WS_OLD, WS_NEW];
  devices = {
    [DEVICE]: {
      id: DEVICE,
      workspaceId: WS_NEW,
      agentVersion: 'v0.0.6',
      config: {},
      uiPrefs: {},
    },
  };
  memberships = [{ userId: 'user-1', organizationId: ORG_A, role: 'admin' }];
  workspaces = [
    { id: WS_OLD, organizationId: ORG_A },
    { id: WS_NEW, organizationId: ORG_A },
    { id: WS_FOREIGN, organizationId: ORG_B },
  ];
  transferDevice.mockResolvedValue(SUMMARY);
  previewTransfer.mockResolvedValue({ deviceId: DEVICE, blockers: [], warnings: [] });
});

describe('POST /devices/{id}/transfer', () => {
  it('transfers and returns the device alongside the summary', async () => {
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const body = parse(res);
    expect(body.device.id).toBe(DEVICE);
    // `firmwareVersion` is the transition-window alias the deployed frontend
    // still parses strictly; it has to survive this route too.
    expect(body.device.firmwareVersion).toBe('v0.0.6');
    expect(body.transfer).toMatchObject({
      id: 'tr-1',
      adoption: 'pending',
      scopeAttributes: 'written',
    });
    expect(body.transfer.transferId).toBeUndefined();
    expect(body.transfer.warnings).toHaveLength(1);
    expect(transferDevice).toHaveBeenCalledWith({
      deviceId: DEVICE,
      toWorkspaceId: WS_NEW,
      actor: { userId: 'user-1', apiKeyId: null },
    });
  });

  it('gates on owner|admin', async () => {
    await handler(transferEvent({ workspaceId: WS_NEW }));
    expect(requireOrgWideContext.mock.calls[0][1]).toEqual(['owner', 'admin']);
  });

  it.each(['member', 'viewer'])('403s a %s', async (role) => {
    auth.membershipRole = role;
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(parse(res).error.code).toBe('INSUFFICIENT_ROLE');
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('accepts an API-key principal holding the key role, and attributes the transfer to the key', async () => {
    auth = { ...auth, userId: null, apiKeyId: 'key-1', membershipRole: 'owner' };
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(transferDevice).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userId: null, apiKeyId: 'key-1' } }),
    );
  });

  it('403s an API key whose role is too low — the key column stands in for a membership role', async () => {
    auth = { ...auth, userId: null, apiKeyId: 'key-1', membershipRole: 'member' };
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(403);
  });

  it('403s a workspace-scoped session token: a transfer spans two workspaces', async () => {
    auth.allowedWorkspaceId = WS_OLD;
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(parse(res).error.code).toBe('WORKSPACE_SCOPED');
  });

  it('404s a destination workspace in another organization, and leaks nothing about it', async () => {
    const res = await handler(transferEvent({ workspaceId: WS_FOREIGN }));
    expect((res as { statusCode: number }).statusCode).toBe(404);
    const body = parse(res);
    expect(body.error.code).toBe('NOT_FOUND');
    // Not a 403, and no mention of the other organization.
    expect(JSON.stringify(body)).not.toContain(ORG_B);
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('404s a device the caller does not own, indistinguishably from one that is absent', async () => {
    devices[DEVICE].workspaceId = WS_FOREIGN;
    const absent = await handler(
      event({ routeKey: 'POST /v1/devices/{id}/transfer', pathParameters: { id: 'nope' }, body: '{}' }),
    );
    const foreign = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((absent as { statusCode: number }).statusCode).toBe(404);
    expect((foreign as { statusCode: number }).statusCode).toBe(404);
  });

  it('400s a missing, malformed or unknown field', async () => {
    expect((await handler(transferEvent({})) as { statusCode: number }).statusCode).toBe(400);
    expect(
      ((await handler(transferEvent({ workspaceId: 42 }))) as { statusCode: number }).statusCode,
    ).toBe(400);
    const unknown = await handler(transferEvent({ workspaceId: WS_NEW, purge: true }));
    expect((unknown as { statusCode: number }).statusCode).toBe(400);
    expect(parse(unknown).error.message).toContain('purge');
  });

  it('maps a TransferError onto its own status code', async () => {
    transferDevice.mockRejectedValue(
      new TransferError('serial exists', 409, 'SERIAL_COLLISION'),
    );
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(409);
    expect(parse(res).error.code).toBe('SERIAL_COLLISION');
  });

  it('502s an unexpected engine failure and says nothing changed', async () => {
    transferDevice.mockRejectedValue(new Error('iot unavailable'));
    const res = await handler(transferEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(502);
    const body = parse(res);
    expect(body.error.code).toBe('TRANSFER_FAILED');
    expect(body.error.message).toContain('nothing changed');
  });
});

describe('POST /devices/{id}/transfer — cross-org fast path', () => {
  beforeEach(() => {
    memberships.push({ userId: 'user-1', organizationId: ORG_B, role: 'owner' });
  });

  it('accepts a destination organization the caller also administers', async () => {
    const res = await handler(
      transferEvent({ workspaceId: WS_FOREIGN, organizationId: ORG_B }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(transferDevice).toHaveBeenCalledWith(
      expect.objectContaining({ toWorkspaceId: WS_FOREIGN }),
    );
  });

  it('403s when the caller is only a member of the destination', async () => {
    memberships = memberships.map((m) =>
      m.organizationId === ORG_B ? { ...m, role: 'member' } : m,
    );
    const res = await handler(
      transferEvent({ workspaceId: WS_FOREIGN, organizationId: ORG_B }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(parse(res).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('404s an organization the caller is not in at all', async () => {
    memberships = memberships.filter((m) => m.organizationId !== ORG_B);
    const res = await handler(
      transferEvent({ workspaceId: WS_FOREIGN, organizationId: ORG_B }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(404);
  });

  it('refuses an API key and points it at the offer handshake', async () => {
    auth = { ...auth, userId: null, apiKeyId: 'key-1', membershipRole: 'owner' };
    const res = await handler(
      transferEvent({ workspaceId: WS_FOREIGN, organizationId: ORG_B }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(parse(res).error.message).toContain('transfer offer');
  });

  it('404s a destination workspace that belongs to a different organization than claimed', async () => {
    const res = await handler(transferEvent({ workspaceId: WS_OLD, organizationId: ORG_B }));
    expect((res as { statusCode: number }).statusCode).toBe(404);
  });
});

describe('GET /devices/{id}/transfer/preview', () => {
  it('returns the preview under a `preview` key and writes nothing', async () => {
    previewTransfer.mockResolvedValue({
      deviceId: DEVICE,
      crossOrg: true,
      carriesHistory: true,
      workflowAttachments: [{ id: 'a', templateId: 't', templateName: 'Harsh braking' }],
      blockers: [],
      warnings: [],
    });
    const res = await handler(previewEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(parse(res).preview.workflowAttachments[0].templateName).toBe('Harsh braking');
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('400s without a destination', async () => {
    const res = await handler(previewEvent({}));
    expect((res as { statusCode: number }).statusCode).toBe(400);
  });

  it('applies the same destination check as the transfer itself', async () => {
    const res = await handler(previewEvent({ workspaceId: WS_FOREIGN }));
    expect((res as { statusCode: number }).statusCode).toBe(404);
    expect(previewTransfer).not.toHaveBeenCalled();
  });

  it('gates on owner|admin, like the transfer it previews', async () => {
    auth.membershipRole = 'member';
    const res = await handler(previewEvent({ workspaceId: WS_NEW }));
    expect((res as { statusCode: number }).statusCode).toBe(403);
  });
});
