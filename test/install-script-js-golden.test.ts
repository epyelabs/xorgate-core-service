import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realSchema from '../src/db/schema';

/**
 * DA1: the JS installer stays BYTE-IDENTICAL (device-agent-js-to-rust plan,
 * Phase 8, D1.6).
 *
 * The golden `fixtures/install-script/js-prod.golden.sh` was rendered from the
 * UNMODIFIED template (backend `1a0c730`), with PROD-stage inputs: the PROD
 * execute-api base, the PROD dist-bucket regional URL, and `latest`. It is the
 * exact body a PROD `GET /v1/get/{code}` serves for that code today.
 *
 * **If this test fails, you changed the JS installer.** That is forbidden by
 * the Phase 8 decision "JS stays exactly as in PROD today". If the change is
 * truly intended (the user's call, not an agent's), a JS-template system-step
 * change ALSO needs the Rust installer to mirror it: walk the D1.4 step table
 * in the Rust repo's `docs/provision.md` (`provision-rs.sh`), ship a Rust
 * release, and only then re-render the golden and move the pins below.
 */

const ROOT = join(__dirname, '..');
const GOLDEN = readFileSync(join(__dirname, 'fixtures/install-script/js-prod.golden.sh'), 'utf8');

/** The PROD-stage inputs the golden was rendered with. */
const PROD = {
  regCode: 'abcdefghijkmnpq2',
  // API_BASE_URL is the bare execute-api origin; the handler appends `/v1`.
  apiOrigin: 'https://fvcro5guw7.execute-api.us-east-1.amazonaws.com',
  apiBase: 'https://fvcro5guw7.execute-api.us-east-1.amazonaws.com/v1',
  distBucketUrl: 'https://xorgate-device-dist-865609249890-us-east-1.s3.us-east-1.amazonaws.com',
  distVersion: 'latest',
};

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** sha256 of `src/assets/install-script.ts` at `1a0c730` (file bytes). */
const TEMPLATE_FILE_SHA256 = 'aae60fcc68c3015173cf09139e655ad200b10002f99685308bff6e523b39067d';
/** sha256 of the golden (the PROD-var render). */
const GOLDEN_SHA256 = '0360c108b81fece5468a38832399bd665d462ec9e761fa528ab27b0687e2033d';

let findFirst: () => Promise<unknown>;
vi.mock('../src/db/index', () => ({
  db: { query: { deviceRegistrations: { findFirst: () => findFirst() } } },
  schema: realSchema,
}));

const { renderInstallScript, INSTALL_SCRIPT_PLACEHOLDERS } = await import(
  '../src/assets/install-script'
);
const { handler } = await import('../src/handlers/install-script');

function getEvent(code: string | undefined): APIGatewayProxyEventV2 {
  return {
    requestContext: { http: { method: 'GET' }, requestId: 'req-1' },
    pathParameters: code ? { code } : undefined,
    headers: {},
  } as unknown as APIGatewayProxyEventV2;
}

type Res = Exclude<APIGatewayProxyResultV2, string>;

function pendingRow(extra: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    code: PROD.regCode,
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...extra,
  };
}

const ENV_KEYS = ['API_BASE_URL', 'DEVICE_DIST_BUCKET_URL', 'DEVICE_DIST_VERSION'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  // The PROD CDK wiring: bare origin, regional bucket URL, literal `latest`.
  process.env.API_BASE_URL = PROD.apiOrigin;
  process.env.DEVICE_DIST_BUCKET_URL = PROD.distBucketUrl;
  process.env.DEVICE_DIST_VERSION = PROD.distVersion;
  findFirst = async () => pendingRow();
});

const SHELL_HEADERS = {
  'Content-Type': 'text/x-shellscript; charset=utf-8',
  'Cache-Control': 'no-store',
};

