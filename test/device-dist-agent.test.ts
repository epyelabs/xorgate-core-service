import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DA2 (device-dist half), dual-agent registration D3:
 *
 * - NO `agent` parameter: today's response, status and body, byte for byte.
 *   Alocate's backend/mobile/web consume it as "the JS latest".
 * - `?agent=js|rust`: always names its agent, carries `latest` (null when the
 *   manifest is unpublished: 200, NEVER 404, which the SDK reads as "old
 *   backend") and `registrationEnabled` from the stage flag for the caller's
 *   X-Workspace-Id. Invalid → 400 INVALID_AGENT.
 */

process.env.DEVICE_DIST_BUCKET = 'dist-bucket';

let objects: Record<string, string>;
let s3Error: { name: string } | null;
const gets: string[] = [];
vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: class {
    constructor(public input: { Bucket: string; Key: string }) {}
  },
  S3Client: class {
    async send(cmd: { input: { Key: string } }) {
      gets.push(cmd.input.Key);
      if (s3Error) throw s3Error;
      const body = objects[cmd.input.Key];
      if (body === undefined) {
        const e = new Error('nope');
        e.name = 'NoSuchKey';
        throw e;
      }
      return { Body: { transformToString: async () => body } };
    }
  },
}));

vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));
vi.mock('../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
    '../src/middleware/auth',
  );
  return {
    ...actual,
    requireOrgWideContext: async () => ({
      userId: 'user-1',
      apiKeyId: null,
      organizationId: 'org-1',
      membershipRole: 'member',
      allowedWorkspaceId: null,
    }),
  };
});
const WS = '0199a1b2-0000-7000-8000-000000000001';
const WS_FOREIGN = '0199a1b2-0000-7000-8000-0000000000ff';
vi.mock('../src/services/workspace-scope', () => ({ resolveWorkspaceScope: async () => [WS] }));

const { handler } = await import('../src/handlers/device-dist');

const JS_MANIFEST =
  '{ "version": "09da38d", "channel": "dev", "builtAt": "2026-11-10T12:00:00Z",\n' +
  '  "packageVersion": "0.2.0", "tarball": "xorgate-agent-09da38d.tar.gz" }\n';
const RS_MANIFEST =
  '{ "version": "14413e0", "channel": "dev", "builtAt": "2026-11-14T18:22:22Z",\n' +
  '  "packageVersion": "0.0.1", "tarball": "xorgate-agent-rs-14413e0.tar.gz" }\n';

type Res = Exclude<APIGatewayProxyResultV2, string>;
async function get(query?: Record<string, string>, headers: Record<string, string> = {}) {
  return (await handler({
    requestContext: { http: { method: 'GET' }, requestId: 'req-1' },
    queryStringParameters: query,
    headers,
  } as unknown as APIGatewayProxyEventV2)) as Res;
}

const saved = process.env.RUST_AGENT_REGISTRATION;
beforeEach(() => {
  objects = { 'latest.json': JS_MANIFEST, 'latest-rs.json': RS_MANIFEST };
  s3Error = null;
  gets.length = 0;
  process.env.RUST_AGENT_REGISTRATION = 'on';
});
afterEach(() => {
  if (saved === undefined) delete process.env.RUST_AGENT_REGISTRATION;
  else process.env.RUST_AGENT_REGISTRATION = saved;
  vi.restoreAllMocks();
});

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('GET /device-dist/latest with no agent parameter: unchanged', () => {
  it('200 body is exactly today\'s', async () => {
    for (const q of [undefined, {}, { other: 'x' }]) {
      const res = await get(q);
      expect(res.statusCode).toBe(200);
      expect(res.headers).toEqual(JSON_HEADERS);
      expect(res.body).toBe(
        '{"latest":{"version":"09da38d","channel":"dev","builtAt":"2026-11-10T12:00:00Z",' +
          '"packageVersion":"0.2.0","tarball":"xorgate-agent-09da38d.tar.gz"}}',
      );
    }
    expect(new Set(gets)).toEqual(new Set(['latest.json']));
  });

  it('reads latest.json even when the Rust flag is off', async () => {
    process.env.RUST_AGENT_REGISTRATION = 'off';
    expect((await get()).statusCode).toBe(200);
  });

  it('an unpublished manifest is still today\'s 404', async () => {
    delete objects['latest.json'];
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(
      '{"error":{"code":"NOT_FOUND","message":"No published agent build manifest yet","requestId":"req-1"}}',
    );
  });

  it('read and parse failures keep today\'s 502 bodies', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    s3Error = { name: 'AccessDenied' };
    let res = await get();
    expect([res.statusCode, res.body]).toEqual([
      502,
      '{"error":{"code":"DIST_MANIFEST_UNAVAILABLE","message":"Could not read the latest agent build manifest.","requestId":"req-1"}}',
    ]);
    s3Error = null;
    const invalid =
      '{"error":{"code":"DIST_MANIFEST_INVALID","message":"The agent build manifest is unreadable.","requestId":"req-1"}}';
    for (const body of ['', 'x'.repeat(8193), '{not json', '{"version":"  "}', '{"channel":"dev"}']) {
      objects['latest.json'] = body;
      res = await get();
      expect([res.statusCode, res.body]).toEqual([502, invalid]);
    }
  });

  it('a manifest with only a version nulls the other four fields, as today', async () => {
    objects['latest.json'] = '{"version":" abc ","channel":"","builtAt":3}';
    expect((await get()).body).toBe(
      '{"latest":{"version":"abc","channel":null,"builtAt":null,"packageVersion":null,"tarball":null}}',
    );
  });
});

