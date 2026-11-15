import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';

/**
 * DA1(b) + DA2: `GET /get/{code}` picks the installer by the registration's
 * agent. A legacy row (no agent) and a 'js' row both serve the JS golden, with
 * the same status and headers; a 'rust' row serves the Rust bootstrap golden,
 * but only while the stage flag allows Rust for the code's workspace.
 */

const JS_GOLDEN = readFileSync(join(__dirname, 'fixtures/install-script/js-prod.golden.sh'), 'utf8');
const RS_GOLDEN = readFileSync(join(__dirname, 'fixtures/install-script/rust-prod.golden.sh'), 'utf8');

const CODE = 'abcdefghijkmnpq2';
const WS = '0199a1b2-0000-7000-8000-000000000001';

let row: Record<string, unknown> | undefined;
vi.mock('../src/db/index', () => ({
  db: { query: { deviceRegistrations: { findFirst: async () => row } } },
  schema: realSchema,
}));
const { handler } = await import('../src/handlers/install-script');

type Res = Exclude<APIGatewayProxyResultV2, string>;
const get = async () =>
  (await handler({
    requestContext: { http: { method: 'GET' }, requestId: 'r' },
    pathParameters: { code: CODE },
    headers: {},
  } as unknown as APIGatewayProxyEventV2)) as Res;

const SHELL_HEADERS = {
  'Content-Type': 'text/x-shellscript; charset=utf-8',
  'Cache-Control': 'no-store',
};

const saved = { ...process.env };
beforeEach(() => {
  process.env.API_BASE_URL = 'https://fvcro5guw7.execute-api.us-east-1.amazonaws.com';
  process.env.DEVICE_DIST_BUCKET_URL =
    'https://xorgate-device-dist-865609249890-us-east-1.s3.us-east-1.amazonaws.com';
  process.env.DEVICE_DIST_VERSION = 'latest';
  process.env.RUST_AGENT_REGISTRATION = 'on';
});
afterEach(() => {
  process.env = { ...saved };
});

function pending(agent?: string) {
  const r: Record<string, unknown> = {
    id: 'r1',
    code: CODE,
    workspaceId: WS,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
  };
  if (agent !== undefined) r.agent = agent;
  return r;
}

describe('GET /get/{code}: installer by agent', () => {
  it('a legacy row with no agent serves the JS golden', async () => {
    row = pending();
    const res = await get();
    expect([res.statusCode, res.headers, res.body]).toEqual([200, SHELL_HEADERS, JS_GOLDEN]);
  });

  it('a js row serves the JS golden, even with the Rust flag off', async () => {
    for (const flag of ['on', 'off', '']) {
      process.env.RUST_AGENT_REGISTRATION = flag;
      row = pending('js');
      const res = await get();
      expect([res.statusCode, res.headers, res.body]).toEqual([200, SHELL_HEADERS, JS_GOLDEN]);
    }
  });

  it('a rust row serves the Rust bootstrap golden', async () => {
    row = pending('rust');
    const res = await get();
    expect([res.statusCode, res.headers, res.body]).toEqual([200, SHELL_HEADERS, RS_GOLDEN]);
  });

  it('a rust row with an allow-list naming its workspace serves the bootstrap', async () => {
    process.env.RUST_AGENT_REGISTRATION = `allow:${WS}`;
    row = pending('rust');
    expect((await get()).body).toBe(RS_GOLDEN);
  });

  it.each([['off'], [''], ['allow:0199a1b2-0000-7000-8000-0000000000ff'], ['garbage']])(
    'a rust row while the flag is %j → a refusing shell script (minted on, rendered off)',
    async (flag) => {
      if (flag === '') delete process.env.RUST_AGENT_REGISTRATION;
      else process.env.RUST_AGENT_REGISTRATION = flag;
      row = pending('rust');
      const res = await get();
      expect(res.statusCode).toBe(409);
      expect(res.headers).toEqual(SHELL_HEADERS);
      expect(res.body).toBe(
        '#!/usr/bin/env bash\nset -e\necho "[xorgate] Rust registration is not enabled here; generate a JS code in the web app" >&2\nexit 1\n',
      );
    },
  );

  it('used / expired rust codes get the same errors as JS codes', async () => {
    row = { ...pending('rust'), status: 'claimed' };
    expect((await get()).statusCode).toBe(410);
    row = { ...pending('rust'), status: 'expired' };
    expect((await get()).statusCode).toBe(410);
  });
});
