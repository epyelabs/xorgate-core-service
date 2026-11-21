import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Where `npm run contract:generate` writes, and the rules for redirecting it.
 *
 * The generator emits two artifacts into three repositories that sit side by
 * side in one working tree (they are separate git repos):
 *
 *   <root>/backend/xorgate-core-service        this repo, the source of truth
 *   <root>/frontend/xorgate-web                the console
 *   <root>/device/xorgate-device-agent-rust    the Rust device agent
 *
 * The JS device agent (`device/xorgate-device-agent`) is NOT a target any
 * more. It is frozen; its `test/config-contract.json` pins the namespace list
 * it was built against, and a regenerate that rewrote it would fail its test
 * the day a namespace is added.
 *
 * This lives under `src/` (not in `scripts/`) so it is type-checked and unit
 * tested; `scripts/generate-config-contract.ts` is only the command line.
 */

export const REPOS = ['backend', 'web', 'device'] as const;
export type RepoName = (typeof REPOS)[number];

/** Each repo's directory, relative to the root the three share. */
export const REPO_DIRS: Record<RepoName, string> = {
  backend: 'backend/xorgate-core-service',
  web: 'frontend/xorgate-web',
  device: 'device/xorgate-device-agent-rust',
};

export const ARTIFACTS = ['config-contract', 'camera-catalog'] as const;
export type ArtifactName = (typeof ARTIFACTS)[number];

export interface ArtifactTarget {
  artifact: ArtifactName;
  repo: RepoName;
  /** Path inside the repo. */
  path: string;
}

/** Every committed copy, in write order. */
export const ARTIFACT_TARGETS: readonly ArtifactTarget[] = [
  { artifact: 'config-contract', repo: 'backend', path: 'src/config-registry/config-contract.json' },
  { artifact: 'config-contract', repo: 'web', path: 'src/lib/config-contract.json' },
  { artifact: 'config-contract', repo: 'device', path: 'fixtures/config-contract.json' },
  { artifact: 'camera-catalog', repo: 'backend', path: 'src/camera-catalog/camera-catalog.json' },
  { artifact: 'camera-catalog', repo: 'web', path: 'src/lib/camera-catalog.json' },
  {
    artifact: 'camera-catalog',
    repo: 'device',
    path: 'crates/xorgate-core/data/camera-catalog.json',
  },
];

/** Environment form of `--out-root`. The flag wins when both are given. */
export const OUT_ROOT_ENV = 'XORGATE_CONTRACT_OUT_ROOT';

export const GENERATE_USAGE = `npm run contract:generate [-- options]

Regenerates config-contract.json and camera-catalog.json and writes every
committed copy.

With no option, from the backend's MAIN checkout: writes this repo's copies,
and the console's and the Rust agent's when those repos sit beside it
(<root>/frontend/xorgate-web, <root>/device/xorgate-device-agent-rust).
From a linked git worktree: writes only this worktree's own copies.

  --out-root <dir>      Write EVERYTHING under <dir> instead, at the same
                        relative paths (<dir>/backend/xorgate-core-service/…,
                        <dir>/frontend/xorgate-web/…, <dir>/device/…).
                        Nothing outside <dir> is touched, this repo included.
                        Also: ${OUT_ROOT_ENV}=<dir>.
  --repo <name>=<dir>   Use <dir> as the checkout of one repo (backend, web or
                        device), e.g. a git worktree of it. Repeatable.
  --only <name,…>       Write only these repos' copies.
  --check               Write nothing. Report each copy as ok, DIFFERS or
                        missing; exit 1 unless all are ok.
  -h, --help            This text.

Paths may be absolute or relative to the backend repo root.`;

export interface GenerateOptions {
  outRoot: string | null;
  repoRoots: Partial<Record<RepoName, string>>;
  only: RepoName[] | null;
  check: boolean;
  help: boolean;
}

function isRepoName(value: string): value is RepoName {
  return (REPOS as readonly string[]).includes(value);
}

/**
 * Parse the command line. `cwd` resolves relative paths; `npm run` sets it to
 * the backend repo root.
 */
export function parseGenerateArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  cwd: string,
): GenerateOptions | { error: string } {
  const options: GenerateOptions = {
    outRoot: null,
    repoRoots: {},
    only: null,
    check: false,
    help: false,
  };
  const names = REPOS.join(', ');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i];
    };
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '--out-root': {
        const dir = value();
        if (!dir) return { error: '--out-root needs a directory' };
        options.outRoot = resolve(cwd, dir);
        break;
      }
      case '--repo': {
        const pair = value();
        const eq = pair ? pair.indexOf('=') : -1;
        if (!pair || eq <= 0 || eq === pair.length - 1) {
          return { error: '--repo needs <name>=<dir>' };
        }
        const name = pair.slice(0, eq);
        if (!isRepoName(name)) return { error: `--repo: unknown repo "${name}" (${names})` };
        options.repoRoots[name] = resolve(cwd, pair.slice(eq + 1));
        break;
      }
      case '--only': {
        const list = value();
        if (!list) return { error: '--only needs a list of repos' };
        const picked: RepoName[] = [];
        for (const name of list.split(',').map((s) => s.trim()).filter(Boolean)) {
          if (!isRepoName(name)) return { error: `--only: unknown repo "${name}" (${names})` };
          if (!picked.includes(name)) picked.push(name);
        }
        if (picked.length === 0) return { error: '--only needs a list of repos' };
        options.only = picked;
        break;
      }
      default:
        return { error: `unknown option "${arg}"` };
    }
  }
  const fromEnv = env[OUT_ROOT_ENV];
  if (options.outRoot === null && fromEnv) options.outRoot = resolve(cwd, fromEnv);
  return options;
}

