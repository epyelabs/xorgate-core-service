import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * the day a namespace is added. A directory that IS that repo is refused
 * whatever option named it.
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

/** `package.json` name of each Node repo: how a directory proves what it is. */
export const REPO_PACKAGE_NAMES = {
  backend: 'xorgate-core-service',
  web: 'xorgate-web',
} as const;

/** The frozen JS agent's `package.json` name. A root carrying it is never written. */
export const JS_AGENT_PACKAGE_NAME = 'xorgate-device-agent';

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

/** Process exit codes of the command. */
export const EXIT = {
  ok: 0,
  /** `--check` found a copy that differs or is missing. Nothing is wrong with the run. */
  drift: 1,
  /** The command line was not understood. Nothing was read or written. */
  usage: 2,
  /** A destination was refused, a read or write failed, or there was nothing to do. */
  error: 3,
} as const;

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
                        device), e.g. a git worktree of it. Repeatable. <dir>
                        must BE that repo (see below).
  --only <name,…>       Write only these repos' copies. Repeatable.
  --check               Write nothing. Report each copy as ok, DIFFERS or
                        missing.
  -h, --help            This text.

Paths may be absolute or relative to the backend repo root.

A destination must be the repo it is named for: the Rust agent has Cargo.toml
and crates/xorgate-core/, the console and the backend have a package.json with
their name. The frozen JS agent (package "${JS_AGENT_PACKAGE_NAME}") is refused
always. Directories under --out-root are scratch and are not checked.
If any destination is refused, NOTHING is written.