describe('DA1: JS install script byte identity', () => {
  it('(a) renderInstallScript(PROD vars) equals the golden', () => {
    const body = renderInstallScript({
      regCode: PROD.regCode,
      apiBase: PROD.apiBase,
      distBucketUrl: PROD.distBucketUrl,
      distVersion: PROD.distVersion,
    });
    expect(sha256(body)).toBe(GOLDEN_SHA256);
    expect(body).toBe(GOLDEN);
  });

  it('(b) the handler serves the golden for a pending code, same status and headers', async () => {
    const res = (await handler(getEvent(PROD.regCode))) as Res;
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual(SHELL_HEADERS);
    expect(res.body).toBe(GOLDEN);
  });

  it('(c) the template file is pinned by sha256', () => {
    const file = readFileSync(join(ROOT, 'src/assets/install-script.ts'));
    expect(
      sha256(file),
      'src/assets/install-script.ts changed. The JS installer must stay byte-identical ' +
        '(Phase 8). See the header of this test before moving the pin.',
    ).toBe(TEMPLATE_FILE_SHA256);
  });

  it('(c) the identity render returns the template with all 4 placeholders intact', () => {
    const tpl = renderInstallScript({
      regCode: '__REG_CODE__',
      apiBase: '__API_BASE__',
      distBucketUrl: '__DIST_BUCKET_URL__',
      distVersion: '__DIST_VERSION__',
    });
    for (const ph of INSTALL_SCRIPT_PLACEHOLDERS) expect(tpl).toContain(ph);
    // Re-substituting the identity render gives the golden again.
    const again = tpl
      .replaceAll('__REG_CODE__', PROD.regCode)
      .replaceAll('__API_BASE__', PROD.apiBase)
      .replaceAll('__DIST_BUCKET_URL__', PROD.distBucketUrl)
      .replaceAll('__DIST_VERSION__', PROD.distVersion);
    expect(again).toBe(GOLDEN);
  });

  it('(d) the shellError bodies and statuses are unchanged', async () => {
    const err = (msg: string) => `#!/usr/bin/env bash\nset -e\necho "[xorgate] ${msg}" >&2\nexit 1\n`;

    let res = (await handler(getEvent(undefined))) as Res;
    expect([res.statusCode, res.headers, res.body]).toEqual([
      400,
      SHELL_HEADERS,
      err('missing registration code in URL'),
    ]);

    findFirst = async () => undefined;
    res = (await handler(getEvent('nope'))) as Res;
    expect([res.statusCode, res.body]).toEqual([
      404,
      err('this registration code is unknown; generate a new one in the web app'),
    ]);

    findFirst = async () => pendingRow({ status: 'claimed' });
    res = (await handler(getEvent(PROD.regCode))) as Res;
    expect([res.statusCode, res.body]).toEqual([
      410,
      err('this registration code was already used; generate a new one in the web app'),
    ]);

    findFirst = async () => pendingRow({ status: 'expired' });
    res = (await handler(getEvent(PROD.regCode))) as Res;
    expect([res.statusCode, res.body]).toEqual([
      410,
      err('this registration code is expired; generate a new one in the web app'),
    ]);

    findFirst = async () => pendingRow({ expiresAt: new Date(Date.now() - 1000) });
    res = (await handler(getEvent(PROD.regCode))) as Res;
    expect(res.statusCode).toBe(410);

    findFirst = async () => pendingRow();
    delete process.env.DEVICE_DIST_BUCKET_URL;
    res = (await handler(getEvent(PROD.regCode))) as Res;
    expect([res.statusCode, res.body]).toEqual([
      500,
      err('server misconfigured: DEVICE_DIST_BUCKET_URL not set'),
    ]);
  });

  it('the golden is a syntactically complete bash script of the expected size', () => {
    expect(GOLDEN.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(GOLDEN.endsWith('log "tail logs: sudo journalctl -u xorgate-agent -f"\n')).toBe(true);
    expect(Buffer.byteLength(GOLDEN)).toBe(30281);
  });
});
