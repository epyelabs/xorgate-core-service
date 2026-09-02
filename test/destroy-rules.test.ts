import { describe, expect, it } from 'vitest';
import { deviceStoragePrefixes, soleOwnerOrganizationIds } from '../src/services/destroy-rules';

describe('deviceStoragePrefixes', () => {
  it('names exactly the two prefixes the device agent uploads under', () => {
    // These must agree with services/media-segments.ts and services/telemetry-batch.ts;
    // a drift here would silently leave a deleted device's objects behind.
    expect(deviceStoragePrefixes('d1')).toEqual(['media-sessions/v1/d1/', 'telemetry/v1/d1/']);
  });
});

describe('soleOwnerOrganizationIds', () => {
  it('blocks on an organization where the caller is the only owner', () => {
    const own = [{ organizationId: 'a', role: 'owner' }];
    const owners = [{ organizationId: 'a' }];
    expect(soleOwnerOrganizationIds(own, owners)).toEqual(['a']);
  });

  it('does not block when another owner remains', () => {
    const own = [{ organizationId: 'a', role: 'owner' }];
    const owners = [{ organizationId: 'a' }, { organizationId: 'a' }];
    expect(soleOwnerOrganizationIds(own, owners)).toEqual([]);
  });

  it('ignores non-owner memberships entirely', () => {
    const own = [
      { organizationId: 'a', role: 'admin' },
      { organizationId: 'b', role: 'member' },
    ];
    expect(soleOwnerOrganizationIds(own, [])).toEqual([]);
  });

  it('reports every blocking organization, not just the first', () => {
    const own = [
      { organizationId: 'a', role: 'owner' },
      { organizationId: 'b', role: 'owner' },
      { organizationId: 'c', role: 'owner' },
    ];
    const owners = [{ organizationId: 'a' }, { organizationId: 'b' }, { organizationId: 'b' }, { organizationId: 'c' }];
    expect(soleOwnerOrganizationIds(own, owners)).toEqual(['a', 'c']);
  });
});
