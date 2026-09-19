import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cross-organization transfer offers (transfer-device-ownership Phase 4).
 *
 * The lifecycle — create → preview → accept, create → cancel, create → expire —
 * plus the two properties that are security rather than behaviour:
 *
 *   1. **The code leaks nothing beyond the allowlist.** `GET /transfer-offers/{code}`
 *      is reached by an organization with no relationship to the device, holding
 *      nothing but a code. It may learn the device's name, its model and the
 *      offering organization's name. It may NOT learn the device id, the serial,
 *      the workspace, the configuration or any telemetry. The test asserts the
 *      absences, because those are what a regression would add back.
 *   2. **Accepting is race-safe.** The `pending -> accepted` flip is a
 *      conditional write that happens BEFORE the transfer runs, so a double
 *      accept is refused by the database rather than by a check-then-act that
 *      two concurrent requests both pass.
 *
 * The store below is a small in-memory stand-in for the two tables; drizzle
 * expressions are matched by their bound literals, which is enough because every
 * query here is an equality on ids.
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

const { AuthError } = await vi.importActual<typeof import('../src/middleware/auth')>(
  '../src/middleware/auth',
);

const requireOrgWideContext = vi.fn(async (_event: unknown, roles?: string[]) => {
  if (roles && !roles.includes(auth.membershipRole)) {
    throw new AuthError(
      `Requires one of: ${roles.join(', ')}. You have: ${auth.membershipRole}.`,
      403,
      'INSUFFICIENT_ROLE',
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

let orgWorkspaceIds: string[];
vi.mock('../src/services/workspace-scope', () => ({
  resolveWorkspaceScope: async () => orgWorkspaceIds,
  isWorkspaceScoped: () => false,
}));

const transferDevice = vi.fn();
const reconcileStaleTransfers = vi.fn(async () => undefined);
const attachmentsAtRiskOnOrgChange = vi.fn(async () => [] as { templateName: string }[]);
vi.mock('../src/services/device-transfer', async () => {
  const actual = await vi.importActual<typeof import('../src/services/device-transfer')>(
    '../src/services/device-transfer',
  );
  return {
    ...actual,
    transferDevice,
    reconcileStaleTransfers,
    attachmentsAtRiskOnOrgChange,
    previewTransfer: vi.fn(),
  };
});
const { TransferError } = await import('../src/services/device-transfer');

vi.mock('../src/utils/registration-code', () => ({
  generateRegistrationCode: () => `code-${codeCounter++}`,
}));
let codeCounter = 1;

// ---- the store ------------------------------------------------------------

type OfferRow = Record<string, any>;
let offers: OfferRow[];
let devices: Record<string, any>;
let workspaces: { id: string; organizationId: string }[];
let organizations: { id: string; name: string }[];
let models: { id: string; name: string; sku: string }[];

vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  const literals = (where: unknown): string[] => {
    const out: string[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (Array.isArray(node.queryChunks)) node.queryChunks.forEach(walk);
      // A bound Param carries a primitive `value`; a StringChunk carries an
      // ARRAY of literal SQL fragments ('(', ' and ', ' = '). Only the former is
      // a value anyone bound, so the array form is skipped rather than collected
      // as noise every matcher would then have to tolerate.
      if (node.value !== undefined && !Array.isArray(node.value) && typeof node.value !== 'object') {
        out.push(String(node.value));
      }
    };
    walk(where);
    return out;
  };
  /** Every literal in the expression must be present on the row (as any value). */
  const matches = (row: OfferRow, where: unknown): boolean => {
    const wanted = literals(where);
    const have = new Set(Object.values(row).map((v) => String(v)));
    return wanted.every((w) => have.has(w) || w === 'pending' || w === 'now()');
  };

  const db = {
    query: {
      deviceTransferOffers: {
        findFirst: async ({ where }: { where: unknown }) =>
          offers.find((o) => literals(where).every((w) => String(o.code) === w || String(o.id) === w || String(o.deviceId) === w || o.status === w)),
        findMany: async ({ where }: { where: unknown }) => {
          const wanted = literals(where);
          return offers.filter((o) =>
            wanted.some(
              (w) =>
                String(o.deviceId) === w ||
                String(o.fromOrganizationId) === w ||
                String(o.acceptedByOrganizationId) === w,
            ),
          );
        },
      },
      devices: {
        findFirst: async ({ where }: { where: unknown }) => {
          const id = literals(where).find((v) => v in devices);
          return id ? devices[id] : undefined;
        },
      },
      organizations: {
        findFirst: async ({ where }: { where: unknown }) => {
          const bound = literals(where);
          return organizations.find((o) => bound.includes(o.id));
        },
      },
      workspaces: {
        findFirst: async ({ where }: { where: unknown }) => {
          const bound = literals(where);
          return workspaces.find((w) => bound.includes(w.id) && bound.includes(w.organizationId));
        },
      },
      memberships: { findFirst: async () => undefined },
    },
    select: (cols: Record<string, unknown>) => {
      const self: Record<string, any> = {};
      let where: unknown;
      for (const k of ['from', 'innerJoin']) self[k] = () => self;
      self.where = (w: unknown) => {
        where = w;
        return self;
      };
      self.limit = async () => {
        const bound = literals(where);
        const id = bound.find((v) => v in devices);
        if (!id) return [];
        const device = devices[id];
        // `callerOwnsDevice` asks for the id; the offer-accept staleness check
        // asks for the device's organization through its workspace.
        if ('organizationId' in cols) {
          const ws = workspaces.find((w) => w.id === device.workspaceId);
          return ws ? [{ organizationId: ws.organizationId }] : [];
        }
        if ('modelId' in cols) {
          const model = models.find((m) => m.id === device.deviceModelId);
          return model
            ? [{ name: device.name, modelId: model.id, modelName: model.name, modelSku: model.sku }]
            : [];
        }
        return orgWorkspaceIds.includes(device.workspaceId) ? [{ id }] : [];
      };
      return self;
    },
    insert: () => ({
      values: (values: OfferRow) => ({
        returning: async () => {
          const row = {
            id: `offer-${offers.length + 1}`,
            status: 'pending',
            acceptedByOrganizationId: null,
            acceptedWorkspaceId: null,
            resolvedAt: null,
            resolvedByUserId: null,
            transferId: null,
            createdAt: new Date(),
            ...values,
          };
          offers.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (values: OfferRow) => {
        const chain: Record<string, any> = {};
        let where: unknown;
        chain.where = (w: unknown) => {
          where = w;
          return chain;
        };
        const apply = () => {
          const row = offers.find((o) => matches(o, where));
          if (!row) return [];
          Object.assign(row, values);
          return [row];
        };
        chain.returning = async () => apply();
        chain.then = (onF: any, onR: any) => Promise.resolve().then(apply).then(onF, onR);
        chain.catch = (onR: any) => Promise.resolve().then(apply).catch(onR);
        return chain;
      },
    }),
  };
  return { schema, db };
});

const { handler } = await import('../src/handlers/device-transfer');

// ---------------------------------------------------------------------------

const DEVICE = 'dddddddd-0000-4000-8000-000000000001';
const WS_SOURCE = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_DEST = 'bbbbbbbb-0000-4000-8000-000000000001';
const ORG_SOURCE = 'cccccccc-0000-4000-8000-00000000000a';
const ORG_DEST = 'cccccccc-0000-4000-8000-00000000000b';
const MODEL = 'eeeeeeee-0000-4000-8000-000000000001';

function ev(
  routeKey: string,
  over: Record<string, unknown> = {},
): APIGatewayProxyEventV2 {
  const [method, path] = routeKey.split(' ');
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: { http: { method }, requestId: 'req-1' },
    pathParameters: {},
    isBase64Encoded: false,
    routeKey,
    ...over,
  } as unknown as APIGatewayProxyEventV2;
}

const status = (r: unknown) => (r as { statusCode: number }).statusCode;
const parse = (r: unknown): any => JSON.parse((r as { body: string }).body);

function asSource(): void {
  auth = {
    userId: 'user-source',
    apiKeyId: null,
    organizationId: ORG_SOURCE,
    membershipRole: 'admin',
    allowedWorkspaceId: null,
  };
  orgWorkspaceIds = [WS_SOURCE];
}
function asDestination(role = 'admin'): void {
  auth = {
    userId: 'user-dest',
    apiKeyId: null,
    organizationId: ORG_DEST,
    membershipRole: role,
    allowedWorkspaceId: null,
  };
  orgWorkspaceIds = [WS_DEST];
}

async function createOffer(): Promise<any> {
  asSource();
  const res = await handler(
    ev('POST /v1/devices/{id}/transfer-offers', { pathParameters: { id: DEVICE } }),
  );
  return { res, body: parse(res) };
}

beforeEach(() => {
  vi.clearAllMocks();
  codeCounter = 1;
  offers = [];
  devices = {
    [DEVICE]: {
      id: DEVICE,
      name: 'Tacloban 01',
      serial: 'xg-secret-serial',
      workspaceId: WS_SOURCE,
      deviceModelId: MODEL,
      agentVersion: 'v0.0.6',
      config: {},
      uiPrefs: {},
    },
  };
  workspaces = [
    { id: WS_SOURCE, organizationId: ORG_SOURCE },
    { id: WS_DEST, organizationId: ORG_DEST },
  ];
  organizations = [
    { id: ORG_SOURCE, name: 'Alocate' },
    { id: ORG_DEST, name: 'CaingTrucking' },
  ];
  models = [{ id: MODEL, name: 'Argus CM5', sku: 'argus-cm5' }];
  attachmentsAtRiskOnOrgChange.mockResolvedValue([]);
  transferDevice.mockResolvedValue({
    transferId: 'tr-1',
    deviceId: DEVICE,
    from: { workspaceId: WS_SOURCE, organizationId: ORG_SOURCE },
    to: { workspaceId: WS_DEST, organizationId: ORG_DEST },
    crossOrg: true,
    detachedWorkflowAttachments: ['Harsh braking alert'],
    kvsChannelsRetagged: 2,
    scopeAttributes: 'written',
    adoption: 'pending',
    warnings: [],
  });
  asSource();
});

describe('create', () => {
  it('mints a code and names what a cross-org acceptance would detach', async () => {
    attachmentsAtRiskOnOrgChange.mockResolvedValue([
      { templateName: 'Harsh braking alert' } as never,
      { templateName: 'Nightly summary' } as never,
    ]);
    const { res, body } = await createOffer();
    expect(status(res)).toBe(201);
    expect(body.offer).toMatchObject({
      status: 'pending',
      direction: 'outgoing',
      deviceId: DEVICE,
      deviceName: 'Tacloban 01',
    });
    expect(body.offer.code).toBe('code-1');
    // README §4.5: the SOURCE loses these and is not present at acceptance.
    expect(body.willDetachWorkflowAttachments).toEqual([
      'Harsh braking alert',
      'Nightly summary',
    ]);
    // Expiry is 7 days, not the 15 minutes an install code gets.
    const ttl = new Date(body.offer.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(ttl).toBeLessThan(7.1 * 24 * 3600 * 1000);
  });

  it('is idempotent: a second create returns the open offer with 200, not a second code', async () => {
    const first = await createOffer();
    const second = await createOffer();
    expect(status(first.res)).toBe(201);
    expect(status(second.res)).toBe(200);
    expect(second.body.offer.code).toBe(first.body.offer.code);
    expect(offers).toHaveLength(1);
  });

  it('403s a member', async () => {
    asSource();
    auth.membershipRole = 'member';
    const res = await handler(
      ev('POST /v1/devices/{id}/transfer-offers', { pathParameters: { id: DEVICE } }),
    );
    expect(status(res)).toBe(403);
  });

  it('404s a device the caller does not own', async () => {
    asDestination();
    const res = await handler(
      ev('POST /v1/devices/{id}/transfer-offers', { pathParameters: { id: DEVICE } }),
    );
    expect(status(res)).toBe(404);
  });
});

describe('preview by code — the allowlist', () => {
  it('gives the destination exactly what it needs to decide', async () => {
    const { body } = await createOffer();
    asDestination('viewer'); // any role may read a code they were sent
    const res = await handler(
      ev('GET /v1/transfer-offers/{code}', { pathParameters: { code: body.offer.code } }),
    );
    expect(status(res)).toBe(200);
    const offer = parse(res).offer;
    expect(offer).toMatchObject({
      status: 'pending',
      device: { name: 'Tacloban 01', model: { name: 'Argus CM5', sku: 'argus-cm5' } },
      from: { organizationName: 'Alocate' },
    });
  });

  it('leaks nothing beyond it', async () => {
    const { body } = await createOffer();
    asDestination();
    const res = await handler(
      ev('GET /v1/transfer-offers/{code}', { pathParameters: { code: body.offer.code } }),
    );
    const raw = (res as { body: string }).body;
    // The negative assertions are the ones that catch a regression.
    for (const secret of [DEVICE, 'xg-secret-serial', WS_SOURCE, ORG_SOURCE]) {
      expect(raw).not.toContain(secret);
    }
    const offer = parse(res).offer;
    expect(offer.deviceId).toBeUndefined();
    expect(offer.device.serial).toBeUndefined();
    expect(offer.from.organizationId).toBeUndefined();
  });

  it('404s an unknown code', async () => {
    asDestination();
    const res = await handler(
      ev('GET /v1/transfer-offers/{code}', { pathParameters: { code: 'nope' } }),
    );
    expect(status(res)).toBe(404);
  });
});

describe('accept', () => {
  async function accept(code: string, workspaceId = WS_DEST) {
    return handler(
      ev('POST /v1/transfer-offers/{code}/accept', {
        pathParameters: { code },
        body: JSON.stringify({ workspaceId }),
      }),
    );
  }

  it('transfers the device and links the offer to the transfer', async () => {
    const { body } = await createOffer();
    asDestination();
    const res = await accept(body.offer.code);
    expect(status(res)).toBe(200);
    const out = parse(res);
    expect(out.transfer.id).toBe('tr-1');
    expect(out.transfer.detachedWorkflowAttachments).toEqual(['Harsh braking alert']);
    expect(out.offer.status).toBe('accepted');
    expect(out.offer.transferId).toBe('tr-1');
    expect(out.device.id).toBe(DEVICE);
    expect(transferDevice).toHaveBeenCalledWith({
      deviceId: DEVICE,
      toWorkspaceId: WS_DEST,
      actor: { userId: 'user-dest', apiKeyId: null },
      offerId: 'offer-1',
    });
  });

  it('rejects a double accept — the flip is conditional, not check-then-act', async () => {
    const { body } = await createOffer();
    asDestination();
    expect(status(await accept(body.offer.code))).toBe(200);
    const second = await accept(body.offer.code);
    expect(status(second)).toBe(409);
    expect(parse(second).error.message).toContain('already accepted');
    expect(transferDevice).toHaveBeenCalledTimes(1);
  });

  it('403s a member of the accepting organization', async () => {
    const { body } = await createOffer();
    asDestination('member');
    expect(status(await accept(body.offer.code))).toBe(403);
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('404s a workspace that is not the accepter\'s', async () => {
    const { body } = await createOffer();
    asDestination();
    expect(status(await accept(body.offer.code, WS_SOURCE))).toBe(404);
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('400s the sender accepting its own offer', async () => {
    const { body } = await createOffer();
    asSource();
    orgWorkspaceIds = [WS_SOURCE];
    const res = await accept(body.offer.code, WS_SOURCE);
    expect(status(res)).toBe(400);
    expect(parse(res).error.message).toContain('/devices/{id}/transfer');
  });

  it('409s a stale offer whose device has since left the offering organization', async () => {
    const { body } = await createOffer();
    devices[DEVICE].workspaceId = WS_DEST; // somebody else already took it
    asDestination();
    const res = await accept(body.offer.code);
    expect(status(res)).toBe(409);
    expect(parse(res).error.message).toContain('stale');
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('409s an expired offer and leaves it expired', async () => {
    const { body } = await createOffer();
    offers[0].expiresAt = new Date(Date.now() - 1000);
    asDestination();
    const res = await accept(body.offer.code);
    expect(status(res)).toBe(409);
    expect(offers[0].status).toBe('expired');
    expect(transferDevice).not.toHaveBeenCalled();
  });

  it('puts the offer back to pending when the transfer itself fails', async () => {
    const { body } = await createOffer();
    transferDevice.mockRejectedValue(new TransferError('serial exists', 409, 'SERIAL_COLLISION'));
    asDestination();
    const res = await accept(body.offer.code);
    expect(status(res)).toBe(409);
    expect(parse(res).error.code).toBe('SERIAL_COLLISION');
    expect(offers[0].status).toBe('pending');
    expect(offers[0].acceptedByOrganizationId).toBeNull();
  });

  it('502s an unexpected engine failure and still reopens the offer', async () => {
    const { body } = await createOffer();
    transferDevice.mockRejectedValue(new Error('iot unavailable'));
    asDestination();
    const res = await accept(body.offer.code);
    expect(status(res)).toBe(502);
    expect(parse(res).error.message).toContain('still open');
    expect(offers[0].status).toBe('pending');
  });
});

describe('decline and cancel', () => {
  it('lets the destination decline, and the source sees it', async () => {
    const { body } = await createOffer();
    asDestination();
    const res = await handler(
      ev('POST /v1/transfer-offers/{code}/decline', { pathParameters: { code: body.offer.code } }),
    );
    expect(status(res)).toBe(200);
    expect(parse(res).offer.status).toBe('declined');

    asSource();
    const listed = await handler(ev('GET /v1/transfer-offers'));
    const [offer] = parse(listed).offers;
    expect(offer.status).toBe('declined');
    expect(offer.direction).toBe('outgoing');
    expect(offer.resolvedAt).not.toBeNull();
  });

  it('lets the source cancel, and then the code is dead', async () => {
    const { body } = await createOffer();
    const cancelled = await handler(
      ev('DELETE /v1/transfer-offers/{code}', { pathParameters: { code: body.offer.code } }),
    );
    expect(status(cancelled)).toBe(204);

    asDestination();
    const accept = await handler(
      ev('POST /v1/transfer-offers/{code}/accept', {
        pathParameters: { code: body.offer.code },
        body: JSON.stringify({ workspaceId: WS_DEST }),
      }),
    );
    expect(status(accept)).toBe(409);
  });

  it('404s a cancel from another organization rather than 403ing it', async () => {
    const { body } = await createOffer();
    asDestination();
    const res = await handler(
      ev('DELETE /v1/transfer-offers/{code}', { pathParameters: { code: body.offer.code } }),
    );
    expect(status(res)).toBe(404);
    expect(offers[0].status).toBe('pending');
  });

  it('409s a cancel of an already-resolved offer', async () => {
    const { body } = await createOffer();
    offers[0].status = 'accepted';
    const res = await handler(
      ev('DELETE /v1/transfer-offers/{code}', { pathParameters: { code: body.offer.code } }),
    );
    expect(status(res)).toBe(409);
  });
});

describe('expiry', () => {
  it('flips a stale pending offer to expired on read, with no sweeper job', async () => {
    const { body } = await createOffer();
    offers[0].expiresAt = new Date(Date.now() - 1000);
    asDestination();
    const res = await handler(
      ev('GET /v1/transfer-offers/{code}', { pathParameters: { code: body.offer.code } }),
    );
    expect(parse(res).offer.status).toBe('expired');
    expect(offers[0].status).toBe('expired');
  });

  it('lets a new offer be minted once the old one has expired', async () => {
    const first = await createOffer();
    offers[0].expiresAt = new Date(Date.now() - 1000);
    const second = await createOffer();
    expect(status(second.res)).toBe(201);
    expect(second.body.offer.code).not.toBe(first.body.offer.code);
    expect(offers).toHaveLength(2);
  });
});

describe('listing', () => {
  it('400s an unknown status filter', async () => {
    const res = await handler(
      ev('GET /v1/transfer-offers', { queryStringParameters: { status: 'weird' } }),
    );
    expect(status(res)).toBe(400);
  });

  it('filters by status', async () => {
    await createOffer();
    const pending = await handler(
      ev('GET /v1/transfer-offers', { queryStringParameters: { status: 'pending' } }),
    );
    expect(parse(pending).offers).toHaveLength(1);
    const accepted = await handler(
      ev('GET /v1/transfer-offers', { queryStringParameters: { status: 'accepted' } }),
    );
    expect(parse(accepted).offers).toHaveLength(0);
  });
});
