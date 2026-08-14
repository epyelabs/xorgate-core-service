import { beforeEach, describe, expect, it } from 'vitest';

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCOUNT_ID = '111910761410';

import {
  LIVE_CLIENT_ID_PREFIX,
  SESSION_POLICY_MAX_CHARS,
  buildEnumeratedSessionPolicy,
  buildSessionPolicy,
  resolveLiveTtlSeconds,
  scopedTelemetryTopic,
} from '../src/services/live-credentials';

const ORG = '1d2b4514-7408-4234-af5f-83b9451575ea';
const WS = 'c2e2a967-6dbe-464c-b45d-c6ef6087875b';
const SIBLING = 'a0e13547-9a10-49ca-9384-063a40295140';

interface Statement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string>>;
}

function statements(doc: string): Record<string, Statement> {
  const parsed = JSON.parse(doc) as { Statement: Statement[] };
  return Object.fromEntries(parsed.Statement.map((s) => [s.Sid, s]));
}

const resources = (s: Statement): string[] =>
  Array.isArray(s.Resource) ? s.Resource : [s.Resource];

/**
 * The session policy IS the boundary. A live subscribe that succeeds proves
 * only that the allow works; what has to be true for this phase to mean
 * anything is everything the document does NOT reach, and that can only be
 * asserted against the document itself.
 */