export interface Checkout {
  /** Root of the backend checkout the generator runs from. */
  backendRoot: string;
  /**
   * True when that checkout is a LINKED git worktree (`git worktree add`): its
   * `.git` is a file pointing into the main checkout, not a directory.
   */
  linkedWorktree: boolean;
}

export function describeCheckout(backendRoot: string): Checkout {
  let linkedWorktree = false;
  try {
    linkedWorktree = statSync(join(backendRoot, '.git')).isFile();
  } catch {
    // No `.git` at all (an exported tree): treated like a main checkout.
  }
  return { backendRoot, linkedWorktree };
}

export interface PlannedTarget extends ArtifactTarget {
  /** `web:camera-catalog` */
  label: string;
  /** Absolute file to write, or null when the target is skipped or in error. */
  file: string | null;
  /** Why nothing is written here, when it is a normal outcome. */
  skip: string | null;
  /** Why nothing CAN be written here, when the request cannot be met. */
  error: string | null;
}

/**
 * Decide, per target, which file it is. Pure apart from `exists`.
 *
 * A repo's root is, in order:
 *   1. `--repo <name>=<dir>`: that directory. It must exist.
 *   2. `--out-root <dir>`: `<dir>/<the repo's relative directory>`, created
 *      on write. This redirects the backend's own copies too, so a run with
 *      it touches nothing outside `<dir>`.
 *   3. The backend: the checkout the generator runs from.
 *   4. A sibling, from the backend's MAIN checkout: two levels above the
 *      backend root (`<root>/backend/xorgate-core-service` → `<root>`), then
 *      the sibling's relative directory. Skipped when it is not there, so a
 *      backend-only checkout still regenerates its own copies.
 *   5. A sibling, from a LINKED WORKTREE of the backend: skipped. Rule 4 would
 *      resolve to the real console and agent checkouts whenever the worktree
 *      sits beside the main checkout (`backend/<worktree>`), and to nothing
 *      when it sits elsewhere; a branch in progress must not write its
 *      artifacts into another repo's working tree by accident of where it was
 *      created. Name the destination with rule 1 or 2.
 */
export function planTargets(
  checkout: Checkout,
  options: Pick<GenerateOptions, 'outRoot' | 'repoRoots' | 'only'>,
  exists: (path: string) => boolean = existsSync,
): PlannedTarget[] {
  const implicitRoot = resolve(checkout.backendRoot, '..', '..');
  const plan: PlannedTarget[] = [];
  for (const target of ARTIFACT_TARGETS) {
    if (options.only && !options.only.includes(target.repo)) continue;
    const base = { ...target, label: `${target.repo}:${target.artifact}` };
    const done = (file: string): void => {
      plan.push({ ...base, file, skip: null, error: null });
    };
    const explicit = options.repoRoots[target.repo];
    if (explicit !== undefined) {
      if (exists(explicit)) done(join(explicit, target.path));
      else {
        plan.push({
          ...base,
          file: null,
          skip: null,
          error: `--repo ${target.repo}=${explicit}: no such directory`,
        });
      }
    } else if (options.outRoot !== null) {
      done(join(options.outRoot, REPO_DIRS[target.repo], target.path));
    } else if (target.repo === 'backend') {
      done(join(checkout.backendRoot, target.path));
    } else if (checkout.linkedWorktree) {
      plan.push({
        ...base,
        file: null,
        skip:
          'this is a linked git worktree, so sibling repos are not written by default ' +
          `(pass --repo ${target.repo}=<dir> or --out-root <dir>)`,
        error: null,
      });
    } else {
      const repoRoot = join(implicitRoot, REPO_DIRS[target.repo]);
      if (exists(repoRoot)) done(join(repoRoot, target.path));
      else {
        plan.push({
          ...base,
          file: null,
          skip: `${repoRoot} is not present in this checkout`,
          error: null,
        });
      }
    }
  }
  return plan;
}

export type TargetStatus =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'ok'
  | 'differs'
  | 'missing'
  | 'skipped'
  | 'error';

export interface TargetResult {
  label: string;
  file: string | null;
  status: TargetStatus;
  detail: string | null;
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write (or with `check`, only compare) every planned target.
 *
 * A copy whose bytes already match is left alone, so a regenerate that changes
 * nothing leaves no file touched.
 */
export function applyTargets(
  plan: readonly PlannedTarget[],
  contents: Record<ArtifactName, string>,
  opts: { check: boolean },
): TargetResult[] {
  return plan.map((target): TargetResult => {
    const { label, file } = target;
    if (target.error !== null) return { label, file: null, status: 'error', detail: target.error };
    if (file === null) return { label, file: null, status: 'skipped', detail: target.skip };
    const wanted = contents[target.artifact];
    const current = readOrNull(file);
    if (opts.check) {
      if (current === null) return { label, file, status: 'missing', detail: null };
      return { label, file, status: current === wanted ? 'ok' : 'differs', detail: null };
    }
    if (current === wanted) return { label, file, status: 'unchanged', detail: null };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, wanted);
    return { label, file, status: current === null ? 'created' : 'updated', detail: null };
  });
}

/** Statuses that make the command exit non-zero. */
export function isFailure(status: TargetStatus): boolean {
  return status === 'error' || status === 'differs' || status === 'missing';
}

export function formatResult(result: TargetResult): string {
  const where = result.file ?? '';
  const detail = result.detail ? ` (${result.detail})` : '';
  const word = result.status === 'differs' ? 'DIFFERS' : result.status;
  return `${word.padEnd(9)} ${result.label.padEnd(24)} ${where}${detail}`.trimEnd();
}
