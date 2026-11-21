import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeCameraCatalog } from '../src/camera-catalog';
import { serializeConfigContract } from '../src/config-registry/contract';
import {
  ARTIFACT_TARGETS,
  EXIT,
  JS_AGENT_PACKAGE_NAME,
  OUT_ROOT_ENV,
  REPO_DIRS,
  applyTargets,
  describeCheckout,
  formatResult,
  isFailure,
  parseGenerateArgs,
  planTargets,
  repoRootProblem,
  summarize,
  type GenerateOptions,
  type RepoProbe,
  type TargetResult,
} from '../src/contract-artifacts/targets';

/**
 * `npm run contract:generate` writes into OTHER repositories' working trees.
 * These tests pin where, and prove the ways of keeping it out of the wrong
 * place: a linked worktree never writes a sibling by default, `--out-root`
 * moves every write (this repo's included) under one directory, a destination
 * has to be the repo it is named for, and one refused destination stops the
 * whole run.
 *
 * Every write in this file goes to a fresh temp directory. Every run of the
 * real command carries `--out-root` or `--check`, so that even if the option
 * under test were ignored the command could not write into a real repo.
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

// ── a fake file system for the planner ──────────────────────────────────────
const pkg = (name: string) => JSON.stringify({ name, version: '0.0.0' });
function fakeFs(spec: { dirs: string[]; files: Record<string, string> }): RepoProbe {
  return {
    kind: (p) => (p in spec.files ? 'file' : spec.dirs.includes(p) ? 'dir' : null),
    readText: (p) => spec.files[p] ?? null,
  };
}
const JS_AGENT = '/r/device/xorgate-device-agent';
/** The real layout: main checkout, a backend worktree beside it, both siblings, the JS agent. */
const LAYOUT = {
  dirs: [
    '/r/backend/xorgate-core-service',
    '/r/backend/xorgate-core-service-topic',
    '/r/frontend/xorgate-web',
    '/r/device/xorgate-device-agent-rust',
    '/r/device/xorgate-device-agent-rust/crates/xorgate-core',
    JS_AGENT,
    '/w/agent-topic',
    '/w/agent-topic/crates/xorgate-core',
    '/w/web-topic',
    '/w/unrelated',
  ],
  files: {
    '/r/backend/xorgate-core-service/package.json': pkg('xorgate-core-service'),
    '/r/backend/xorgate-core-service-topic/package.json': pkg('xorgate-core-service'),
    '/r/frontend/xorgate-web/package.json': pkg('xorgate-web'),
    '/r/device/xorgate-device-agent-rust/Cargo.toml': '[workspace]',
    [`${JS_AGENT}/package.json`]: pkg(JS_AGENT_PACKAGE_NAME),
    '/w/agent-topic/Cargo.toml': '[workspace]',
    '/w/web-topic/package.json': pkg('xorgate-web'),
    '/w/unrelated/package.json': pkg('something-else'),
    '/w/a-file': 'not a directory',
  } as Record<string, string>,
};
const realLayout = fakeFs(LAYOUT);
/** The layout with some paths removed. */
const without = (...gone: string[]): RepoProbe =>
  fakeFs({
    dirs: LAYOUT.dirs.filter((d) => !gone.some((g) => d === g || d.startsWith(`${g}/`))),
    files: Object.fromEntries(
      Object.entries(LAYOUT.files).filter(([f]) => !gone.some((g) => f.startsWith(`${g}/`))),
    ),
  });
