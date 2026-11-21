import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeCameraCatalog } from '../src/camera-catalog';
import { serializeConfigContract } from '../src/config-registry/contract';
import {
  ARTIFACT_TARGETS,
  OUT_ROOT_ENV,
  REPO_DIRS,
  applyTargets,
  describeCheckout,
  isFailure,
  parseGenerateArgs,
  planTargets,
  type GenerateOptions,
} from '../src/contract-artifacts/targets';

/**
 * `npm run contract:generate` writes into OTHER repositories' working trees.
 * These tests pin where, and prove the two ways of keeping it out of them: a
 * linked worktree never writes a sibling by default, and `--out-root` moves
 * every write (this repo's included) under one directory.
 *
 * Every write in this file goes to a fresh temp directory.
 */

const REPO_ROOT = join(__dirname, '..');
const CONTENTS = {
  'config-contract': serializeConfigContract(),
  'camera-catalog': serializeCameraCatalog(),
};

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xorgate-contract-'));
  scratchDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const EVERY_COPY = [
  'backend/xorgate-core-service/src/camera-catalog/camera-catalog.json',
  'backend/xorgate-core-service/src/config-registry/config-contract.json',
  'device/xorgate-device-agent-rust/crates/xorgate-core/data/camera-catalog.json',
  'device/xorgate-device-agent-rust/fixtures/config-contract.json',
  'frontend/xorgate-web/src/lib/camera-catalog.json',
  'frontend/xorgate-web/src/lib/config-contract.json',
];

const NO_OPTIONS: Pick<GenerateOptions, 'outRoot' | 'repoRoots' | 'only'> = {
  outRoot: null,
  repoRoots: {},
  only: null,
};
const MAIN = { backendRoot: '/r/backend/xorgate-core-service', linkedWorktree: false };
const WORKTREE = { backendRoot: '/r/backend/xorgate-core-service-topic', linkedWorktree: true };
const everythingExists = () => true;