describe('GET /device-dist/latest?agent=: self-describing channel', () => {
  it('?agent=rust → the Rust manifest, named, with registrationEnabled', async () => {
    const res = await get({ agent: 'rust' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({
      agent: 'rust',
      latest: {
        version: '14413e0',
        channel: 'dev',
        builtAt: '2026-11-14T18:22:22Z',
        packageVersion: '0.0.1',
        tarball: 'xorgate-agent-rs-14413e0.tar.gz',
      },
      registrationEnabled: true,
    });
    expect(gets).toEqual(['latest-rs.json']);
  });

  it('?agent=js → the JS manifest, named, always registrationEnabled', async () => {
    process.env.RUST_AGENT_REGISTRATION = 'off';
    const body = JSON.parse((await get({ agent: 'js' })).body as string);
    expect(body.agent).toBe('js');
    expect(body.latest.version).toBe('09da38d');
    expect(body.registrationEnabled).toBe(true);
    expect(gets).toEqual(['latest.json']);
  });

  it('S1: an unpublished Rust manifest is 200 with latest:null, never 404', async () => {
    delete objects['latest-rs.json'];
    const res = await get({ agent: 'rust' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({
      agent: 'rust',
      latest: null,
      registrationEnabled: true,
    });
  });

  it('S1: an unpublished JS manifest on the channel route is 200 with latest:null too', async () => {
    delete objects['latest.json'];
    const res = await get({ agent: 'js' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ agent: 'js', latest: null, registrationEnabled: true });
  });

  it.each([['RUST'], [''], ['node'], ['js,rust']])('?agent=%j → 400 INVALID_AGENT', async (a) => {
    const res = await get({ agent: a });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body as string).error.code).toBe('INVALID_AGENT');
    expect(gets).toEqual([]);
  });

  it('flag off → registrationEnabled false, latest still served', async () => {
    process.env.RUST_AGENT_REGISTRATION = 'off';
    const body = JSON.parse((await get({ agent: 'rust' })).body as string);
    expect(body.registrationEnabled).toBe(false);
    expect(body.latest.version).toBe('14413e0');
  });

  it('flag unset or malformed → registrationEnabled false (fails closed)', async () => {
    for (const f of [undefined, '', 'yes', 'allow:']) {
      if (f === undefined) delete process.env.RUST_AGENT_REGISTRATION;
      else process.env.RUST_AGENT_REGISTRATION = f;
      expect(JSON.parse((await get({ agent: 'rust' }, { 'x-workspace-id': WS })).body as string).registrationEnabled).toBe(false);
    }
  });

  it('allow:<ws> → true only for that workspace header, false with no header (F4)', async () => {
    process.env.RUST_AGENT_REGISTRATION = `allow:${WS}`;
    const en = async (h: Record<string, string>) =>
      JSON.parse((await get({ agent: 'rust' }, h)).body as string).registrationEnabled;
    expect(await en({ 'x-workspace-id': WS })).toBe(true);
    expect(await en({})).toBe(false);
  });

  it('allow:<ws> naming a workspace outside the caller\'s organization → false', async () => {
    process.env.RUST_AGENT_REGISTRATION = `allow:${WS_FOREIGN}`;
    const body = JSON.parse((await get({ agent: 'rust' }, { 'x-workspace-id': WS_FOREIGN })).body as string);
    expect(body.registrationEnabled).toBe(false);
  });

  it('genuine read failures keep the 502 on the channel route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    s3Error = { name: 'AccessDenied' };
    expect((await get({ agent: 'rust' })).statusCode).toBe(502);
  });
});