describe('live credentials: the session policy', () => {
  describe('workspace-scoped', () => {
    const doc = buildSessionPolicy({ organizationId: ORG, workspaceId: WS });
    const st = statements(doc);

    it('names its own workspace literally, and no wildcard stands in for it', () => {
      for (const r of resources(st.LiveTelemetry!)) {
        expect(r).toContain(`/orgs/${ORG}/ws/${WS}/`);
      }
    });

    it('cannot reach a sibling workspace', () => {
      expect(doc).not.toContain(SIBLING);
      // The one that would actually bite: a `ws/*` segment would authorize
      // every tenant in the organization while still passing a test that only
      // checked the sibling id is absent.
      expect(doc).not.toContain(`/orgs/${ORG}/ws/*/`);
    });

    it('cannot reach the unscoped device plane, which has no tenant in its topic', () => {
      for (const r of resources(st.LiveTelemetry!)) {
        expect(r).not.toMatch(/:(topic|topicfilter)\/xorgate\/devices\//);
      }
    });

    it('matches video on the WORKSPACE tag, never the organization tag', () => {
      const cond = st.LiveVideo!.Condition!.StringEquals!;
      expect(cond['aws:ResourceTag/xorgate:workspaceId']).toBe(WS);
      // Carrying the org tag as well would silently hand a workspace-scoped
      // credential every channel in the organization: an OR of two allows, not
      // an AND of two conditions.
      expect(cond['aws:ResourceTag/xorgate:organizationId']).toBeUndefined();
    });

    it('grants no publish and no video master role on either plane', () => {
      const actions = JSON.parse(doc).Statement.flatMap((s: Statement) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      ) as string[];
      expect(actions).not.toContain('iot:Publish');
      expect(actions).not.toContain('iot:RetainPublish');
      expect(actions.some((a) => a.includes('ConnectAsMaster'))).toBe(false);
      expect(actions.some((a) => /CreateSignalingChannel|DeleteSignalingChannel|UpdateSignalingChannel/.test(a))).toBe(false);
    });

    it('confines Connect to the vended client-id prefix', () => {
      // The prefix is what stops a vended credential from connecting as a
      // device id and knocking that device off the broker — the availability
      // defect Phase 1 closed for the first-party plane.
      expect(resources(st.LiveConnect!)).toEqual([
        `arn:aws:iot:us-east-1:111910761410:client/${LIVE_CLIENT_ID_PREFIX}*`,
      ]);
    });

    it('authorizes exactly the topic the bridge publishes to', () => {
      const published = scopedTelemetryTopic(
        { organizationId: ORG, workspaceId: WS },
        'a73f7a36-2a9c-45c4-a66c-54d3b018a7f7',
      );
      const authorized = resources(st.LiveTelemetry!)
        .find((r) => r.includes(':topic/'))!
        .split(':topic/')[1]!;
      // Same construction on both sides, so a rename cannot authorize a topic
      // nothing writes (or worse, keep authorizing the old one).
      const pattern = new RegExp('^' + authorized.replace(/\*/g, '[^/]+') + '$');
      expect(published).toMatch(pattern);
    });
  });

  describe('org-scoped', () => {
    const doc = buildSessionPolicy({ organizationId: ORG, workspaceId: null });
    const st = statements(doc);

    it('spans its own organization and stops there', () => {
      for (const r of resources(st.LiveTelemetry!)) {
        expect(r).toContain(`/orgs/${ORG}/ws/*/`);
      }
      expect(doc).not.toContain('/orgs/*/');
    });

    it('matches video on the ORGANIZATION tag', () => {
      const cond = st.LiveVideo!.Condition!.StringEquals!;
      expect(cond['aws:ResourceTag/xorgate:organizationId']).toBe(ORG);
      expect(cond['aws:ResourceTag/xorgate:workspaceId']).toBeUndefined();
    });
  });

  it('is the same size whatever the fleet size, which is the whole point', () => {
    const a = buildSessionPolicy({ organizationId: ORG, workspaceId: WS });
    const b = buildSessionPolicy({ organizationId: ORG, workspaceId: SIBLING });
    expect(a.length).toBe(b.length);
    expect(a.length).toBeLessThan(SESSION_POLICY_MAX_CHARS);
  });
});

/**
 * The mechanism evaluation, kept executable.
 *
 * The alternative to the bridge was to enumerate the device set into the
 * credential. It has no bridge, no added latency and no added message volume,
 * and it is disqualified by exactly one thing: an inline session policy is
 * capped at 2048 characters, so the credential stops being mintable at a
 * specific fleet size. These tests are where that size comes from, so the
 * number in the handoff can be re-derived rather than believed.
 */
describe('live credentials: the enumerated alternative and its ceiling', () => {
  const deviceId = (i: number) =>
    `${i.toString(16).padStart(8, '0')}-2a9c-45c4-a66c-54d3b018a7f7`;
  const channelArn = (i: number, cam: number) =>
    `arn:aws:kinesisvideo:us-east-1:111910761410:channel/${deviceId(i)}-cam${cam}/178205558411${cam}`;

  /** One device as the fleet actually is: two camera channels each. */
  const forN = (n: number) =>
    buildEnumeratedSessionPolicy(
      Array.from({ length: n }, (_, i) => deviceId(i)),
      Array.from({ length: n }, (_, i) => [channelArn(i, 0), channelArn(i, 1)]).flat(),
    );

  it('grows with the device set, unlike the pattern policy', () => {
    expect(forN(2).length).toBeGreaterThan(forN(1).length);
  });

  it('has a ceiling of THREE devices, which is what disqualified it', () => {
    let last = 0;
    for (let n = 1; n <= 40; n += 1) {
      if (forN(n).length > SESSION_POLICY_MAX_CHARS) break;
      last = n;
    }
    // The number that decided the phase. If a future change to the ARN shapes
    // moves it, this test says so rather than letting the handoff go stale.
    expect(last).toBe(3);
  });

  it('is still over the ceiling with video dropped entirely', () => {
    // Worth knowing, because "just do telemetry this way and enumerate only
    // video" is the obvious salvage attempt: it roughly doubles the ceiling and
    // still lands nowhere near a real fleet.
    const telemetryOnly = (n: number) =>
      buildEnumeratedSessionPolicy(Array.from({ length: n }, (_, i) => deviceId(i)), []);
    let last = 0;
    for (let n = 1; n <= 40; n += 1) {
      if (telemetryOnly(n).length > SESSION_POLICY_MAX_CHARS) break;
      last = n;
    }
    expect(last).toBe(7);
  });
});

describe('live credentials: ttl', () => {
  beforeEach(() => {
    process.env.AWS_REGION = 'us-east-1';
  });

  it('defaults to an hour', () => {
    expect(resolveLiveTtlSeconds(undefined)).toEqual({ ok: true, ttlSeconds: 3600 });
    expect(resolveLiveTtlSeconds(null)).toEqual({ ok: true, ttlSeconds: 3600 });
  });

  it('rejects rather than clamps, so a caller never believes it got a lifetime it did not', () => {
    expect(resolveLiveTtlSeconds(3601).ok).toBe(false);
    expect(resolveLiveTtlSeconds(299).ok).toBe(false);
    expect(resolveLiveTtlSeconds(0).ok).toBe(false);
    expect(resolveLiveTtlSeconds(-60).ok).toBe(false);
    expect(resolveLiveTtlSeconds(600.5).ok).toBe(false);
    expect(resolveLiveTtlSeconds('600' as unknown).ok).toBe(false);
  });

  it('accepts the documented range at both ends', () => {
    expect(resolveLiveTtlSeconds(300)).toEqual({ ok: true, ttlSeconds: 300 });
    expect(resolveLiveTtlSeconds(3600)).toEqual({ ok: true, ttlSeconds: 3600 });
  });
});
