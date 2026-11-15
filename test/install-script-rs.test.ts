import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderRustBootstrap } from '../src/assets/install-script-rs';
import { INSTALL_SCRIPT_PLACEHOLDERS } from '../src/assets/install-script';

/**
 * DA2 (bootstrap half): the Rust bootstrap golden + its behaviour.
 *
 * The golden `fixtures/install-script/rust-prod.golden.sh` is what the Rust
 * repo's provision-e2e vendors and runs unmodified (D1.6). If this test fails
 * because you changed the bootstrap on purpose, re-render the golden, move the
 * pins, and tell the Rust repo (its vendored copy + source commit must follow).
 *
 * The behaviour tests run the rendered script under bash with a stub PATH: `id`
 * and `uname` pretend to be root on aarch64, `curl` serves a fake bucket
 * directory, and the provisioner inside the fake tarball just records its
 * arguments. Everything else is the host's real tools (tar, sha256sum, sed,
 * awk), so the download / verify / unpack / hand-off path is exercised for real.
 */

const GOLDEN = readFileSync(join(__dirname, 'fixtures/install-script/rust-prod.golden.sh'), 'utf8');
const GOLDEN_SHA256 = '9084ff6cf02093c515841a079966910dd154b117a059a7f038c8d01f38f0525f';
const TEMPLATE_FILE_SHA256 = '759fe1fa5cdb906f2d527b71cbe88cd564f7a8f3cad1d3480b37ac931395ead8';

const PROD = {
  regCode: 'abcdefghijkmnpq2',
  apiBase: 'https://fvcro5guw7.execute-api.us-east-1.amazonaws.com/v1',
  distBucketUrl: 'https://xorgate-device-dist-865609249890-us-east-1.s3.us-east-1.amazonaws.com',
  distVersion: 'latest',
};

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

describe('Rust bootstrap golden', () => {
  it('renderRustBootstrap(PROD vars) equals the golden', () => {
    const body = renderRustBootstrap(PROD);
    expect(sha256(body)).toBe(GOLDEN_SHA256);
    expect(body).toBe(GOLDEN);
  });

  it('the template file is pinned by sha256', () => {
    const file = readFileSync(join(__dirname, '..', 'src/assets/install-script-rs.ts'));
    expect(sha256(file), 'install-script-rs.ts changed: re-render the golden + tell the Rust repo').toBe(
      TEMPLATE_FILE_SHA256,
    );
  });

  it('uses all four placeholders and leaves none behind', () => {
    const identity = renderRustBootstrap({
      regCode: '__REG_CODE__',
      apiBase: '__API_BASE__',
      distBucketUrl: '__DIST_BUCKET_URL__',
      distVersion: '__DIST_VERSION__',
    });
    for (const ph of INSTALL_SCRIPT_PLACEHOLDERS) expect(identity).toContain(ph);
    for (const ph of INSTALL_SCRIPT_PLACEHOLDERS) expect(GOLDEN).not.toContain(ph);
  });

  it('writes the NM usb0 conf only when it is absent, and reloads NM only then', () => {
    expect(GOLDEN).toContain(
      'if [ -d /etc/NetworkManager ] && [ ! -e "$NM_CONF" ]; then',
    );
    const block = GOLDEN.slice(GOLDEN.indexOf('NM_CONF='), GOLDEN.indexOf('for tool in'));
    expect(block.match(/systemctl reload NetworkManager/g)).toHaveLength(1);
    // The reload is inside the guarded block, before its closing `fi`.
    expect(block.indexOf('systemctl reload NetworkManager')).toBeLessThan(block.lastIndexOf('fi'));
  });

  it('never claims: the bootstrap has no claim call and no jq dependency', () => {
    expect(GOLDEN).not.toMatch(/\/claim/);
    expect(GOLDEN).not.toMatch(/\bjq\b/);
    expect(GOLDEN).not.toContain('xorgate-agent-rs-latest.tar.gz');
  });
});

// ---------------------------------------------------------------------------

const BUCKET_URL = 'https://bucket.test';
const VERSION = '14413e0';
const TARBALL = `xorgate-agent-rs-${VERSION}.tar.gz`;

let work: string;
let bucket: string;
let stubs: string;
let farm: string;

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Build a tarball in the fake bucket, optionally without the provisioner. */
function packTarball(opts: { withProvisioner?: boolean } = {}): void {
  const stage = join(work, 'stage');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'bin'), { recursive: true });
  writeExec(join(stage, 'bin/xorgate-rs'), '#!/bin/sh\necho xorgate-rs\n');
  const members = ['bin'];
  if (opts.withProvisioner !== false) {
    // Records its arguments, and whether the bootstrap's temp dir (holding the
    // tarball) still exists at hand-off, then exits 0.
    writeExec(
      join(stage, 'provision-rs.sh'),
      `#!/bin/bash\nprintf '%s\\n' "$@" > "${work}/provision.args"\n` +
        `while [ $# -gt 0 ]; do [ "$1" = --tarball ] && [ -f "$2" ] && echo present > "${work}/tarball.seen"; shift; done\n`,
    );
    members.push('provision-rs.sh');
  }
  const r = spawnSync('tar', ['-czf', join(bucket, TARBALL), '-C', stage, ...members], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  expect(r.status).toBe(0);
  const sum = sha256(readFileSync(join(bucket, TARBALL)));
  writeFileSync(join(bucket, `${TARBALL}.sha256`), `${sum}  ${TARBALL}\n`);
}