describe('generator targets', () => {
  it('writes two artifacts into three repos, and the device repo is the RUST agent', () => {
    expect(ARTIFACT_TARGETS.map((t) => `${t.repo}:${t.artifact}:${t.path}`)).toEqual([
      'backend:config-contract:src/config-registry/config-contract.json',
      'web:config-contract:src/lib/config-contract.json',
      'device:config-contract:fixtures/config-contract.json',
      'backend:camera-catalog:src/camera-catalog/camera-catalog.json',
      'web:camera-catalog:src/lib/camera-catalog.json',
      'device:camera-catalog:crates/xorgate-core/data/camera-catalog.json',
    ]);
    expect(REPO_DIRS).toEqual({
      backend: 'backend/xorgate-core-service',
      web: 'frontend/xorgate-web',
      device: 'device/xorgate-device-agent-rust',
    });
  });

  it('never targets the frozen JS agent repo, under any option', () => {
    // `device/xorgate-device-agent/test/config-contract.json` pins the
    // namespace list the JS agent was built against. Rewriting it would fail
    // that repo's test the day a namespace is added.
    const plans = [
      planTargets(MAIN, NO_OPTIONS, everythingExists),
      planTargets(WORKTREE, NO_OPTIONS, everythingExists),
      planTargets(MAIN, { ...NO_OPTIONS, outRoot: '/out' }, everythingExists),
    ];
    for (const plan of plans) {
      for (const target of plan) {
        expect(`${target.file ?? ''}/`).not.toMatch(/\/xorgate-device-agent\//);
      }
    }
  });

  it('main checkout: the backend, and the siblings two levels up', () => {
    const plan = planTargets(MAIN, NO_OPTIONS, everythingExists);
    expect(plan.map((t) => t.file)).toEqual([
      '/r/backend/xorgate-core-service/src/config-registry/config-contract.json',
      '/r/frontend/xorgate-web/src/lib/config-contract.json',
      '/r/device/xorgate-device-agent-rust/fixtures/config-contract.json',
      '/r/backend/xorgate-core-service/src/camera-catalog/camera-catalog.json',
      '/r/frontend/xorgate-web/src/lib/camera-catalog.json',
      '/r/device/xorgate-device-agent-rust/crates/xorgate-core/data/camera-catalog.json',
    ]);
    expect(plan.every((t) => t.skip === null && t.error === null)).toBe(true);
  });

  it('main checkout: a sibling repo that is not there is skipped, not an error', () => {
    const plan = planTargets(MAIN, NO_OPTIONS, (p) => !p.includes('xorgate-web'));
    const web = plan.filter((t) => t.repo === 'web');
    expect(web.map((t) => t.file)).toEqual([null, null]);
    expect(web[0].skip).toBe('/r/frontend/xorgate-web is not present in this checkout');
    expect(web[0].error).toBeNull();
    expect(plan.filter((t) => t.repo !== 'web').every((t) => t.file !== null)).toBe(true);
    // The sibling's ROOT is what must exist; a new directory inside it is made.
    const asked: string[] = [];
    planTargets(MAIN, NO_OPTIONS, (p) => {
      asked.push(p);
      return true;
    });
    expect([...new Set(asked)].sort()).toEqual([
      '/r/device/xorgate-device-agent-rust',
      '/r/frontend/xorgate-web',
    ]);
  });

  it('linked worktree: writes its own copies and NO sibling, even when the siblings resolve', () => {
    // A worktree created beside the main checkout (`backend/<name>`) is two
    // levels below the same root, so the siblings WOULD resolve to the real
    // console and agent checkouts. That is exactly the accident to prevent.
    const plan = planTargets(WORKTREE, NO_OPTIONS, everythingExists);
    expect(plan.filter((t) => t.file !== null).map((t) => t.file)).toEqual([
      '/r/backend/xorgate-core-service-topic/src/config-registry/config-contract.json',
      '/r/backend/xorgate-core-service-topic/src/camera-catalog/camera-catalog.json',
    ]);
    const siblings = plan.filter((t) => t.repo !== 'backend');
    expect(siblings).toHaveLength(4);
    for (const target of siblings) {
      expect(target.file).toBeNull();
      expect(target.error).toBeNull();
      expect(target.skip).toContain('linked git worktree');
      expect(target.skip).toContain(`--repo ${target.repo}=<dir>`);
    }
  });

  it('--out-root moves every copy under it, the backend\'s own included', () => {
    for (const checkout of [MAIN, WORKTREE]) {
      const plan = planTargets(checkout, { ...NO_OPTIONS, outRoot: '/out' }, () => false);
      expect(plan.map((t) => t.file).sort()).toEqual(EVERY_COPY.map((p) => `/out/${p}`));
      expect(plan.every((t) => t.file?.startsWith('/out/'))).toBe(true);
    }
  });

  it('--repo points one repo at a checkout, and wins over --out-root', () => {
    const plan = planTargets(
      WORKTREE,
      { outRoot: '/out', repoRoots: { device: '/w/agent-topic' }, only: null },
      everythingExists,
    );
    expect(plan.filter((t) => t.repo === 'device').map((t) => t.file)).toEqual([
      '/w/agent-topic/fixtures/config-contract.json',
      '/w/agent-topic/crates/xorgate-core/data/camera-catalog.json',
    ]);
    expect(plan.filter((t) => t.repo === 'web').every((t) => t.file?.startsWith('/out/'))).toBe(
      true,
    );
  });

  it('--repo with a directory that does not exist is an error, not a skip', () => {
    const plan = planTargets(
      MAIN,
      { ...NO_OPTIONS, repoRoots: { web: '/nowhere' } },
      (p) => p !== '/nowhere',
    );
    const web = plan.filter((t) => t.repo === 'web');
    expect(web.every((t) => t.file === null && t.skip === null)).toBe(true);
    expect(web[0].error).toBe('--repo web=/nowhere: no such directory');
    const results = applyTargets(plan, CONTENTS, { check: true });
    expect(results.filter((r) => r.status === 'error')).toHaveLength(2);
    expect(isFailure('error')).toBe(true);
  });

  it('--only limits the run to the named repos', () => {
    const plan = planTargets(
      WORKTREE,
      { ...NO_OPTIONS, repoRoots: { device: '/w/agent' }, only: ['device'] },
      everythingExists,
    );
    expect(plan.map((t) => t.label)).toEqual(['device:config-contract', 'device:camera-catalog']);
  });
});

describe('generator command line', () => {
  const parse = (argv: string[], env: Record<string, string> = {}) =>
    parseGenerateArgs(argv, env, '/cwd');

  it('defaults to today\'s behaviour: no redirect, every repo, write', () => {
    expect(parse([])).toEqual({ outRoot: null, repoRoots: {}, only: null, check: false, help: false });
  });

  it('reads --out-root, --repo, --only and --check, in both flag forms', () => {
    expect(
      parse(['--out-root', '/s', '--repo', 'device=/a', '--repo=web=rel/w', '--only', 'web, device', '--check']),
    ).toEqual({
      outRoot: '/s',
      repoRoots: { device: '/a', web: '/cwd/rel/w' },
      only: ['web', 'device'],
      check: true,
      help: false,
    });
    expect(parse(['--out-root=rel'])).toMatchObject({ outRoot: '/cwd/rel' });
    expect(parse(['-h'])).toMatchObject({ help: true });
  });

  it('takes the out root from the environment, and the flag wins', () => {
    expect(parse([], { [OUT_ROOT_ENV]: '/env' })).toMatchObject({ outRoot: '/env' });
    expect(parse(['--out-root', '/flag'], { [OUT_ROOT_ENV]: '/env' })).toMatchObject({
      outRoot: '/flag',
    });
    expect(parse([], { [OUT_ROOT_ENV]: '' })).toMatchObject({ outRoot: null });
  });

  it('refuses what it does not understand instead of writing somewhere unexpected', () => {
    for (const argv of [
      ['--out'],
      ['somewhere'],
      ['--out-root'],
      ['--repo', 'device'],
      ['--repo', 'device='],
      ['--repo', 'js=/x'],
      ['--only', 'js'],
      ['--only', ''],
      ['--only'],
    ]) {
      expect(parse(argv), argv.join(' ')).toHaveProperty('error');
    }
  });
});

describe('checkout detection', () => {
  it('tells a linked worktree (.git is a file) from a main checkout (.git is a directory)', () => {
    const dir = scratch();
    expect(describeCheckout(dir)).toEqual({ backendRoot: dir, linkedWorktree: false });
    mkdirSync(join(dir, '.git'));
    expect(describeCheckout(dir).linkedWorktree).toBe(false);
    rmSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/topic\n');
    expect(describeCheckout(dir).linkedWorktree).toBe(true);
  });
});

describe('writing and checking', () => {
  it('creates, then leaves alone, then repairs a copy; --check only reports', () => {
    const out = scratch();
    const plan = planTargets(MAIN, { ...NO_OPTIONS, outRoot: out });

    const missing = applyTargets(plan, CONTENTS, { check: true });
    expect(missing.map((r) => r.status)).toEqual(Array(6).fill('missing'));
    expect(filesUnder(out)).toEqual([]); // a check writes nothing

    expect(applyTargets(plan, CONTENTS, { check: false }).map((r) => r.status)).toEqual(
      Array(6).fill('created'),
    );
    expect(filesUnder(out)).toEqual(EVERY_COPY);
    for (const target of plan) {
      expect(readFileSync(target.file!, 'utf8')).toBe(CONTENTS[target.artifact]);
    }

    expect(applyTargets(plan, CONTENTS, { check: false }).map((r) => r.status)).toEqual(
      Array(6).fill('unchanged'),
    );
    expect(applyTargets(plan, CONTENTS, { check: true }).map((r) => r.status)).toEqual(
      Array(6).fill('ok'),
    );

    const tampered = plan[2].file!;
    writeFileSync(tampered, `${readFileSync(tampered, 'utf8')} `);
    const checked = applyTargets(plan, CONTENTS, { check: true });
    expect(checked.map((r) => r.status)).toEqual(['ok', 'ok', 'differs', 'ok', 'ok', 'ok']);
    expect(readFileSync(tampered, 'utf8').endsWith(' ')).toBe(true); // still not repaired
    expect(applyTargets(plan, CONTENTS, { check: false })[2].status).toBe('updated');
    expect(readFileSync(tampered, 'utf8')).toBe(CONTENTS['config-contract']);
  });
});

describe('npm run contract:generate (the real command, redirected)', () => {
  const run = (args: string[], env: Record<string, string> = {}) => {
    const base = { ...process.env };
    delete base[OUT_ROOT_ENV];
    try {
      const stdout = execFileSync('npm', ['run', '-s', 'contract:generate', '--', ...args], {
        cwd: REPO_ROOT,
        env: { ...base, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out: stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const committed = {
    contract: join(REPO_ROOT, 'src/config-registry/config-contract.json'),
    catalog: join(REPO_ROOT, 'src/camera-catalog/camera-catalog.json'),
  };

  it('writes all six copies under --out-root, byte-identical to the committed ones, and nothing here', () => {
    const out = scratch();
    const before = {
      contract: statSync(committed.contract).mtimeMs,
      catalog: statSync(committed.catalog).mtimeMs,
    };

    const first = run(['--out-root', out]);
    expect(first.code, first.out).toBe(0);
    expect(filesUnder(out)).toEqual(EVERY_COPY);

    const contract = readFileSync(committed.contract, 'utf8');
    const catalog = readFileSync(committed.catalog, 'utf8');
    for (const copy of EVERY_COPY) {
      const want = copy.endsWith('config-contract.json') ? contract : catalog;
      expect(readFileSync(join(out, copy), 'utf8'), copy).toBe(want);
    }
    // The redirect is total: this repo's own copies were not rewritten.
    expect(statSync(committed.contract).mtimeMs).toBe(before.contract);
    expect(statSync(committed.catalog).mtimeMs).toBe(before.catalog);

    // --check agrees, then catches a copy that drifted.
    const ok = run(['--check', '--out-root', out]);
    expect(ok.code, ok.out).toBe(0);
    const drifted = join(out, 'device/xorgate-device-agent-rust/fixtures/config-contract.json');
    writeFileSync(drifted, '{}\n');
    const bad = run(['--check', '--out-root', out]);
    expect(bad.code, bad.out).toBe(1);
    expect(bad.out).toMatch(/DIFFERS\s+device:config-contract/);
    expect(readFileSync(drifted, 'utf8')).toBe('{}\n');
  }, 120_000);

  it('honours the environment form, and --only', () => {
    const out = scratch();
    const result = run(['--only', 'device'], { [OUT_ROOT_ENV]: out });
    expect(result.code, result.out).toBe(0);
    expect(filesUnder(out)).toEqual([
      'device/xorgate-device-agent-rust/crates/xorgate-core/data/camera-catalog.json',
      'device/xorgate-device-agent-rust/fixtures/config-contract.json',
    ]);
    expect(existsSync(join(out, 'backend'))).toBe(false);
  }, 120_000);

  it('exits 2 on an option it does not know, having written nothing', () => {
    const out = scratch();
    const result = run(['--out-root', out, '--target', 'device']);
    expect(result.code, result.out).toBe(2);
    expect(result.out).toContain('unknown option "--target"');
    expect(filesUnder(out)).toEqual([]);
  }, 120_000);
});
