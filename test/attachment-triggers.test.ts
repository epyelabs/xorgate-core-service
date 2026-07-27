import { describe, expect, it } from 'vitest';
import {
  attachmentTriggerSchema,
  manualRunContextSchema,
  scheduleRunSelectionSchema,
} from '../src/schemas/workflows';

// The media trigger pair (destroy-kvs-recorder Phase W, decision L): both take
// video from on-device sessions, and both are stream-keyed.
//  - session_completed fires once per session close (batch);
//  - segment_uploaded fires per ~60 s chunk as it lands (near-realtime).
// The cloud recorder's `recording_saved` type was removed outright — decision K
// (all workflow rows disposable, so redesign rather than retrofit).
describe('attachmentTriggerSchema: media triggers', () => {
  it('accepts a session_completed trigger with stream keys', () => {
    const parsed = attachmentTriggerSchema.safeParse({
      type: 'session_completed',
      streamKeys: ['cam0'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a segment_uploaded trigger with stream keys', () => {
    const parsed = attachmentTriggerSchema.safeParse({
      type: 'segment_uploaded',
      streamKeys: ['cam0', 'cam1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty streamKeys list on either media trigger', () => {
    for (const type of ['session_completed', 'segment_uploaded'] as const) {
      expect(attachmentTriggerSchema.safeParse({ type, streamKeys: [] }).success).toBe(false);
    }
  });

  it('no longer accepts the cloud recorder trigger', () => {
    expect(
      attachmentTriggerSchema.safeParse({ type: 'recording_saved', streamKeys: ['cam0'] })
        .success,
    ).toBe(false);
  });

  it('still accepts the non-media member types', () => {
    expect(
      attachmentTriggerSchema.safeParse({
        type: 'telemetry_condition',
        combinator: 'and',
        conditions: [{ metric: 'gps.speed', operator: 'gt', value: 100 }],
      }).success,
    ).toBe(true);
    expect(
      attachmentTriggerSchema.safeParse({
        type: 'schedule',
        cron: '0 * * * *',
        telemetryContext: { mode: 'sinceLastRun' },
        mediaContext: { mode: 'lastN', n: 3 },
      }).success,
    ).toBe(true);
  });
});

describe('scheduleRunSelectionSchema: session-shaped media selection', () => {
  it('accepts hand-picked sessions and lastNSessions', () => {
    expect(
      scheduleRunSelectionSchema.safeParse({ mode: 'sessions', sessionIds: ['s1'] }).success,
    ).toBe(true);
    expect(scheduleRunSelectionSchema.safeParse({ mode: 'lastNSessions', n: 3 }).success).toBe(
      true,
    );
  });

  it('rejects the retired recordings/lastN modes', () => {
    expect(
      scheduleRunSelectionSchema.safeParse({ mode: 'recordings', recordingIds: ['r1'] }).success,
    ).toBe(false);
    expect(scheduleRunSelectionSchema.safeParse({ mode: 'lastN', n: 3 }).success).toBe(false);
  });
});

describe('manualRunContextSchema: "Run now" over a session', () => {
  it('accepts a session_completed manual run', () => {
    expect(
      manualRunContextSchema.safeParse({
        triggerType: 'session_completed',
        sessionId: 'ab8f0e7a-0000-7000-8000-000000000001',
      }).success,
    ).toBe(true);
  });

  it('accepts a segment_uploaded manual run with and without an explicit seq', () => {
    expect(
      manualRunContextSchema.safeParse({
        triggerType: 'segment_uploaded',
        sessionId: 'ab8f0e7a-0000-7000-8000-000000000001',
        seq: 4,
      }).success,
    ).toBe(true);
    // seq omitted = the session's newest segment.
    expect(
      manualRunContextSchema.safeParse({
        triggerType: 'segment_uploaded',
        sessionId: 'ab8f0e7a-0000-7000-8000-000000000001',
      }).success,
    ).toBe(true);
  });

  it('no longer accepts a recording_saved manual run', () => {
    expect(
      manualRunContextSchema.safeParse({ triggerType: 'recording_saved', recordingId: 'r1' })
        .success,
    ).toBe(false);
  });
});
