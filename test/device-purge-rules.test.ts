import { describe, expect, it } from 'vitest';
import {
  dayFloor,
  halveWindow,
  initialCounts,
  isStalled,
  isStatementTimeout,
  nextReadingsWindow,
  normaliseScopes,
  purgeSteps,
  READINGS_DAY_MS,
  READINGS_MIN_SPAN_MS,
  runArtifactPrefixes,
  STALL_GRACE_MS,
  widenWindow,
} from '../src/services/device-purge-rules';

describe('purgeSteps', () => {
  it('walks every step, in order, ending in done, for all three scopes', () => {
    expect(purgeSteps(['workflows', 'telemetry', 'media'])).toEqual([
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
    ]);
  });
  it('skips the scopes that were not asked for', () => {
    expect(purgeSteps(['media'])).toEqual(['media.s3', 'media.sessions', 'done']);
    expect(purgeSteps(['telemetry', 'workflows'])).toEqual([
      'workflows.attachments',
      'workflows.stop',
      'workflows.runs',
      'telemetry.s3',
      'telemetry.sessions',
      'telemetry.ingestLog',
      'telemetry.readings',
      'done',
    ]);
  });
  it('always ends in done, even with nothing to do', () => {
    expect(purgeSteps([])).toEqual(['done']);
  });
});

describe('normaliseScopes', () => {
  it('accepts the known scopes and drops duplicates, keeping order', () => {
    expect(normaliseScopes(['media', 'workflows', 'media'])).toEqual(['media', 'workflows']);
  });
  it('refuses an empty list, a non-array and an unknown value', () => {
    expect(normaliseScopes([])).toHaveProperty('error');
    expect(normaliseScopes('media')).toHaveProperty('error');
    expect(normaliseScopes(undefined)).toHaveProperty('error');
    expect(normaliseScopes(['media', 'identity'])).toHaveProperty('error');
  });
});

describe('readings windows', () => {
  it('floors to the UTC day', () => {
    expect(dayFloor(new Date('2026-09-01T23:59:59.999Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
  it('clips the last window to the cutoff and stops at it', () => {
    const cutoff = new Date('2026-09-03T05:00:00.000Z');
    expect(nextReadingsWindow({ windowStart: '2026-09-02T00:00:00.000Z', spanMs: READINGS_DAY_MS }, cutoff)).toEqual({
      start: new Date('2026-09-02T00:00:00.000Z'),
      end: new Date('2026-09-03T00:00:00.000Z'),
    });
    expect(nextReadingsWindow({ windowStart: '2026-09-03T00:00:00.000Z', spanMs: READINGS_DAY_MS }, cutoff)).toEqual({
      start: new Date('2026-09-03T00:00:00.000Z'),
      end: cutoff,
    });
    expect(nextReadingsWindow({ windowStart: '2026-09-03T05:00:00.000Z', spanMs: READINGS_DAY_MS }, cutoff)).toBeNull();
  });
  it('halves down to the one-hour floor, then gives up', () => {
    expect(halveWindow(READINGS_DAY_MS)).toBe(READINGS_DAY_MS / 2);
    expect(halveWindow(READINGS_MIN_SPAN_MS * 2)).toBe(READINGS_MIN_SPAN_MS);
    expect(halveWindow(READINGS_MIN_SPAN_MS)).toBeNull();
  });
  it('widens back up to a day and no further', () => {
    expect(widenWindow(READINGS_MIN_SPAN_MS)).toBe(READINGS_MIN_SPAN_MS * 2);
    expect(widenWindow(READINGS_DAY_MS)).toBe(READINGS_DAY_MS);
  });
  it('recognises the Data API timeout by name only', () => {
    expect(isStatementTimeout({ name: 'StatementTimeoutException' })).toBe(true);
    expect(isStatementTimeout(new Error('StatementTimeoutException'))).toBe(false);
    expect(isStatementTimeout(null)).toBe(false);
  });
});

describe('runArtifactPrefixes', () => {
  const RUN = '11111111-2222-4333-8444-555555555555';
  it('always names the v2 run prefix', () => {
    expect(runArtifactPrefixes(RUN, null)).toEqual([`workflows/v2/runs/${RUN}/`]);
  });
  it('adds the directory of a legacy v1 key that names the run, and nothing else', () => {
    const artifacts = {
      eventsKey: `workflows/v1/runs/${RUN}/events.jsonl`,
      outputs: { n1: { recordsKey: `workflows/v1/runs/${RUN}/outputs/n1/records.jsonl` } },
      videos: [`datasets/abc/frames/${RUN}.mp4`, 'workflows/v1/shared/other-run/clip.mp4'],
    };
    expect(runArtifactPrefixes(RUN, artifacts)).toEqual([
      `workflows/v2/runs/${RUN}/`,
      `workflows/v1/runs/${RUN}/`,
      `workflows/v1/runs/${RUN}/outputs/n1/`,
    ]);
  });
});

describe('isStalled', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');
  it('is false for finished rows and for a live lease', () => {
    expect(isStalled({ status: 'succeeded', leaseUntil: null }, now)).toBe(false);
    expect(isStalled({ status: 'running', leaseUntil: new Date(now.getTime() + 60_000) }, now)).toBe(false);
    expect(isStalled({ status: 'running', leaseUntil: new Date(now.getTime() - 60_000) }, now)).toBe(false);
  });
  it('is true once the lease has been dead longer than the grace period', () => {
    expect(isStalled({ status: 'running', leaseUntil: new Date(now.getTime() - STALL_GRACE_MS - 1) }, now)).toBe(true);
  });
  it('treats a running row that never held a lease as stalled, but a queued one as merely waiting', () => {
    expect(isStalled({ status: 'running', leaseUntil: null }, now)).toBe(true);
    expect(isStalled({ status: 'queued', leaseUntil: null }, now)).toBe(false);
  });
});

describe('initialCounts', () => {
  it('has every key at zero so the UI can render before the first chunk', () => {
    expect(Object.values(initialCounts()).every((v) => v === 0)).toBe(true);
    expect(Object.keys(initialCounts())).toHaveLength(9);
  });
});
