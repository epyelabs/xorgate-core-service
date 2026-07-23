import { describe, expect, it } from 'vitest';
import { attachmentTriggerSchema } from '../src/schemas/workflows';

// Phase 6.4: session_completed joins the trigger union (fired by the sweeper /
// close-on-read when a device-recorded media session flips open→closed).
describe('attachmentTriggerSchema: session_completed', () => {
  it('accepts a session_completed trigger with stream keys', () => {
    const parsed = attachmentTriggerSchema.safeParse({
      type: 'session_completed',
      streamKeys: ['cam0'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty streamKeys list', () => {
    expect(
      attachmentTriggerSchema.safeParse({ type: 'session_completed', streamKeys: [] })
        .success,
    ).toBe(false);
  });

  it('still accepts the pre-existing member types', () => {
    expect(
      attachmentTriggerSchema.safeParse({ type: 'recording_saved', streamKeys: ['cam0'] })
        .success,
    ).toBe(true);
    expect(
      attachmentTriggerSchema.safeParse({
        type: 'telemetry_condition',
        combinator: 'and',
        conditions: [{ metric: 'gps.speed', operator: 'gt', value: 100 }],
      }).success,
    ).toBe(true);
  });
});
