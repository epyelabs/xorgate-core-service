import { describe, expect, it, vi } from 'vitest';
import { cancelMarkerKey } from '../src/workflows/simulation-saves';
import {
  CANCEL_ABORT_REASON,
  createCancelWatch,
  s3CancelMarkerHead,
} from '../src/workflows/host/cancel-watch';

const RUN_ID = '0b9c2f9e-1d7a-4a43-9d55-2b8f0b2f6a11';

/** Manual timers: the watch registers one interval; `tick()` fires it. */
function fakeTimers() {
  let cb: (() => void) | null = null;
  let cleared = 0;
  return {
    timers: {
      setInterval: ((fn: () => void) => {
        cb = fn;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => {
        cleared += 1;
        cb = null;
      }) as typeof clearInterval,
    },
    tick: async () => {
      cb?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    get cleared() {
      return cleared;
    },
    get armed() {
      return cb !== null;
    },
  };
}

describe('cancel watch: the polling core', () => {
  it('aborts the signal once the marker appears, then stops polling', async () => {
    const t = fakeTimers();
    let present = false;
    const head = vi.fn(async () => present);
    const log = vi.fn();
    const w = createCancelWatch({ head, timers: t.timers, log });
    expect(w.signal.aborted).toBe(false);
    expect(w.cancelled).toBe(false);

    await t.tick();
    expect(head).toHaveBeenCalledTimes(1);
    expect(w.signal.aborted).toBe(false);

    present = true;
    await t.tick();
    expect(w.signal.aborted).toBe(true);
    expect(w.signal.reason).toBe(CANCEL_ABORT_REASON);
    expect(w.cancelled).toBe(true);
    expect(t.cleared).toBe(1);
    expect(t.armed).toBe(false);
    expect(log).toHaveBeenCalledWith('cancel marker present; aborting the run');

    // A later tick is a no-op: nothing is armed and an aborted watch skips head.
    await w.poll();
    expect(head).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through S3 errors and logs the first one only', async () => {
    const t = fakeTimers();
    const head = vi.fn(async () => {
      throw new Error('AccessDenied');
    });
    const log = vi.fn();
    const w = createCancelWatch({ head, timers: t.timers, log });
    await t.tick();
    await t.tick();
    await t.tick();
    expect(head).toHaveBeenCalledTimes(3);
    expect(w.signal.aborted).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('AccessDenied');
    expect(t.armed).toBe(true);
  });

  it('never overlaps polls while one HeadObject is in flight', async () => {
    const t = fakeTimers();
    let resolve: ((v: boolean) => void) | null = null;
    const head = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    createCancelWatch({ head, timers: t.timers });
    await t.tick();
    await t.tick();
    expect(head).toHaveBeenCalledTimes(1);
    resolve?.(false);
    await new Promise((r) => setTimeout(r, 0)); // let the in-flight poll settle
    await t.tick();
    expect(head).toHaveBeenCalledTimes(2);
  });

  it('stop() is idempotent and leaves the signal alone', async () => {
    const t = fakeTimers();
    const w = createCancelWatch({ head: async () => false, timers: t.timers });
    w.stop();
    w.stop();
    expect(t.cleared).toBe(1);
    expect(w.signal.aborted).toBe(false);
    expect(w.cancelled).toBe(false);
  });

  it('defaults to a 2 s interval and unrefs the timer', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const w = createCancelWatch({ head: async () => false });
    try {
      expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 2000);
    } finally {
      w.stop();
      setIntervalSpy.mockRestore();
    }
  });
});

describe('cancel watch: the S3 head', () => {
  const bucket = 'core-bucket';

  function s3With(outcome: 'ok' | 'notfound' | 'nokey' | '404' | 'denied') {
    const send = vi.fn(async (cmd: { input: { Bucket: string; Key: string } }) => {
      switch (outcome) {
        case 'ok':
          return { ContentLength: 12 };
        case 'notfound':
          throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        case 'nokey':
          throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        case '404':
          throw Object.assign(new Error('404'), { name: 'UnknownError', $metadata: { httpStatusCode: 404 } });
        case 'denied':
          throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      }
      void cmd;
    });
    return { send } as unknown as import('@aws-sdk/client-s3').S3Client & { send: typeof send };
  }

  it('heads exactly <runPrefix>cancel.json and reports presence', async () => {
    const s3 = s3With('ok');
    await expect(s3CancelMarkerHead(s3, bucket, RUN_ID)()).resolves.toBe(true);
    const cmd = s3.send.mock.calls[0][0];
    expect(cmd.input).toEqual({ Bucket: bucket, Key: cancelMarkerKey(RUN_ID) });
    expect(cmd.input.Key).toBe(`workflows/v2/runs/${RUN_ID}/cancel.json`);
  });

  it('maps every flavour of "absent" to false', async () => {
    for (const o of ['notfound', 'nokey', '404'] as const) {
      await expect(s3CancelMarkerHead(s3With(o), bucket, RUN_ID)()).resolves.toBe(false);
    }
  });

  it('rethrows any other error for the core to log', async () => {
    await expect(s3CancelMarkerHead(s3With('denied'), bucket, RUN_ID)()).rejects.toThrow('AccessDenied');
  });
});
