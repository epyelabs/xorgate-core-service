/**
 * The pure rules behind a device data purge (plans/device-wf-data-delete),
 * kept free of AWS and database imports so they can be unit-tested and so the
 * job (services/device-purge.ts) reads as a walk over a plan rather than as
 * plumbing.
 */

export const PURGE_SCOPES = ['workflows', 'telemetry', 'media'] as const;
export type PurgeScope = (typeof PURGE_SCOPES)[number];

export const PURGE_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type PurgeStatus = (typeof PURGE_STATUSES)[number];

/**
 * The ordered steps, each idempotent and resumable. Attachments go first so no
 * new run can be fired while the rest runs; S3 is drained before the rows that
 * index it, the order the per-session delete already uses.
 */
export const PURGE_STEPS = [
  'workflows.attachments',
  'workflows.stop',
  'workflows.runs',
  'telemetry.s3',
  'telemetry.sessions',
  'telemetry.ingestLog',
  'telemetry.readings',
  'media.s3',
  'media.sessions',
  'done',
] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

/** The steps a purge with these scopes walks, in order, always ending in `done`. */
export function purgeSteps(scopes: readonly string[]): PurgeStep[] {
  const wanted = new Set(scopes);
  return PURGE_STEPS.filter((step) => step === 'done' || wanted.has(step.split('.')[0]));
}

/** Validate and normalise a request body's scopes: known values, deduplicated, non-empty. */
export function normaliseScopes(input: unknown): PurgeScope[] | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: `scopes must be a non-empty array of ${PURGE_SCOPES.join(' | ')}` };
  }
  const out: PurgeScope[] = [];
  for (const value of input) {
    if (!PURGE_SCOPES.includes(value as PurgeScope)) {
      return { error: `unknown scope ${JSON.stringify(value)}; expected ${PURGE_SCOPES.join(' | ')}` };
    }
    if (!out.includes(value as PurgeScope)) out.push(value as PurgeScope);
  }
  return out;
}

/** Counts the job accumulates; every key present from the start so the UI can render zeros. */
export interface PurgeCounts {
  attachments: number;
  runs: number;
  runObjects: number;
  telemetrySessions: number;
  telemetryObjects: number;
  ingestLogRows: number;
  readings: number;
  mediaSessions: number;
  mediaObjects: number;
}

export function initialCounts(): PurgeCounts {
  return {
    attachments: 0,
    runs: 0,
    runObjects: 0,
    telemetrySessions: 0,
    telemetryObjects: 0,
    ingestLogRows: 0,
    readings: 0,
    mediaSessions: 0,
    mediaObjects: 0,
  };
}

/**
 * Where the job is. `step` names the current step; the other fields are that
 * step's own position and are cleared when the step completes.
 */
export interface PurgeCursor {
  step: PurgeStep;
  /** workflows.runs: the last run id deleted (runs are walked in id order). */
  afterRunId?: string;
  /** telemetry.s3 / media.s3: the ListObjectsV2 continuation token. */
  s3Token?: string;
  /** telemetry.readings: start of the next window (ISO) and its span in ms. */
  windowStart?: string;
  spanMs?: number;
}

export const READINGS_DAY_MS = 24 * 60 * 60 * 1000;
/** Below one hour the halving stops and the step fails: something else is wrong. */
export const READINGS_MIN_SPAN_MS = 60 * 60 * 1000;

/** Floor an instant to the start of its UTC day. */
export function dayFloor(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * The [start, end) window to delete next, clipped to the cutoff, or null when
 * the cursor has reached it.
 */
export function nextReadingsWindow(
  cursor: { windowStart: string; spanMs: number },
  cutoff: Date,
): { start: Date; end: Date } | null {
  const start = new Date(cursor.windowStart);
  if (start >= cutoff) return null;
  const end = new Date(Math.min(start.getTime() + cursor.spanMs, cutoff.getTime()));
  return { start, end };
}

/** Half the span, or null once it would drop under the floor (the 008 migration's rule). */
export function halveWindow(spanMs: number): number | null {
  const next = Math.floor(spanMs / 2);
  return next < READINGS_MIN_SPAN_MS ? null : next;
}

/** After an empty window, widen back toward a day so a sparse history is walked quickly. */
export function widenWindow(spanMs: number): number {
  return Math.min(spanMs * 2, READINGS_DAY_MS);
}

/** The Data API's ~45 s ceiling, as the SDK reports it. */
export function isStatementTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'StatementTimeoutException'
  );
}

/**
 * The S3 prefixes a run's artifacts live under: the v2 convention keyed by run
 * id, plus the directory of any `workflows/v1/...` key the run's `artifacts`
 * jsonb names (legacy PoC runs). Keys elsewhere (a dataset copy, an upload)
 * are not the run's to delete.
 */
export function runArtifactPrefixes(runId: string, artifacts: unknown): string[] {
  const prefixes = new Set<string>([`workflows/v2/runs/${runId}/`]);
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      keys.push(node);
      return;
    }
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(artifacts);
  for (const key of keys) {
    if (!key.startsWith('workflows/v1/')) continue;
    const dir = key.slice(0, key.lastIndexOf('/') + 1);
    // Only a prefix that actually names this run is safe to sweep whole.
    if (dir.includes(runId)) prefixes.add(dir);
  }
  return [...prefixes];
}

/**
 * Whether a `running` row is really abandoned: its lease is gone and nothing
 * has renewed it for longer than any single worker invocation could last.
 */
export const STALL_GRACE_MS = 30 * 60 * 1000;
export function isStalled(
  row: { status: string; leaseUntil: Date | null },
  now: Date = new Date(),
): boolean {
  if (row.status !== 'running' && row.status !== 'queued') return false;
  if (!row.leaseUntil) return row.status === 'running';
  return row.leaseUntil.getTime() + STALL_GRACE_MS < now.getTime();
}
