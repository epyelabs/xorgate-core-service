import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as realSchema from '../src/db/schema';
import { parseListParams } from '../src/utils/list-params';
import { errorResponse } from '../src/utils/responses';
import { apiHandler } from '../src/utils/api-handler';
import { getRequestId, setRequestId } from '../src/utils/request-context';

/**
 * Phase 5 of plans/sdk-packages-and-alocate-pilot (API productization):
 *
 * - 5.2 `limit` above the maximum is a 400 everywhere, never a silent clamp.
 * - 5.3 every error body carries the gateway `requestId`, including the
 *   envelope an unhandled throw is turned into.
 * - 5.4 `PATCH /memberships/{id}` changes a role in place, with the
 *   owner-level gate and the last-owner guard.
 */

function event(partial: Record<string, unknown> = {}): APIGatewayProxyEventV2 {
  return {
    requestContext: { requestId: 'req-123', http: { method: 'GET' } },
    headers: {},
    ...partial,
  } as unknown as APIGatewayProxyEventV2;
}

function body(res: APIGatewayProxyResultV2): Record<string, any> {
  return JSON.parse((res as { body: string }).body);
}

describe('parseListParams limit behaviour (5.2)', () => {
  it('rejects a limit above maxLimit with a 400 instead of clamping', () => {
    const parsed = parseListParams(event({ queryStringParameters: { limit: '501' } }));
    expect('error' in parsed).toBe(true);
    const res = (parsed as { error: APIGatewayProxyResultV2 }).error;
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(body(res).error.message).toBe('"limit" must be between 1 and 500');
  });

  it('accepts a limit at exactly maxLimit', () => {
    const parsed = parseListParams(event({ queryStringParameters: { limit: '500' } }));
    expect('error' in parsed).toBe(false);
    expect((parsed as { limit: number }).limit).toBe(500);
  });

  it('still rejects non-integers and zero the old way', () => {
    for (const limit of ['abc', '0', '-1', '1.5']) {
      const parsed = parseListParams(event({ queryStringParameters: { limit } }));
      expect('error' in parsed, `limit=${limit}`).toBe(true);
    }
  });
});