const nothingExists = fakeFs({ dirs: [], files: {} });

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
    const intoJsAgent = (file: string | null) => `${file ?? ''}/`.includes(`${JS_AGENT}/`);

    // By default it is simply not a destination.
    const defaults = [
      planTargets(MAIN, NO_OPTIONS, realLayout),
      planTargets(WORKTREE, NO_OPTIONS, realLayout),
      planTargets(MAIN, { ...NO_OPTIONS, outRoot: '/out' }, realLayout),
    ];
    for (const plan of defaults) {
      expect(plan.some((t) => intoJsAgent(t.file))).toBe(false);
      expect(plan.every((t) => t.error === null)).toBe(true);
    }

    // Named outright, as any of the three repos, it is refused.
    for (const repo of ['device', 'web', 'backend'] as const) {
      for (const checkout of [MAIN, WORKTREE]) {
        const plan = planTargets(
          checkout,
          { ...NO_OPTIONS, repoRoots: { [repo]: JS_AGENT } },
          realLayout,
        );
        const named = plan.filter((t) => t.repo === repo);
        expect(named).toHaveLength(2);
        for (const target of named) {
          expect(target.file).toBeNull();
          expect(target.skip).toBeNull();
          expect(target.error).toBe(
            `--repo ${repo}=${JS_AGENT}: it is the frozen JS agent ` +
              '(package "xorgate-device-agent"), which is never written',
          );
        }
        expect(plan.some((t) => intoJsAgent(t.file))).toBe(false);
      }
    }

    // Even a scratch root is refused if what sits there IS the JS agent
    // (an --out-root laid over a tree where the directories were renamed).
    const renamed = fakeFs({
      dirs: ['/odd/device/xorgate-device-agent-rust'],
      files: { '/odd/device/xorgate-device-agent-rust/package.json': pkg(JS_AGENT_PACKAGE_NAME) },
    });
    const odd = planTargets(MAIN, { ...NO_OPTIONS, outRoot: '/odd' }, renamed);
    expect(odd.filter((t) => t.repo === 'device').every((t) => t.file === null && t.error)).toBe(
      true,
    );
  });

  it('main checkout: the backend, and the siblings two levels up', () => {
    const plan = planTargets(MAIN, NO_OPTIONS, realLayout);
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

  it('main checkout: a sibling that is not there is skipped; one that is something else is an error', () => {
    const absent = planTargets(MAIN, NO_OPTIONS, without('/r/frontend/xorgate-web'));
    const web = absent.filter((t) => t.repo === 'web');
    expect(web.map((t) => t.file)).toEqual([null, null]);
    expect(web[0].skip).toBe('/r/frontend/xorgate-web is not present in this checkout');
    expect(web[0].error).toBeNull();
    expect(absent.filter((t) => t.repo !== 'web').every((t) => t.file !== null)).toBe(true);

    // A directory by that name that is not the console: refuse, do not write into it.
    const impostor = fakeFs({
      dirs: LAYOUT.dirs,
      files: { ...LAYOUT.files, '/r/frontend/xorgate-web/package.json': pkg('some-fork') },
    });
    const wrong = planTargets(MAIN, NO_OPTIONS, impostor).filter((t) => t.repo === 'web');
    expect(wrong.every((t) => t.file === null && t.skip === null)).toBe(true);
    expect(wrong[0].error).toBe(
      '/r/frontend/xorgate-web: it is not the web repo ' +
        '(expected package "xorgate-web", package.json names "some-fork")',
    );
    // The Rust agent directory without its workspace is not the Rust agent.
    const hollow = planTargets(
      MAIN,
      NO_OPTIONS,
      without('/r/device/xorgate-device-agent-rust/crates'),
    ).filter((t) => t.repo === 'device');
    expect(hollow[0].error).toBe(
      '/r/device/xorgate-device-agent-rust: it is not the Rust agent repo ' +
        '(no Cargo.toml with crates/xorgate-core/)',
    );
  });

  it('linked worktree: writes its own copies and NO sibling, even when the siblings resolve', () => {
    // A worktree created beside the main checkout (`backend/<name>`) is two
    // levels below the same root, so the siblings WOULD resolve to the real
    // console and agent checkouts. That is exactly the accident to prevent.
    const plan = planTargets(WORKTREE, NO_OPTIONS, realLayout);
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

  it('--out-root moves every copy under it, the backend\'s own included, with no marker asked', () => {
    for (const checkout of [MAIN, WORKTREE]) {
      // Nothing exists at all: a scratch root is exempt from the repo checks.
      const plan = planTargets(checkout, { ...NO_OPTIONS, outRoot: '/out' }, nothingExists);
      expect(plan.map((t) => t.file).sort()).toEqual(EVERY_COPY.map((p) => `/out/${p}`));
      expect(plan.every((t) => t.error === null && t.skip === null)).toBe(true);
    }
  });

  it('--repo points one repo at a checkout, and wins over --out-root', () => {
    const plan = planTargets(
      WORKTREE,
      { outRoot: '/out', repoRoots: { device: '/w/agent-topic', web: '/w/web-topic' }, only: null },
      realLayout,
    );
    expect(plan.filter((t) => t.repo === 'device').map((t) => t.file)).toEqual([
      '/w/agent-topic/fixtures/config-contract.json',
      '/w/agent-topic/crates/xorgate-core/data/camera-catalog.json',
    ]);
    expect(plan.filter((t) => t.repo === 'web').map((t) => t.file)).toEqual([
      '/w/web-topic/src/lib/config-contract.json',
      '/w/web-topic/src/lib/camera-catalog.json',
    ]);
    expect(
      plan.filter((t) => t.repo === 'backend').every((t) => t.file?.startsWith('/out/')),
    ).toBe(true);
  });

  it('--repo must name the repo it claims: every wrong directory is an error, not a skip', () => {
    const problem = (repo: 'backend' | 'web' | 'device', dir: string) =>
      repoRootProblem(repo, dir, realLayout);
    expect(problem('device', '/w/agent-topic')).toBeNull();
    expect(problem('web', '/w/web-topic')).toBeNull();
    expect(problem('backend', '/r/backend/xorgate-core-service-topic')).toBeNull();

    expect(problem('device', '/nowhere')).toBe('no such directory');
    expect(problem('device', '/w/a-file')).toBe('not a directory');
    // Right kind of repo, wrong one.
    expect(problem('device', '/w/web-topic')).toBe(
      'it is not the Rust agent repo (no Cargo.toml with crates/xorgate-core/)',
    );
    expect(problem('web', '/w/agent-topic')).toBe(
      'it is not the web repo (expected package "xorgate-web", no readable package.json name)',
    );
    expect(problem('web', '/r/backend/xorgate-core-service')).toBe(
      'it is not the web repo (expected package "xorgate-web", package.json names "xorgate-core-service")',
    );
    expect(problem('backend', '/w/unrelated')).toBe(
      'it is not the backend repo (expected package "xorgate-core-service", package.json names "something-else")',
    );
    // A package.json that is not JSON, or has no string name, proves nothing.
    for (const text of ['{', '[]', '{"name": 7}', '']) {
      const odd = fakeFs({ dirs: ['/x'], files: { '/x/package.json': text } });
      expect(repoRootProblem('web', '/x', odd), text).toContain('no readable package.json name');
    }

    const plan = planTargets(
      MAIN,
      { ...NO_OPTIONS, repoRoots: { web: '/nowhere' } },
      realLayout,
    );
    const web = plan.filter((t) => t.repo === 'web');
    expect(web.every((t) => t.file === null && t.skip === null)).toBe(true);
    expect(web[0].error).toBe('--repo web=/nowhere: no such directory');
  });

  it('--only limits the run to the named repos', () => {
    const plan = planTargets(
      WORKTREE,
      { ...NO_OPTIONS, repoRoots: { device: '/w/agent-topic' }, only: ['device'] },
      realLayout,
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
    // A relative path is resolved against the backend root (where npm runs).
    expect(parse(['--out-root=rel'])).toMatchObject({ outRoot: '/cwd/rel' });
    expect(parse(['--out-root', '../up'])).toMatchObject({ outRoot: '/up' });
    expect(parse(['-h'])).toMatchObject({ help: true });
  });

  it('merges a repeated --only', () => {
    expect(parse(['--only', 'web', '--only', 'device'])).toMatchObject({ only: ['web', 'device'] });
    expect(parse(['--only=device', '--only', 'device,backend'])).toMatchObject({
      only: ['device', 'backend'],
    });
  });

  it('takes the out root from the environment, and the flag wins', () => {
    expect(parse([], { [OUT_ROOT_ENV]: '/env' })).toMatchObject({ outRoot: '/env' });
    expect(parse(['--out-root', '/flag'], { [OUT_ROOT_ENV]: '/env' })).toMatchObject({
      outRoot: '/flag',
    });
    expect(parse([], { [OUT_ROOT_ENV]: '' })).toMatchObject({ outRoot: null });
  });

  it('never takes another option as a value', () => {
    // `--out-root --check` must not write into a directory called "--check".
    expect(parse(['--out-root', '--check'])).toEqual({ error: '--out-root needs a directory' });
    expect(parse(['--out-root=--check'])).toEqual({ error: '--out-root needs a directory' });
    expect(parse(['--repo', '--check'])).toEqual({ error: '--repo needs <name>=<dir>' });
    expect(parse(['--only', '--check'])).toEqual({ error: '--only needs a list of repos' });
    expect(parse(['--check=yes'])).toEqual({ error: '--check takes no value' });
  });

  it('refuses what it does not understand instead of writing somewhere unexpected', () => {
    for (const argv of [
      ['--out'],
      ['somewhere'],
      ['--out-root'],
      ['--out-root', ''],
      ['--repo', 'device'],
      ['--repo', 'device='],
      ['--repo', '=/x'],
      ['--repo', 'js=/x'],
      ['--only', 'js'],
      ['--only', ''],
      ['--only', ','],
      ['--only'],
      ['--only', 'web', '--only', 'js'],
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

/** A directory that passes as the Rust agent repo. */
function fakeRustRepo(dir: string): string {
  mkdirSync(join(dir, 'crates', 'xorgate-core'), { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\n');
  return dir;
}
function fakeNodeRepo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), pkg(name));
  return dir;
}

describe('writing and checking (real files, in temp directories)', () => {
  it('creates, then leaves alone, then repairs a copy; --check only reports', () => {
    const out = scratch();
    const plan = planTargets(MAIN, { ...NO_OPTIONS, outRoot: out });

    const missing = applyTargets(plan, CONTENTS, { check: true });
    expect(missing.map((r) => r.status)).toEqual(Array(6).fill('missing'));
    expect(summarize(missing).code).toBe(EXIT.drift);
    expect(filesUnder(out)).toEqual([]); // a check writes nothing

    const created = applyTargets(plan, CONTENTS, { check: false });
    expect(created.map((r) => r.status)).toEqual(Array(6).fill('created'));
    expect(summarize(created)).toEqual({ code: EXIT.ok, message: null });
    // Exactly the six copies: no temp file is left behind.
    expect(filesUnder(out)).toEqual(EVERY_COPY);
    for (const target of plan) {
      expect(readFileSync(target.file!, 'utf8')).toBe(CONTENTS[target.artifact]);
    }

    expect(applyTargets(plan, CONTENTS, { check: false }).map((r) => r.status)).toEqual(
      Array(6).fill('unchanged'),
    );
    const ok = applyTargets(plan, CONTENTS, { check: true });
    expect(ok.map((r) => r.status)).toEqual(Array(6).fill('ok'));
    expect(summarize(ok)).toEqual({ code: EXIT.ok, message: null });

    const tampered = plan[2].file!;
    writeFileSync(tampered, `${readFileSync(tampered, 'utf8')} `);
    const checked = applyTargets(plan, CONTENTS, { check: true });
    expect(checked.map((r) => r.status)).toEqual(['ok', 'ok', 'differs', 'ok', 'ok', 'ok']);
    expect(summarize(checked).code).toBe(EXIT.drift);
    expect(readFileSync(tampered, 'utf8').endsWith(' ')).toBe(true); // still not repaired
    expect(applyTargets(plan, CONTENTS, { check: false })[2].status).toBe('updated');
    expect(readFileSync(tampered, 'utf8')).toBe(CONTENTS['config-contract']);
  });

  it('--out-root is total: a stale copy in the checkout it runs from is not touched', () => {
    // The checkout has DRIFTED copies, so a run that wrote into it would be
    // visible. (Comparing mtimes proves nothing: an in-sync copy is never
    // rewritten anyway.)
    const root = scratch();
    const backendRoot = fakeNodeRepo(
      join(root, 'backend', 'xorgate-core-service'),
      'xorgate-core-service',
    );
    const stale = {
      contract: join(backendRoot, 'src/config-registry/config-contract.json'),
      catalog: join(backendRoot, 'src/camera-catalog/camera-catalog.json'),
    };
    for (const file of Object.values(stale)) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '{"stale":true}\n');
    }
    const web = fakeNodeRepo(join(root, 'frontend', 'xorgate-web'), 'xorgate-web');
    const before = filesUnder(root);

    const out = scratch();
    const checkout = { backendRoot, linkedWorktree: false };
    const results = applyTargets(planTargets(checkout, { ...NO_OPTIONS, outRoot: out }), CONTENTS, {
      check: false,
    });
    expect(results.map((r) => r.status)).toEqual(Array(6).fill('created'));
    expect(filesUnder(out)).toEqual(EVERY_COPY);
    // The checkout and its real sibling: byte for byte as they were.
    expect(filesUnder(root)).toEqual(before);
    expect(readFileSync(stale.contract, 'utf8')).toBe('{"stale":true}\n');
    expect(readFileSync(stale.catalog, 'utf8')).toBe('{"stale":true}\n');
    expect(existsSync(join(web, 'src'))).toBe(false);

    // Without the redirect, the same checkout IS rewritten (the control).
    const direct = applyTargets(planTargets(checkout, NO_OPTIONS), CONTENTS, { check: false });
    expect(direct.filter((r) => r.status === 'updated').map((r) => r.label)).toEqual([
      'backend:config-contract',
      'backend:camera-catalog',
    ]);
    expect(readFileSync(stale.contract, 'utf8')).toBe(CONTENTS['config-contract']);
  });

  it('one refused destination stops the whole run: nothing is written anywhere', () => {
    const root = scratch();
    const rust = fakeRustRepo(join(root, 'agent'));
    const notWeb = fakeNodeRepo(join(root, 'not-web'), 'something-else');
    const out = scratch();
    const plan = planTargets(
      MAIN,
      { outRoot: out, repoRoots: { device: rust, web: notWeb }, only: null },
    );
    const before = filesUnder(root);

    const seen: TargetResult[] = [];
    const results = applyTargets(plan, CONTENTS, { check: false, onResult: (r) => seen.push(r) });
    expect(results.map((r) => `${r.label}=${r.status}`)).toEqual([
      'backend:config-contract=refused',
      'web:config-contract=error',
      'device:config-contract=refused',
      'backend:camera-catalog=refused',
      'web:camera-catalog=error',
      'device:camera-catalog=refused',
    ]);
    expect(results[1].detail).toContain('it is not the web repo');
    expect(results[0].detail).toBe('not written: another destination was refused');
    expect(seen).toEqual(results); // reported one by one, in order
    expect(filesUnder(root)).toEqual(before);
    expect(filesUnder(out)).toEqual([]);
    expect(summarize(results)).toEqual({
      code: EXIT.error,
      message: 'nothing was written: a destination was refused',
    });
    expect(isFailure('refused')).toBe(true);

    // A check cannot do harm, so it still compares the good destinations.
    const checked = applyTargets(plan, CONTENTS, { check: true });
    expect(checked.map((r) => r.status)).toEqual([
      'missing',
      'error',
      'missing',
      'missing',
      'error',
      'missing',
    ]);
    expect(summarize(checked).code).toBe(EXIT.error);
  });

  it('a read or write that fails is that copy\'s error, with the path and the reason', () => {
    const out = scratch();
    // The console's directory cannot be created: a FILE sits where it must go.
    writeFileSync(join(out, 'frontend'), 'in the way');
    // And the Rust fixture's path is a DIRECTORY.
    const fixture = join(out, 'device/xorgate-device-agent-rust/fixtures/config-contract.json');
    mkdirSync(fixture, { recursive: true });
    const plan = planTargets(MAIN, { ...NO_OPTIONS, outRoot: out });

    const seen: string[] = [];
    const results = applyTargets(plan, CONTENTS, {
      check: false,
      onResult: (r) => seen.push(r.label),
    });
    expect(results.map((r) => `${r.label}=${r.status}`)).toEqual([
      'backend:config-contract=created',
      'web:config-contract=error',
      'device:config-contract=error',
      'backend:camera-catalog=created',
      'web:camera-catalog=error',
      'device:camera-catalog=created',
    ]);
    // Every result was reported as it happened, failures included, and the
    // run went on past them.
    expect(seen).toEqual(results.map((r) => r.label));
    for (const failed of results.filter((r) => r.status === 'error')) {
      expect(failed.detail).toMatch(/ENOTDIR|EISDIR/); // the reason
      expect(failed.file?.startsWith(out)).toBe(true); // the path
      expect(formatResult(failed)).toMatch(/^error\s+(web|device):\S+\s+\/.+ \(E(NOTDIR|ISDIR): /);
    }
    expect(summarize(results)).toEqual({ code: EXIT.error, message: null });
    // What succeeded is whole, and no temp file is left where a write failed.
    expect(filesUnder(out).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(
      readFileSync(join(out, 'backend/xorgate-core-service/src/camera-catalog/camera-catalog.json'), 'utf8'),
    ).toBe(CONTENTS['camera-catalog']);
    expect(readFileSync(join(out, 'frontend'), 'utf8')).toBe('in the way');

    // A check reports the same places as errors, not as "missing".
    const checked = applyTargets(plan, CONTENTS, { check: true });
    expect(checked.map((r) => r.status)).toEqual(['ok', 'error', 'error', 'ok', 'error', 'ok']);
  });

  it('a run that skipped everything did nothing, and says so with a non-zero code', () => {
    // `--only device` from a linked worktree: both copies are skipped.
    const plan = planTargets(WORKTREE, { ...NO_OPTIONS, only: ['device'] }, realLayout);
    for (const check of [false, true]) {
      const results = applyTargets(plan, CONTENTS, { check });
      expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped']);
      const { code, message } = summarize(results);
      expect(code).toBe(EXIT.error);
      expect(message).toContain('nothing to do: every selected copy was skipped');
      expect(message).toContain('pass --repo device=<dir> or --out-root <dir>');
    }
    // Skipping SOME copies is the normal backend-only run.
    const some = applyTargets(planTargets(WORKTREE, { ...NO_OPTIONS, outRoot: null }, realLayout), CONTENTS, {
      check: true,
    });
    expect(some.filter((r) => r.status === 'skipped')).toHaveLength(4);
    expect([EXIT.ok, EXIT.drift]).toContain(summarize(some).code);
  });

  it('keeps the four exit codes apart', () => {
    expect(EXIT).toEqual({ ok: 0, drift: 1, usage: 2, error: 3 });
    expect(new Set(Object.values(EXIT)).size).toBe(4);
  });
});

describe('the config contract', () => {
  it('is byte-for-byte the published one (its absolute sha256)', () => {
    // The generator work must never move the contract. This is the same hash
    // `test/sdk-vendor-drift.test.ts` pins for the committed file; when a
    // registry change legitimately moves the contract, both move together.
    expect(createHash('sha256').update(CONTENTS['config-contract']).digest('hex')).toBe(
      '5bb0025eae4fa53108157ce1b993933b6d4fcf65403af2136d4e0194b3fc88a0',
    );
  });
});

describe('npm run contract:generate (the real command, always redirected)', () => {
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
  const resultLines = (out: string) =>
    out.split('\n').filter((line) => /^[a-zA-Z]+\s+(backend|web|device):/.test(line));

  it('writes all six copies under --out-root, byte-identical to the committed ones', () => {
    const out = scratch();
    // A RELATIVE out root is resolved against the backend root, and printed.
    const first = run(['--out-root', relative(REPO_ROOT, out)]);
    expect(first.code, first.out).toBe(EXIT.ok);
    expect(first.out).toContain(`out root: ${out}\n`);
    expect(filesUnder(out)).toEqual(EVERY_COPY);

    const contract = readFileSync(committed.contract, 'utf8');
    const catalog = readFileSync(committed.catalog, 'utf8');
    for (const copy of EVERY_COPY) {
      const want = copy.endsWith('config-contract.json') ? contract : catalog;
      expect(readFileSync(join(out, copy), 'utf8'), copy).toBe(want);
    }

    // The environment form names the same root. It is exercised with --check
    // only: if the variable were ever ignored, this run would READ this
    // checkout (and fail the path assertion below), never write a sibling.
    const viaEnv = run(['--check'], { [OUT_ROOT_ENV]: out });
    expect(viaEnv.code, viaEnv.out).toBe(EXIT.ok);
    const lines = resultLines(viaEnv.out);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).toMatch(/^ok\s/);
      expect(line).toContain(` ${out}${sep}`);
    }
    const onlyDevice = run(['--check', '--only', 'device'], { [OUT_ROOT_ENV]: out });
    expect(onlyDevice.code, onlyDevice.out).toBe(EXIT.ok);
    expect(resultLines(onlyDevice.out).map((l) => l.split(/\s+/)[1])).toEqual([
      'device:config-contract',
      'device:camera-catalog',
    ]);

    // --check catches a copy that drifted, with the drift code, and repairs nothing.
    const drifted = join(out, 'device/xorgate-device-agent-rust/fixtures/config-contract.json');
    writeFileSync(drifted, '{}\n');
    const bad = run(['--check', '--out-root', out]);
    expect(bad.code, bad.out).toBe(EXIT.drift);
    expect(bad.out).toMatch(/DIFFERS\s+device:config-contract/);
    expect(readFileSync(drifted, 'utf8')).toBe('{}\n');
  }, 120_000);

  it('exits 2 on a command line it does not understand, having written nothing', () => {
    const out = scratch();
    const unknown = run(['--out-root', out, '--target', 'device']);
    expect(unknown.code, unknown.out).toBe(EXIT.usage);
    expect(unknown.out).toContain('unknown option "--target"');
    expect(filesUnder(out)).toEqual([]);

    // `--out-root --check` is a missing directory, not a directory named "--check".
    const swallowed = run(['--out-root', '--check']);
    expect(swallowed.code, swallowed.out).toBe(EXIT.usage);
    expect(swallowed.out).toContain('--out-root needs a directory');
    expect(existsSync(join(REPO_ROOT, '--check'))).toBe(false);
  }, 120_000);

  it('exits 3 and writes nothing when a destination is not the repo it is named for', () => {
    const out = scratch();
    const root = scratch();
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const jsAgent = fakeNodeRepo(join(root, 'js-agent'), JS_AGENT_PACKAGE_NAME);
    mkdirSync(join(jsAgent, 'test'));
    writeFileSync(join(jsAgent, 'test/config-contract.json'), '{"frozen":true}\n');
    const before = filesUnder(root);

    // `--out-root` rides along as the safety net: were `--repo` ever ignored,
    // the writes would land in scratch and this test would fail on the code.
    for (const [dir, why] of [
      [empty, 'it is not the Rust agent repo'],
      [jsAgent, 'it is the frozen JS agent'],
      [join(root, 'missing'), 'no such directory'],
    ]) {
      const result = run(['--out-root', out, '--repo', `device=${dir}`]);
      expect(result.code, result.out).toBe(EXIT.error);
      expect(result.out).toContain(`--repo device=${dir}: ${why}`);
      expect(result.out).toContain('nothing was written: a destination was refused');
      expect(resultLines(result.out).filter((l) => /^refused\s/.test(l))).toHaveLength(4);
      expect(filesUnder(out)).toEqual([]);
      expect(filesUnder(root)).toEqual(before);
    }
    expect(readFileSync(join(jsAgent, 'test/config-contract.json'), 'utf8')).toBe(
      '{"frozen":true}\n',
    );

    // The same destinations, made right, are written (the control).
    const rust = fakeRustRepo(join(root, 'agent'));
    const good = run(['--out-root', out, '--repo', `device=${rust}`, '--only', 'device']);
    expect(good.code, good.out).toBe(EXIT.ok);
    expect(filesUnder(rust)).toEqual([
      'Cargo.toml',
      'crates/xorgate-core/data/camera-catalog.json',
      'fixtures/config-contract.json',
    ]);
    expect(filesUnder(out)).toEqual([]);
  }, 120_000);

  it('exits 3 when a write fails, having said so per copy and written the rest', () => {
    const out = scratch();
    writeFileSync(join(out, 'frontend'), 'in the way');
    const result = run(['--out-root', out]);
    expect(result.code, result.out).toBe(EXIT.error);
    const lines = resultLines(result.out);
    expect(lines).toHaveLength(6);
    const failed = lines.filter((l) => /^error\s/.test(l));
    expect(failed.map((l) => l.split(/\s+/)[1])).toEqual([
      'web:config-contract',
      'web:camera-catalog',
    ]);
    for (const line of failed) {
      expect(line).toContain(join(out, 'frontend/xorgate-web/src/lib'));
      expect(line).toMatch(/ENOTDIR/);
    }
    expect(filesUnder(out)).toEqual([
      ...EVERY_COPY.filter((f) => !f.startsWith('frontend/')),
      'frontend',
    ].sort());
  }, 120_000);
});