Exit: 0 done (or --check: all ok); 1 --check found a copy that DIFFERS or is
missing; 2 bad command line; 3 a destination was refused, a read or write
failed, or every selected copy was skipped.`;

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
    // The option's value: `--flag=value` or the next argument. Another option
    // is never a value (`--out-root --check` must not write into "./--check").
    const value = (): string | undefined => {
      const taken = inline !== undefined ? inline : argv[(i += 1)];
      return taken === undefined || taken === '' || taken.startsWith('--') ? undefined : taken;
    };
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--check':
        if (inline !== undefined) return { error: '--check takes no value' };
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
        // A repeated --only adds to the list.
        const picked: RepoName[] = options.only ?? [];
        const listed = list.split(',').map((s) => s.trim()).filter(Boolean);
        if (listed.length === 0) return { error: '--only needs a list of repos' };
        for (const name of listed) {
          if (!isRepoName(name)) return { error: `--only: unknown repo "${name}" (${names})` };
          if (!picked.includes(name)) picked.push(name);
        }
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

/** The little the planner needs to know about the file system. Injectable for tests. */
export interface RepoProbe {
  /** What is at `path`: a directory, something else, or nothing. */
  kind(path: string): 'dir' | 'file' | null;
  /** A file's text, or null when it cannot be read. */
  readText(path: string): string | null;
}

export const fsProbe: RepoProbe = {
  kind(path) {
    try {
      return statSync(path).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  },
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

function packageNameAt(root: string, probe: RepoProbe): string | null {
  const text = probe.readText(join(root, 'package.json'));
  if (text === null) return null;
  try {
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** Why `root` is the frozen JS agent, or null. Asked of EVERY destination. */
function jsAgentProblem(root: string, probe: RepoProbe): string | null {
  return packageNameAt(root, probe) === JS_AGENT_PACKAGE_NAME
    ? `it is the frozen JS agent (package "${JS_AGENT_PACKAGE_NAME}"), which is never written`
    : null;
}

/**
 * Why `root` cannot be the checkout of `repo`, or null when it is one.
 *
 * A wrong directory is the expensive mistake here: `--repo device=<the JS
 * agent>` would drop a `fixtures/` file into a frozen repo, and a typo would
 * create a tree somewhere unrelated. So a destination has to PROVE what it is
 * before anything is written into it.
 */
export function repoRootProblem(repo: RepoName, root: string, probe: RepoProbe): string | null {
  const kind = probe.kind(root);
  if (kind === null) return 'no such directory';
  if (kind !== 'dir') return 'not a directory';
  const frozen = jsAgentProblem(root, probe);
  if (frozen) return frozen;
  if (repo === 'device') {
    const ok =
      probe.kind(join(root, 'Cargo.toml')) === 'file' &&
      probe.kind(join(root, 'crates', 'xorgate-core')) === 'dir';
    return ok ? null : 'it is not the Rust agent repo (no Cargo.toml with crates/xorgate-core/)';
  }
  const wanted = REPO_PACKAGE_NAMES[repo];
  const found = packageNameAt(root, probe);
  if (found === wanted) return null;
  const saw = found === null ? 'no readable package.json name' : `package.json names "${found}"`;
  return `it is not the ${repo} repo (expected package "${wanted}", ${saw})`;
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

type RootDecision = { root: string } | { skip: string } | { error: string };

/**
 * Decide, per target, which file it is. Reads the file system only through
 * `probe`, and writes nothing.
 *
 * A repo's root is, in order:
 *   1. `--repo <name>=<dir>`: that directory. It must be that repo
 *      (`repoRootProblem`), else the target is in ERROR.
 *   2. `--out-root <dir>`: `<dir>/<the repo's relative directory>`, created
 *      on write. This redirects the backend's own copies too, so a run with
 *      it touches nothing outside `<dir>`. Scratch by design: it is not asked
 *      to prove what it is (only that it is not the JS agent).
 *   3. The backend: the checkout the generator runs from.
 *   4. A sibling, from the backend's MAIN checkout: two levels above the
 *      backend root (`<root>/backend/xorgate-core-service` → `<root>`), then
 *      the sibling's relative directory. SKIPPED when it is not there, so a
 *      backend-only checkout still regenerates its own copies; in ERROR when
 *      something else is there.
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
  probe: RepoProbe = fsProbe,
): PlannedTarget[] {
  const implicitRoot = resolve(checkout.backendRoot, '..', '..');

  const decide = (repo: RepoName): RootDecision => {
    const explicit = options.repoRoots[repo];
    if (explicit !== undefined) {
      const problem = repoRootProblem(repo, explicit, probe);
      return problem ? { error: `--repo ${repo}=${explicit}: ${problem}` } : { root: explicit };
    }
    if (options.outRoot !== null) {
      const root = join(options.outRoot, REPO_DIRS[repo]);
      const frozen = jsAgentProblem(root, probe);
      return frozen ? { error: `${root}: ${frozen}` } : { root };
    }
    if (repo === 'backend') {
      const problem = repoRootProblem(repo, checkout.backendRoot, probe);
      return problem ? { error: `${checkout.backendRoot}: ${problem}` } : { root: checkout.backendRoot };
    }
    if (checkout.linkedWorktree) {
      return {
        skip:
          'this is a linked git worktree, so sibling repos are not written by default ' +
          `(pass --repo ${repo}=<dir> or --out-root <dir>)`,
      };
    }
    const root = join(implicitRoot, REPO_DIRS[repo]);
    if (probe.kind(root) === null) return { skip: `${root} is not present in this checkout` };
    const problem = repoRootProblem(repo, root, probe);
    return problem ? { error: `${root}: ${problem}` } : { root };
  };

  const decisions = new Map<RepoName, RootDecision>();
  const plan: PlannedTarget[] = [];
  for (const target of ARTIFACT_TARGETS) {
    if (options.only && !options.only.includes(target.repo)) continue;
    let decision = decisions.get(target.repo);
    if (!decision) {
      decision = decide(target.repo);
      decisions.set(target.repo, decision);
    }
    plan.push({
      ...target,
      label: `${target.repo}:${target.artifact}`,
      file: 'root' in decision ? join(decision.root, target.path) : null,
      skip: 'skip' in decision ? decision.skip : null,
      error: 'error' in decision ? decision.error : null,
    });
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
  | 'refused'
  | 'error';

export interface TargetResult {
  label: string;
  file: string | null;
  status: TargetStatus;
  detail: string | null;
}

/** The current text, or null when the file does not exist. Any other failure throws. */
function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Write through a sibling temp file and a rename, so a failure never leaves half a file. */
function writeWhole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

function failureText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Write (or with `check`, only compare) every planned target.
 *
 * - The plan is judged first: if ANY target is in error (a refused
 *   destination), a write run writes NOTHING; the other targets are reported
 *   `refused`. A check run still compares them, since it cannot do harm.
 * - A copy whose bytes already match is left alone.
 * - A read or write that fails is reported as that target's `error`, with the
 *   path and the reason, and the run goes on to the next target.
 * - `onResult` is called as each target is finished, so the command prints
 *   what happened as it happens, not after.
 */
export function applyTargets(
  plan: readonly PlannedTarget[],
  contents: Record<ArtifactName, string>,
  opts: { check: boolean; onResult?: (result: TargetResult) => void },
): TargetResult[] {
  const planFailed = plan.some((t) => t.error !== null);
  const one = (target: PlannedTarget): TargetResult => {
    const { label, file } = target;
    if (target.error !== null) return { label, file: null, status: 'error', detail: target.error };
    if (file === null) return { label, file: null, status: 'skipped', detail: target.skip };
    if (planFailed && !opts.check) {
      return {
        label,
        file,
        status: 'refused',
        detail: 'not written: another destination was refused',
      };
    }
    const wanted = contents[target.artifact];
    try {
      const current = readIfPresent(file);
      if (opts.check) {
        if (current === null) return { label, file, status: 'missing', detail: null };
        return { label, file, status: current === wanted ? 'ok' : 'differs', detail: null };
      }
      if (current === wanted) return { label, file, status: 'unchanged', detail: null };
      writeWhole(file, wanted);
      return { label, file, status: current === null ? 'created' : 'updated', detail: null };
    } catch (e) {
      return { label, file, status: 'error', detail: failureText(e) };
    }
  };
  return plan.map((target) => {
    const result = one(target);
    opts.onResult?.(result);
    return result;
  });
}

/** True for a status that is a problem (as opposed to a normal outcome). */
export function isFailure(status: TargetStatus): boolean {
  return status === 'error' || status === 'refused' || status === 'differs' || status === 'missing';
}

/**
 * The command's exit code and, when it is not obvious from the lines already
 * printed, one sentence saying why.
 *
 * A run in which every selected copy was skipped did nothing, and says so
 * with a non-zero code: `--only device` from a linked worktree must not look
 * like a successful write.
 */
export function summarize(results: readonly TargetResult[]): { code: number; message: string | null } {
  if (results.some((r) => r.status === 'error' || r.status === 'refused')) {
    const refused = results.some((r) => r.status === 'refused');
    return {
      code: EXIT.error,
      message: refused ? 'nothing was written: a destination was refused' : null,
    };
  }
  if (results.every((r) => r.status === 'skipped')) {
    const hint = results[0]?.detail ? ` (${results[0].detail})` : '';
    return {
      code: EXIT.error,
      message: `nothing to do: every selected copy was skipped${hint}`,
    };
  }
  if (results.some((r) => r.status === 'differs' || r.status === 'missing')) {
    return { code: EXIT.drift, message: null };
  }
  return { code: EXIT.ok, message: null };
}

export function formatResult(result: TargetResult): string {
  const where = result.file ?? '';
  const detail = result.detail ? ` (${result.detail})` : '';
  const word = result.status === 'differs' ? 'DIFFERS' : result.status;
  return `${word.padEnd(9)} ${result.label.padEnd(24)} ${where}${detail}`.trimEnd();
}
