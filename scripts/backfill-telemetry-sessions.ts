/**
 * Backfill the telemetry session index (telemetry-session-artifacts plan,
 * Phase 1, step 1.6) for objects ingested before the index existed.
 *
 * The work itself runs INSIDE the deployed OfflineSweeperFn (it is the only
 * principal with object access to the core bucket, and it shares the exact
 * `indexSegment` / normalisation code path the ingest uses): this script only
 * invokes it with `{ job: 'telemetry-backfill', limit }` until the Lambda
 * reports no ingest-log row left without an index row, then prints the
 * housekeeping (close + overview build) counters of every pass. Idempotent;
 * safe to re-run at any time.
 *
 *   npm run backfill:telemetry -- --stage dev [--limit 40] [--profile xorgate-prod]
 *   npm run backfill:telemetry -- --stage dev --inspect <telemetrySessionId>
 *
 * `--inspect` prints one session's index rows plus presigned GET URLs for its
 * overview and segments (the sweeper's `telemetry-session-inspect` job).
 *
 * Side effects to expect (README Q14): every backfilled object is CopyObject'd
 * onto itself with `Content-Encoding: gzip`, which re-fires its Object Created
 * event once; the ingest Lambda's fast-path dedupe answers each with one
 * "already ingested, skipping" line. The copy also restarts the object's S3
 * lifecycle clock, so backfilled segments age from the day of the backfill.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const execFileP = promisify(execFile);

interface Args {
  stage: 'dev' | 'prod';
  limit: number;
  profile?: string;
  inspect?: string;
  maxPasses: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { stage: 'dev', limit: 40, maxPasses: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--stage') {
      const v = next();
      if (v !== 'dev' && v !== 'prod') throw new Error('--stage must be dev or prod');
      args.stage = v;
    } else if (a === '--limit') args.limit = Number(next());
    else if (a === '--profile') args.profile = next();
    else if (a === '--inspect') args.inspect = next();
    else if (a === '--max-passes') args.maxPasses = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

async function resolveSweeperFunction(stage: Args['stage']): Promise<string> {
  const stackName = stage === 'prod' ? 'XorgateCoreApiStack' : 'XorgateCoreApiStackDev';
  const { stdout } = await execFileP('aws', [
    'cloudformation',
    'describe-stack-resources',
    '--stack-name',
    stackName,
    '--query',
    "StackResources[?starts_with(LogicalResourceId, 'OfflineSweeperFn') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId",
    '--output',
    'text',
  ]);
  const name = stdout.trim();
  if (!name) throw new Error(`OfflineSweeperFn not found in ${stackName}`);
  return name;
}

async function invoke(lambda: LambdaClient, fn: string, payload: unknown): Promise<any> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const body = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
  if (res.FunctionError) throw new Error(`sweeper job failed: ${res.FunctionError} ${body}`);
  return body ? JSON.parse(body) : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const fn = await resolveSweeperFunction(args.stage);
  const lambda = new LambdaClient({ region });
  console.log(`sweeper function: ${fn}`);

  if (args.inspect) {
    const out = await invoke(lambda, fn, { job: 'telemetry-session-inspect', sessionId: args.inspect });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const totals = { indexed: 0, alreadyIndexed: 0, missing: 0, failed: 0, normalized: 0, built: 0, closed: 0, orphaned: 0 };
  for (let pass = 1; pass <= args.maxPasses; pass++) {
    const started = Date.now();
    const out = await invoke(lambda, fn, { job: 'telemetry-backfill', limit: args.limit });
    const r = out.reconcile;
    const h = out.housekeeping;
    totals.indexed += r.indexed;
    totals.alreadyIndexed += r.alreadyIndexed;
    totals.missing += r.missing;
    totals.failed += r.failed;
    totals.normalized += r.normalized;
    totals.orphaned = r.orphaned;
    if (h) {
      totals.built += h.built;
      totals.closed += h.closed;
    }
    console.log(
      `pass ${pass}: indexed=${r.indexed} already=${r.alreadyIndexed} missing=${r.missing} failed=${r.failed} ` +
        `normalized=${r.normalized} remaining=${r.remaining} orphaned=${r.orphaned}` +
        (h ? ` | closed=${h.closed} built=${h.built} pendingBuilds=${h.pendingBuilds} buildFailures=${h.buildFailures} bytesBackfilled=${h.bytesBackfilled ?? 0}` : '') +
        ` (${Date.now() - started} ms)`,
    );
    // A failure is not progress: a pass that only fails would repeat forever.
    const progressed = r.indexed + r.alreadyIndexed + r.missing > 0;
    if (r.remaining <= 0 || !progressed) {
      if (r.remaining > 0) {
        console.log(`stopping: ${r.remaining} ingest-log rows remain but the last pass made no progress (see the sweeper's CloudWatch log)`);
      }
      break;
    }
  }
  console.log('totals', totals);

  // Drain the build queue: each pass builds up to 10 overviews.
  for (let pass = 1; pass <= args.maxPasses; pass++) {
    const out = await invoke(lambda, fn, { job: 'telemetry-backfill', limit: 0 });
    const h = out.housekeeping;
    if (!h) break;
    totals.built += h.built;
    console.log(`build pass ${pass}: built=${h.built} pendingBuilds=${h.pendingBuilds} buildFailures=${h.buildFailures} normalized=${h.normalized} bytesBackfilled=${h.bytesBackfilled ?? 0}`);
    if (h.pendingBuilds <= 0 || (h.built === 0 && h.buildFailures > 0)) break;
  }
  console.log('done', totals);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