function writeManifest(tarball: unknown = TARBALL): void {
  writeFileSync(
    join(bucket, 'latest-rs.json'),
    `{ "version": "${VERSION}", "channel": "dev", "builtAt": "2026-11-14T18:22:22Z",\n` +
      `  "packageVersion": "0.0.1", "tarball": ${JSON.stringify(tarball)} }\n`,
  );
}

/** A PATH holding only the stubs + the named real tools (so python3 can be hidden). */
function buildFarm(withPython: boolean): string {
  const dir = join(work, withPython ? 'farm-py' : 'farm-nopy');
  if (existsSync(dir)) return dir;
  mkdirSync(dir);
  const tools = [
    'bash', 'sh', 'cat', 'sed', 'awk', 'head', 'wc', 'tr', 'tar', 'mkdir', 'rm', 'mktemp',
    'cp', 'install', 'env', 'gzip', 'sha256sum', 'printf', 'grep', 'cut', 'dirname', 'basename',
    'chmod', 'ls',
  ];
  if (withPython) tools.push('python3');
  for (const t of tools) {
    const r = spawnSync('/bin/bash', ['-c', `command -v ${t}`], { encoding: 'utf8' });
    const real = r.stdout.trim();
    if (r.status === 0 && real.startsWith('/')) symlinkSync(real, join(dir, t));
  }
  return dir;
}

