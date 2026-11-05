import { describe, expect, it } from 'vitest';
import { runPrefix } from '@xorgate/workflow-engine';
import {
  RUN_CANCELLED_ERROR,
  RUN_CANCELLED_STATUS,
  cancelMarkerBody,
  cancelMarkerKey,
  cancelledDurationMs,
  decideStopTask,
  defaultSavedSimulationName,
  resolveSavedSimulationName,
  saveRunRefusal,
  saveSimulationSchema,
  simulationBindingsSnapshot,
  toSavedSimulation,
} from '../src/workflows/simulation-saves';

const RUN_ID = '0b9c2f9e-1d7a-4a43-9d55-2b8f0b2f6a11';
const ARN = 'arn:aws:ecs:us-east-1:123456789012:task/cluster/abc123';

describe('cancel: the StopTask decision', () => {
  const base = { executionMode: 'fargate', taskArn: ARN, otherRunningOnTask: 0, clusterConfigured: true };

  it('stops a fargate task no other running run shares', () => {
    expect(decideStopTask(base)).toEqual({ stop: true, taskArn: ARN });
  });

  it('never stops a Lambda run (cannot be stopped; finalize skips the row)', () => {
    expect(decideStopTask({ ...base, executionMode: 'lambda' })).toEqual({ stop: false, reason: 'lambda' });
  });

  it('has nothing to stop before dispatch stamps a task', () => {
    expect(decideStopTask({ ...base, taskArn: null })).toEqual({ stop: false, reason: 'no_task' });
  });

  it('leaves a warm session alone while it serves another running run', () => {
    expect(decideStopTask({ ...base, otherRunningOnTask: 1 })).toEqual({ stop: false, reason: 'shared_session' });
  });

  it('skips StopTask when the cluster is not configured', () => {
    expect(decideStopTask({ ...base, clusterConfigured: false })).toEqual({ stop: false, reason: 'no_cluster' });
  });
});

describe('cancel: row + marker shaping', () => {
  it('uses the terminal status and error the frontend renders', () => {
    expect(RUN_CANCELLED_STATUS).toBe('cancelled');
    expect(RUN_CANCELLED_ERROR).toBe('Cancelled by user');
  });

  it('writes the marker under the run prefix', () => {
    expect(cancelMarkerKey(RUN_ID)).toBe(`${runPrefix(RUN_ID)}cancel.json`);
  });

  it('marker body carries run, time and requester', () => {
    const body = JSON.parse(
      cancelMarkerBody({ runId: RUN_ID, requestedAt: new Date('2026-11-05T10:00:00Z'), requestedByUserId: 'sub-1' }),
    );
    expect(body).toEqual({ runId: RUN_ID, requestedAt: '2026-11-05T10:00:00.000Z', requestedByUserId: 'sub-1' });
  });

  it('duration is ended minus started, never negative', () => {
    const started = new Date('2026-11-05T10:00:00Z');
    expect(cancelledDurationMs(started, new Date('2026-11-05T10:00:02.500Z'))).toBe(2500);
    expect(cancelledDurationMs(started, new Date('2026-11-05T09:59:59Z'))).toBe(0);
  });
});

describe('save: name, body and eligibility', () => {
  it('defaults the name to the run start in UTC', () => {
    expect(defaultSavedSimulationName(new Date('2026-11-05T07:04:59Z'))).toBe('Simulation 2026-11-05 07:04');
  });

  it('keeps a given name (trimmed) and falls back for blank ones', () => {
    const at = new Date('2026-11-05T07:04:00Z');
    expect(resolveSavedSimulationName('  Rainy drive ', at)).toBe('Rainy drive');
    expect(resolveSavedSimulationName('   ', at)).toBe('Simulation 2026-11-05 07:04');
    expect(resolveSavedSimulationName(undefined, at)).toBe('Simulation 2026-11-05 07:04');
    expect(resolveSavedSimulationName(null, at)).toBe('Simulation 2026-11-05 07:04');
  });

  it('body accepts {} and {name}, rejects unknown keys and over-long names', () => {
    expect(saveSimulationSchema.safeParse({}).success).toBe(true);
    expect(saveSimulationSchema.safeParse({ name: 'x' }).success).toBe(true);
    expect(saveSimulationSchema.safeParse({ name: 'x', extra: 1 }).success).toBe(false);
    expect(saveSimulationSchema.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
  });

  it('only terminal simulation runs of this template are saveable', () => {
    const run = { templateId: 't1', mode: 'simulation', status: 'cancelled' };
    expect(saveRunRefusal(run, 't1')).toBeNull();
    expect(saveRunRefusal({ ...run, status: 'succeeded' }, 't1')).toBeNull();
    expect(saveRunRefusal({ ...run, status: 'running' }, 't1')).toBe('not_terminal');
    expect(saveRunRefusal({ ...run, mode: 'production' }, 't1')).toBe('not_found');
    expect(saveRunRefusal(run, 't2')).toBe('not_found');
  });

  it('snapshots triggerContext.bindings, null otherwise', () => {
    const bindings = { src: { kind: 'upload', key: 'k' } };
    expect(simulationBindingsSnapshot({ type: 'simulation', bindings })).toEqual(bindings);
    expect(simulationBindingsSnapshot({ type: 'simulation' })).toBeNull();
    expect(simulationBindingsSnapshot(null)).toBeNull();
  });
});

describe('save: the SavedSimulation wire shape', () => {
  it('maps the row + run (executionMode -> engineTarget)', () => {
    const saved = toSavedSimulation(
      {
        id: 's1',
        templateId: 't1',
        runId: RUN_ID,
        name: 'Rainy drive',
        bindings: null,
        createdAt: new Date('2026-11-05T10:00:00Z'),
        updatedAt: new Date('2026-11-05T10:05:00Z'),
      },
      {
        id: RUN_ID,
        status: 'cancelled',
        mode: 'simulation',
        startedAt: new Date('2026-11-05T09:59:00Z'),
        endedAt: null,
        durationMs: null,
        templateVersion: 3,
        executionMode: 'fargate',
        error: 'Cancelled by user',
        eventCount: 0,
      },
    );
    expect(saved).toEqual({
      id: 's1',
      templateId: 't1',
      runId: RUN_ID,
      name: 'Rainy drive',
      bindings: null,
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:05:00.000Z',
      run: {
        id: RUN_ID,
        status: 'cancelled',
        mode: 'simulation',
        startedAt: '2026-11-05T09:59:00.000Z',
        endedAt: null,
        durationMs: null,
        templateVersion: 3,
        engineTarget: 'fargate',
        error: 'Cancelled by user',
        eventCount: 0,
      },
    });
  });
});
