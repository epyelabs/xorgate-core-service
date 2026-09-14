import { describe, expect, it, vi } from 'vitest';

// The service imports the db module at load; the pure helper under test never
// touches it, so stub the module the way the other handler tests do.
vi.mock('../src/db/index', async () => {
  const schema = await vi.importActual<typeof import('../src/db/schema')>('../src/db/schema');
  return { db: {}, schema };
});

const { stoppedOutcome } = await import('../src/services/training-finalize');

describe('stoppedOutcome (xorgate-models M5)', () => {
  it('maps a platform-requested stop to cancelled', () => {
    const out = stoppedOutcome({ phase: 'training', stopRequestedAt: '2026-09-14T15:00:00.000Z' }, { secondaryStatus: 'Stopped', statusMessage: 'Training job stopped', failureReason: null });
    expect(out).toEqual({ status: 'cancelled', error: 'Cancelled' });
  });

  it('closes a spot job that never found capacity as failed with a plain reason', () => {
    const out = stoppedOutcome({ phase: 'starting' }, { secondaryStatus: 'MaxWaitTimeExceeded', statusMessage: 'Training job wait time exceeded MaxWaitTimeInSeconds provided', failureReason: null });
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/No spot instance became available/);
    expect(out.error).toMatch(/CPU target/);
  });

  it('closes any other SageMaker-side stop as failed and keeps the secondary status', () => {
    const out = stoppedOutcome(null, { secondaryStatus: 'Interrupted', statusMessage: 'Spot instance interrupted', failureReason: null });
    expect(out.status).toBe('failed');
    expect(out.error).toBe('SageMaker stopped the job before it finished (Interrupted: Spot instance interrupted)');
  });

  it('falls back to the failure reason and a bare Stopped', () => {
    const out = stoppedOutcome({}, { secondaryStatus: null, statusMessage: null, failureReason: 'boom' });
    expect(out).toEqual({ status: 'failed', error: 'SageMaker stopped the job before it finished (Stopped: boom)' });
  });
});