function run(
  args: string[] = [],
  opts: { python?: boolean; version?: string; uid?: string; arch?: string } = {},
) {
  const script = join(work, 'install.sh');
  writeFileSync(
    script,
    renderRustBootstrap({
      regCode: 'code123',
      apiBase: 'https://api.test/v1',
      distBucketUrl: BUCKET_URL,
      distVersion: opts.version ?? 'latest',
    }),
  );
  writeExec(join(stubs, 'id'), `#!/bin/sh\necho ${opts.uid ?? '0'}\n`);
  writeExec(join(stubs, 'uname'), `#!/bin/sh\necho ${opts.arch ?? 'aarch64'}\n`);
  farm = buildFarm(opts.python !== false);
  const res = spawnSync(join(farm, 'bash'), [script, ...args], {
    encoding: 'utf8',
    env: { PATH: `${stubs}:${farm}`, TMPDIR: join(work, 'tmp') },
  });
  const urls = existsSync(join(work, 'curl.log'))
    ? readFileSync(join(work, 'curl.log'), 'utf8').trim().split('\n')
    : [];
  const provisionArgs = existsSync(join(work, 'provision.args'))
    ? readFileSync(join(work, 'provision.args'), 'utf8').trim().split('\n')
    : null;
  return { status: res.status, stderr: res.stderr, stdout: res.stdout, urls, provisionArgs };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'xg-rs-boot-'));
  bucket = join(work, 'bucket');
  stubs = join(work, 'stubs');
  mkdirSync(bucket);
  mkdirSync(stubs);
  mkdirSync(join(work, 'tmp'));
  // curl stub: `curl -fsSL ... <url> -o <out>`; serves bucket files, 22 on a miss.
  writeExec(
    join(stubs, 'curl'),
    `#!/bin/bash\nurl=""; out=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;;\n` +
      `  --retry|--retry-delay|--proto) echo "$1 $2" >> "${work}/curl.flags"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\n` +
      `echo "$url" >> "${work}/curl.log"\n` +
      `f="${bucket}/\${url#${BUCKET_URL}/}"\n[ -f "$f" ] || exit 22\ncp "$f" "$out"\n`,
  );
  writeExec(join(stubs, 'systemctl'), `#!/bin/sh\necho "$@" >> "${work}/systemctl.log"\n`);
  packTarball();
  writeManifest();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('Rust bootstrap behaviour', () => {
  it('happy path: resolves latest-rs.json → the VERSIONED tarball, verifies, hands off', () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.urls).toEqual([
      `${BUCKET_URL}/latest-rs.json`,
      `${BUCKET_URL}/${TARBALL}`,
      `${BUCKET_URL}/${TARBALL}.sha256`,
    ]);
    expect(r.stdout).toContain(`checksum ok (${TARBALL})`);
    const a = r.provisionArgs!;
    expect(a.slice(0, 6)).toEqual([
      '--reg-code', 'code123', '--api-base', 'https://api.test/v1', '--from', BUCKET_URL,
    ]);
    expect(a[6]).toBe('--tarball');
    expect(a[7].endsWith(`/${TARBALL}`)).toBe(true);
    expect(a[8]).toBe('--cleanup');
    expect(a[7].startsWith(`${a[9]}/`)).toBe(true);
    expect(a).not.toContain('--reprovision');
    expect(a).toHaveLength(10);
    // The temp dir survives the exec (the provisioner owns its cleanup).
    expect(existsSync(join(work, 'tarball.seen'))).toBe(true);
    // Every fetch is https-only, redirects included (review N6).
    const flags = readFileSync(join(work, 'curl.flags'), 'utf8').trim().split('\n');
    expect(flags.filter((f) => f === '--proto =https')).toHaveLength(r.urls.length);
  });

  it('the sed fallback resolves the manifest when python3 is absent', () => {
    const r = run([], { python: false });
    expect(r.status, r.stderr).toBe(0);
    expect(r.urls[1]).toBe(`${BUCKET_URL}/${TARBALL}`);
  });

  it('forwards --reprovision, and only that', () => {
    const r = run(['--reprovision']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.provisionArgs!.at(-1)).toBe('--reprovision');
    expect(r.provisionArgs).toHaveLength(11);
  });

  it.each([['--uninstall'], ['--help'], ['-x'], ['extra']])('any other argument (%s) → exit 2, nothing fetched', (arg) => {
    const r = run([arg]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: sudo bash install.sh [--reprovision]');
    expect(r.urls).toEqual([]);
    expect(r.provisionArgs).toBeNull();
  });

  it('a pinned DIST_VERSION skips the manifest and fetches that version', () => {
    const r = run([], { version: VERSION });
    expect(r.status, r.stderr).toBe(0);
    expect(r.urls).toEqual([`${BUCKET_URL}/${TARBALL}`, `${BUCKET_URL}/${TARBALL}.sha256`]);
  });

  it('not root → exit 1, nothing fetched', () => {
    const r = run([], { uid: '1000' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run with sudo');
    expect(r.urls).toEqual([]);
  });

  it('not aarch64 → exit 1, nothing fetched', () => {
    const r = run([], { arch: 'armv7l' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('aarch64');
    expect(r.urls).toEqual([]);
  });

  it('no latest-rs.json (no Rust build on this stage) → exit 1 before any provisioner', () => {
    rmSync(join(bucket, 'latest-rs.json'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('latest-rs.json');
    expect(r.provisionArgs).toBeNull();
  });

  it.each([
    ['../../etc/passwd'],
    ['xorgate-agent-latest.tar.gz'],
    ['xorgate-agent-rs-a b.tar.gz'],
    ['xorgate-agent-rs-.tar.gz'],
    [42],
    [null],
  ])('an invalid manifest tarball %j → exit 1, never fetched', (t) => {
    writeManifest(t);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('names no valid Rust agent tarball');
    expect(r.urls).toEqual([`${BUCKET_URL}/latest-rs.json`]);
  });

  it('a non-JSON manifest → exit 1', () => {
    writeFileSync(join(bucket, 'latest-rs.json'), '<Error>AccessDenied</Error>');
    expect(run().status).toBe(1);
  });

  it('a 404 on the tarball → exit 1', () => {
    rmSync(join(bucket, TARBALL));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`could not download ${TARBALL}`);
    expect(r.provisionArgs).toBeNull();
  });

  it('a 404 on the sidecar → exit 1', () => {
    rmSync(join(bucket, `${TARBALL}.sha256`));
    expect(run().status).toBe(1);
  });

  it('a checksum mismatch → exit 1, the provisioner never runs', () => {
    writeFileSync(join(bucket, `${TARBALL}.sha256`), `${'0'.repeat(64)}  ${TARBALL}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('checksum mismatch');
    expect(r.provisionArgs).toBeNull();
  });

  it.each([
    ['a sidecar naming another file', (sum: string) => `${sum}  other.tar.gz\n`],
    ['a malformed hash', () => `zz  ${TARBALL}\n`],
    ['two lines', (sum: string) => `${sum}  ${TARBALL}\n${sum}  ${TARBALL}\n`],
    ['an empty sidecar', () => ''],
  ])('%s → exit 1', (_label, body) => {
    const sum = sha256(readFileSync(join(bucket, TARBALL)));
    writeFileSync(join(bucket, `${TARBALL}.sha256`), body(sum));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.provisionArgs).toBeNull();
  });

  it('a build without provision-rs.sh (pre-Phase-8) → exit 1', () => {
    packTarball({ withProvisioner: false });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('has no provision-rs.sh');
  });

  it('a failed run leaves no temp dir behind', () => {
    rmSync(join(bucket, TARBALL));
    run();
    expect(spawnSync('ls', ['-A', join(work, 'tmp')], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });
});
