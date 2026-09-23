import { describe, expect, it } from 'vitest';
import { telemetrySessionTriggerContext } from '../src/services/workflow-triggers';
import { resolveTriggeredWindow, triggeredVideoSelection } from '../src/workflows/production';

/**
 * telemetry-session-artifacts P6 item 9: the `telemetry_session_completed`
 * trigger context is the session's identity and bounds, its whole insights
 * block, and an explicit `window` the dispatcher reads so a `source.telemetry`
 * node covers exactly the recorded span. It must never resolve to a media
 * session (the ids live in different tables).
 */
const session = {
  id: '01a0cee6-0ca3-750b-bb29-9a8c41363905',
  deviceId: '58b51737-196e-4c29-a6f6-36f6793a5126',
  startedAt: new Date('2026-09-23T15:32:59.150Z'),
  endedAt: new Date('2026-09-23T15:35:59.216Z'),
  rateHz: 1,
  timeSource: 'ntp',
  segmentCount: 3,
  sampleCount: 181,
  insights: { computed: { distance: 1 }, distance: { meters: 57, unit: 'm' } },
};

describe('telemetrySessionTriggerContext', () => {
  it('carries id, device, bounds, rate, clock, counts, insights and the window', () => {
    const ctx = telemetrySessionTriggerContext(session);
    expect(ctx).toEqual({
      type: 'telemetry_session_completed',
      sessionId: session.id,
      deviceId: session.deviceId,
      from: '2026-09-23T15:32:59.150Z',
      to: '2026-09-23T15:35:59.216Z',
      rateHz: 1,
      timeSource: 'ntp',
      segmentCount: 3,
      sampleCount: 181,
      insights: session.insights,
      window: { from: '2026-09-23T15:32:59.150Z', to: '2026-09-23T15:35:59.216Z' },
    });
  });

  it('is honest about an unbuilt session: insights null, to = from when ended_at is null', () => {
    const ctx = telemetrySessionTriggerContext({ ...session, endedAt: null, insights: null });
    expect(ctx.insights).toBeNull();
    expect(ctx.to).toBe(ctx.from);
  });

  it('resolves to NO video and to the session window in the dispatcher', () => {
    const ctx = telemetrySessionTriggerContext(session);
    expect(triggeredVideoSelection(ctx)).toBeNull();
    expect(resolveTriggeredWindow(ctx, new Date(), null)).toEqual({
      from: '2026-09-23T15:32:59.150Z',
      to: '2026-09-23T15:35:59.216Z',
    });
  });
});