describe('requestId in error bodies (5.3)', () => {
  beforeEach(() => setRequestId(undefined));

  it('errorResponse carries the ambient request id', () => {
    setRequestId('req-abc');
    const res = errorResponse(404, 'NOT_FOUND', 'nope');
    expect(body(res).error).toEqual({
      code: 'NOT_FOUND',
      message: 'nope',
      requestId: 'req-abc',
    });
  });

  it('errorResponse omits requestId when no ambient id is set', () => {
    const res = errorResponse(400, 'BAD_REQUEST', 'nope');
    expect(body(res).error).toEqual({ code: 'BAD_REQUEST', message: 'nope' });
  });

  it('apiHandler stamps the id, so a handler-built error carries it', async () => {
    const wrapped = apiHandler(async () => errorResponse(403, 'FORBIDDEN', 'no'));
    const res = await wrapped(event());
    expect(body(res).error.requestId).toBe('req-123');
  });

  it('apiHandler turns an unhandled throw into a SERVER_ERROR envelope with the id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = apiHandler(async () => {
      throw new Error('boom');
    });
    const res = await wrapped(event());
    expect((res as { statusCode: number }).statusCode).toBe(500);
    expect(body(res).error).toEqual({
      code: 'SERVER_ERROR',
      message: 'Internal server error.',
      requestId: 'req-123',
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('apiHandler clears the ambient id afterwards, success or throw', async () => {
    const okWrapped = apiHandler(async () => ({ statusCode: 200, body: '{}' }));
    await okWrapped(event());
    expect(getRequestId()).toBeUndefined();

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwWrapped = apiHandler(async () => {
      throw new Error('boom');
    });
    await throwWrapped(event());
    expect(getRequestId()).toBeUndefined();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PATCH /memberships/{id} (5.4). The db and auth middleware are mocked; the
// guards under test are pure handler logic.
// ---------------------------------------------------------------------------

const findFirst = vi.fn();
const findMany = vi.fn();
const returning = vi.fn();
const updateWhere = vi.fn(() => ({ returning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

vi.mock('../src/db/index', () => ({
  db: {
    query: {
      memberships: {
        findFirst: (...a: unknown[]) => findFirst(...a),
        findMany: (...a: unknown[]) => findMany(...a),
      },
      users: { findMany: async () => [] },
    },
    update,
  },
  schema: realSchema,
}));

// The real middleware constructs a CognitoJwtVerifier at module scope, which
// needs a pool id; fake the verifier the same way auth-middleware.test.ts does
// so importing the middleware is env-free.
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));

const requireOrgWideContext = vi.fn();
vi.mock('../src/middleware/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...real,
    requireOrgWideContext: (...a: unknown[]) => requireOrgWideContext(...a),
  };
});

const { handler: membershipsHandler } = await import('../src/handlers/memberships');

const ORG = '0f0e0d0c-0b0a-4908-8706-050403020100';
const MEMBERSHIP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function patchEvent(role: string): APIGatewayProxyEventV2 {
  return event({
    requestContext: { requestId: 'req-123', http: { method: 'PATCH' } },
    pathParameters: { id: MEMBERSHIP },
    body: JSON.stringify({ role }),
  });
}

function callerIs(membershipRole: string): void {
  requireOrgWideContext.mockResolvedValue({
    userId: 'caller',
    organizationId: ORG,
    membershipRole,
  });
}

function targetRow(role: string): Record<string, unknown> {
  return { id: MEMBERSHIP, userId: 'target', organizationId: ORG, role };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /memberships/{id} (5.4)', () => {
  it('updates a role and returns the updated membership', async () => {
    callerIs('admin');
    findFirst.mockResolvedValue(targetRow('member'));
    returning.mockResolvedValue([targetRow('viewer')]);
    const res = await membershipsHandler(patchEvent('viewer'));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(body(res).membership.role).toBe('viewer');
    expect(update).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith({ role: 'viewer' });
  });

  it('rejects an unknown role with a 400', async () => {
    callerIs('owner');
    const res = await membershipsHandler(patchEvent('emperor'));
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('404s a membership outside the active organization', async () => {
    callerIs('owner');
    findFirst.mockResolvedValue(undefined);
    const res = await membershipsHandler(patchEvent('admin'));
    expect((res as { statusCode: number }).statusCode).toBe(404);
  });

  it('refuses an admin promoting anyone to owner', async () => {
    callerIs('admin');
    findFirst.mockResolvedValue(targetRow('member'));
    const res = await membershipsHandler(patchEvent('owner'));
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(body(res).error.message).toMatch(/Only owners/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an admin demoting an owner', async () => {
    callerIs('admin');
    findFirst.mockResolvedValue(targetRow('owner'));
    const res = await membershipsHandler(patchEvent('member'));
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses demoting the last owner, even for an owner', async () => {
    callerIs('owner');
    findFirst.mockResolvedValue(targetRow('owner'));
    findMany.mockResolvedValue([targetRow('owner')]); // the only owner
    const res = await membershipsHandler(patchEvent('admin'));
    expect((res as { statusCode: number }).statusCode).toBe(403);
    expect(body(res).error.message).toMatch(/last owner/);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets an owner demote another owner when two exist', async () => {
    callerIs('owner');
    findFirst.mockResolvedValue(targetRow('owner'));
    findMany.mockResolvedValue([targetRow('owner'), { ...targetRow('owner'), id: 'other' }]);
    returning.mockResolvedValue([targetRow('admin')]);
    const res = await membershipsHandler(patchEvent('admin'));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(body(res).membership.role).toBe('admin');
  });

  it('same-role PATCH is a no-op 200 that writes nothing', async () => {
    callerIs('admin');
    findFirst.mockResolvedValue(targetRow('member'));
    const res = await membershipsHandler(patchEvent('member'));
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect(body(res).membership.role).toBe('member');
    expect(update).not.toHaveBeenCalled();
  });
});
