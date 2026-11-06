import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { cancelMarkerKey } from '../simulation-saves';

/**
 * The host half of "cancel an in-flight simulation" (sim-cancel-save,
 * 2026-11-05). POST /workflow-runs/{id}/cancel flips the row and writes
 * `<runPrefix>cancel.json`; this watcher polls that marker (HeadObject) and
 * aborts the engine run through `engine.run({ signal })` (engine 0.5.3) so a
 * Lambda run or a job on a shared warm-session task stops within one poll
 * instead of running to its deadline. A stopped task needs no help from it.
 *
 * Best-effort by design: a missing marker (404) keeps the run going, any other
 * S3 error is logged once and polling continues, and the watcher never throws
 * into the run. `stop()` is idempotent and must run in the host's `finally`.
 */

export const DEFAULT_CANCEL_POLL_MS = 2000;
/** The abort reason the engine lands on cancelled steps (`cancelled: <reason>`). */
export const CANCEL_ABORT_REASON = 'cancelled by user';

export interface CancelWatchHead {
  /** Resolves `true` when the marker exists, `false` on 404/NotFound; rejects otherwise. */
  (): Promise<boolean>;
}

export interface CancelWatchOptions {
  head: CancelWatchHead;
  intervalMs?: number;
  log?: (msg: string) => void;
  /** Test seam: timer factory (defaults to the global setInterval/clearInterval). */
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
}

export interface CancelWatch {
  signal: AbortSignal;
  /** True once the marker was seen and the signal aborted. */
  readonly cancelled: boolean;
  /** Stop polling; safe to call more than once and after an abort. */
  stop: () => void;
  /** One poll, exposed for tests and for a pre-run check. */
  poll: () => Promise<void>;
}

/** Pure core: polls `head` on an interval and aborts the controller once it answers true. */
export function createCancelWatch(opts: CancelWatchOptions): CancelWatch {
  const controller = new AbortController();
  const intervalMs = opts.intervalMs ?? DEFAULT_CANCEL_POLL_MS;
  const timers = opts.timers ?? { setInterval, clearInterval };
  const log = opts.log ?? (() => undefined);
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let errorLogged = false;
  let cancelled = false;

  const stop = () => {
    if (timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  };

  const poll = async () => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    try {
      if (await opts.head()) {
        cancelled = true;
        stop();
        log('cancel marker present; aborting the run');
        controller.abort(CANCEL_ABORT_REASON);
      }
    } catch (err) {
      if (!errorLogged) {
        errorLogged = true;
        log(`cancel marker poll failed (will keep polling): ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      inFlight = false;
    }
  };

  timer = timers.setInterval(() => {
    void poll();
  }, intervalMs);
  // Never keep a process alive for the watcher alone.
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    signal: controller.signal,
    get cancelled() {
      return cancelled;
    },
    stop,
    poll,
  };
}

/**
 * HeadObject on the run's cancel marker; 404/NotFound → false. A 403 is also
 * "absent": S3 answers HeadObject on a missing key with 403 when the caller
 * lacks s3:ListBucket on the prefix (the engine task role now has it, but a
 * role without it must not log an error every run), and a caller that could
 * not read the prefix at all would not have loaded the manifest either.
 */
export function s3CancelMarkerHead(s3: S3Client, bucket: string, runId: string): CancelWatchHead {
  const Key = cancelMarkerKey(runId);
  return async () => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
      return true;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = e?.$metadata?.httpStatusCode;
      if (e?.name === 'NotFound' || e?.name === 'NoSuchKey' || status === 404 || status === 403) return false;
      throw err;
    }
  };
}

/** The production wiring: watch `<runPrefix(runId)>cancel.json` in `bucket`. */
export function watchCancelMarker(args: {
  s3: S3Client;
  bucket: string;
  runId: string;
  intervalMs?: number;
  log?: (msg: string) => void;
}): CancelWatch {
  return createCancelWatch({
    head: s3CancelMarkerHead(args.s3, args.bucket, args.runId),
    intervalMs: args.intervalMs,
    log: args.log,
  });
}
