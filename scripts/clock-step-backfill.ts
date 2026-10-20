import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/**
 * Clock-step backfill driver (plans/clock-step-correction, P3 / PLAN §4.4).
 *
 * Repairs the sessions ingested BEFORE the ingest-time correction shipped:
 * media segments whose `duration_ms` is `nominal + CLOCK_STEP_MIN_MS` or more
 * (the fragment that was open across a stale-boot clock step), and telemetry
 * sessions whose sample lines show a wall-vs-monotonic jump. The work runs
 * INSIDE the deployed OfflineSweeperFn (`{ job: 'clock-step-backfill' }`): it
 * is the only principal with object access to the core bucket, and it shares
 * the exact correction code the ingest Lambdas use (services/media-clock-step.ts,
 * services/telemetry-clock-step.ts), so the backfill cannot drift from ingest.
 *
 *   npm run backfill:clock-step -- --stage dev                 # dry run (default)
 *   npm run backfill:clock-step -- --stage prod --profile xorgate-prod --apply
 *   npm run backfill:clock-step -- --stage prod --profile xorgate-prod --session <id> --apply
 *   npm run backfill:clock-step -- --stage dev --media-only | --telemetry-only
 *
 * Dry run prints the before/after table and changes nothing. `--apply` runs the
 * same routine the ingest path runs, one session per transaction, and prints
 * the same table from the committed rows. Idempotent: a corrected session has
 * no inflated row and no in-file step left, so a second run finds nothing.
 */

const execFileP = promisify(execFile);

interface Args {
  stage: 'dev' | 'prod';
  profile?: string;
  apply: boolean;
  sessionId?: string;
  mediaOnly: boolean;
  telemetryOnly: boolean;
  limit: number;
  maxPasses: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { stage: 'dev', apply: false, mediaOnly: false, telemetryOnly: false, limit: 20, maxPasses: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--stage') {
      const v = next();
      if (v !== 'dev' && v !== 'prod') throw new Error('--stage must be dev or prod');
      args.stage = v;
    } else if (a === '--profile') args.profile = next();
    else if (a === '--apply') args.apply = true;
    else if (a === '--session') args.sessionId = next();
    else if (a === '--media-only') args.mediaOnly = true;
    else if (a === '--telemetry-only') args.telemetryOnly = true;
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--max-passes') args.maxPasses = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.mediaOnly && args.telemetryOnly) throw new Error('--media-only and --telemetry-only are exclusive');
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

async function invoke(lambda: LambdaClient, fn: string, payload: unknown): Promise<ClockStepBackfillResult> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: fn,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const body = res.Payload ? Buffer.from(res.Payload).toString('utf8') : '';
  if (res.FunctionError) throw new Error(`sweeper job failed: ${res.FunctionError} ${body}`);
  if (!body) throw new Error('sweeper job returned no payload');
  return JSON.parse(body) as ClockStepBackfillResult;
}

// --- Response contract of the sweeper job (handlers/offline-sweeper.ts) -----

interface SessionBounds {
  startedAt: string;
  endedAt: string | null;
  /** media: sum(duration_ms); telemetry: ended − started. */
  spanMs: number;
}

export interface MediaClockStepCandidate {
  deviceId: string;
  deviceName: string | null;
  sessionId: string;
  streamKey: string;
  seq: number;
  rawStartTs: string;
  rawDurationMs: number;
  nominalMs: number;
  stepMs: number;
  finalized: boolean;
  /** Rows with start_ts <= rawStartTs in the session (the ones that shift). */
  shiftedRows: number;
  before: SessionBounds;
  /** Present after apply (committed rows) and on dry run (computed). */
  after: SessionBounds;
  applied: boolean;
  error?: string;
}

export interface TelemetryClockStepCandidate {
  deviceId: string;
  deviceName: string | null;
  sessionId: string;
  /** Segment (seq) whose lines carry the step, and the step(s) found in it. */
  seq: number;
  steps: { atIndex: number; jumpMs: number }[];
  totalShiftMs: number;
  earlierFiles: number;
  before: SessionBounds;
  after: SessionBounds;
  applied: boolean;
  error?: string;
}

