import { describe, expect, it } from 'vitest';
import { parseLteRecoveryConfigBody } from '../src/schemas/lte-recovery-config';

describe('parseLteRecoveryConfigBody', () => {
  it('accepts null (clears the column)', () => {
    expect(parseLteRecoveryConfigBody(null)).toEqual({ value: null });
  });

  it('accepts the full policy shape', () => {
    const full = {
      gpsFixResetPolicy: 'veto-deadzone',
      deadZoneProfile: 'conservative',
    };
    expect(parseLteRecoveryConfigBody(full)).toEqual({ value: full });
  });

  it('accepts a partial config (device defaults fill the rest)', () => {
    expect(parseLteRecoveryConfigBody({ deadZoneProfile: 'aggressive' })).toEqual({
      value: { deadZoneProfile: 'aggressive' },
    });
    expect(parseLteRecoveryConfigBody({})).toEqual({ value: {} });
  });

  it('rejects unknown values (operator typos must surface, not save)', () => {
    const r = parseLteRecoveryConfigBody({ gpsFixResetPolicy: 'sometimes' });
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('lteRecoveryConfig.gpsFixResetPolicy');
  });

  it('rejects unknown keys', () => {
    const r = parseLteRecoveryConfigBody({ deadzoneProfile: 'balanced' });
    expect(r).toHaveProperty('error');
  });

  it('rejects non-object bodies', () => {
    expect(parseLteRecoveryConfigBody('defer')).toHaveProperty('error');
    expect(parseLteRecoveryConfigBody(1)).toHaveProperty('error');
  });
});
