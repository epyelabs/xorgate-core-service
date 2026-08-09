import { describe, expect, it } from 'vitest';
import { validateNamespaceValue } from '../src/config-registry/index';

const parseCellular = (v: unknown) => validateNamespaceValue('cellular', v);

/**
 * The `cellular` namespace (manage_sim_card_info plan, Phase 2). The value is
 * interpolated into an AT command string on the device, so the injection cases
 * here are load-bearing, not defensive decoration — one accepted quote or CR
 * would let a cloud write terminate the AT command and issue a second one.
 */
describe('cellular config validation', () => {
  it('accepts null (revert the namespace)', () => {
    expect(parseCellular(null)).toEqual({ value: null });
  });

  it('accepts a plain hostname-ish APN', () => {
    expect(parseCellular({ apn: 'sp.mb.com' })).toEqual({ value: { apn: 'sp.mb.com' } });
    expect(parseCellular({ apn: 'internet' })).toEqual({ value: { apn: 'internet' } });
    expect(parseCellular({ apn: 'm2m-east.telus.iot' })).toEqual({
      value: { apn: 'm2m-east.telus.iot' },
    });
  });

  it('accepts the explicit empty APN ("leave the modem alone")', () => {
    expect(parseCellular({ apn: '' })).toEqual({ value: { apn: '' } });
  });

  it('rejects the empty object ({} is never an erase — null is)', () => {
    expect(parseCellular({})).toHaveProperty('error');
  });

  it('rejects AT-command injection attempts outright', () => {
    for (const evil of [
      'a";+CFUN=0',
      'a"\r\nAT+CFUN=0',
      'apn"',
      "apn'",
      'apn\r',
      'apn\n',
      'apn with spaces',
      'apn;reset',
      'apn,extra',
      'apn\\x',
    ]) {
      expect(parseCellular({ apn: evil }), JSON.stringify(evil)).toHaveProperty('error');
    }
  });

  it('rejects an APN over the 3GPP 100-char limit', () => {
    expect(parseCellular({ apn: 'a'.repeat(101) })).toHaveProperty('error');
    expect(parseCellular({ apn: 'a'.repeat(100) })).toEqual({
      value: { apn: 'a'.repeat(100) },
    });
  });

  it('rejects unknown keys (username/password are a later addition, not a silent drop)', () => {
    expect(parseCellular({ apn: 'x', username: 'u' })).toHaveProperty('error');
  });

  it('rejects non-object and non-string bodies', () => {
    expect(parseCellular('sp.mb.com')).toHaveProperty('error');
    expect(parseCellular({ apn: 5 })).toHaveProperty('error');
    expect(parseCellular({ apn: null })).toHaveProperty('error');
  });
});