export interface ClockStepBackfillResult {
  dryRun: boolean;
  media: { scanned: number; candidates: MediaClockStepCandidate[] };
  telemetry: { scanned: number; candidates: TelemetryClockStepCandidate[] };
  /** True when `limit` cut the scan short; re-run with `after = nextAfter`. */
  truncated: boolean;
  nextAfter: string | null;
}

// --- Printing ----------------------------------------------------------------

function fmtMs(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${sign}${h ? `${h}h ` : ''}${m}m ${sec}s`;
}

function short(id: string): string {
  return id.slice(0, 8);
}

function printMedia(rows: MediaClockStepCandidate[]): void {
  if (rows.length === 0) {
    console.log('media: no inflated segments');
    return;
  }
  console.log('media sessions:');
  console.log(
    '  device            session   seq  raw duration      step            before (start → sum)                     after (start → sum)                      shifted  status',
  );
  for (const r of rows) {
    const status = r.error ? `ERROR ${r.error}` : r.applied ? 'APPLIED' : r.finalized ? 'would shift' : 'would clamp only';
    console.log(
      `  ${(r.deviceName ?? r.deviceId).padEnd(17)} ${short(r.sessionId)}  ${String(r.seq).padStart(3)}  ${fmtMs(r.rawDurationMs).padEnd(16)}  ${fmtMs(r.stepMs).padEnd(14)}  ${r.before.startedAt} → ${fmtMs(r.before.spanMs).padEnd(12)}  ${r.after.startedAt} → ${fmtMs(r.after.spanMs).padEnd(12)}  ${String(r.shiftedRows).padStart(7)}  ${status}`,
    );
  }
}

function printTelemetry(rows: TelemetryClockStepCandidate[]): void {
  if (rows.length === 0) {
    console.log('telemetry: no in-file clock steps');
    return;
  }
  console.log('telemetry sessions:');
  console.log(
    '  device            session   seq  steps                      total shift     before (start → span)                    after (start → span)                     files  status',
  );
  for (const r of rows) {
    const status = r.error ? `ERROR ${r.error}` : r.applied ? 'APPLIED' : 'would shift';
    const steps = r.steps.map((s) => `@${s.atIndex}:${fmtMs(s.jumpMs)}`).join(' ');
    console.log(
      `  ${(r.deviceName ?? r.deviceId).padEnd(17)} ${short(r.sessionId)}  ${String(r.seq).padStart(3)}  ${steps.padEnd(25)}  ${fmtMs(r.totalShiftMs).padEnd(14)}  ${r.before.startedAt} → ${fmtMs(r.before.spanMs).padEnd(12)}  ${r.after.startedAt} → ${fmtMs(r.after.spanMs).padEnd(12)}  ${String(r.earlierFiles).padStart(5)}  ${status}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.profile) process.env.AWS_PROFILE = args.profile;
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const fn = await resolveSweeperFunction(args.stage);
  const lambda = new LambdaClient({ region });
  console.log(`sweeper function: ${fn} (${args.stage}, ${args.apply ? 'APPLY' : 'dry run'})`);

  let after: string | undefined;
  let errors = 0;
  for (let pass = 1; pass <= args.maxPasses; pass++) {
    const out = await invoke(lambda, fn, {
      job: 'clock-step-backfill',
      dryRun: !args.apply,
      sessionId: args.sessionId,
      mediaOnly: args.mediaOnly,
      telemetryOnly: args.telemetryOnly,
      limit: args.limit,
      after,
    });
    console.log(
      `pass ${pass}: scanned media=${out.media.scanned} telemetry=${out.telemetry.scanned}` +
        (after ? ` (after ${after})` : ''),
    );
    printMedia(out.media.candidates);
    printTelemetry(out.telemetry.candidates);
    errors += [...out.media.candidates, ...out.telemetry.candidates].filter((c) => c.error).length;
    if (!out.truncated || !out.nextAfter || out.nextAfter === after) break;
    after = out.nextAfter;
  }
  if (errors > 0) {
    console.error(`${errors} session(s) failed; see the sweeper's CloudWatch log`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
