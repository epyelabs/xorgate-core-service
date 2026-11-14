import { describe, expect, it } from 'vitest';
import {
  isAgentKind,
  parseRustRegistrationFlag,
  rustRegistrationEnabled,
  storedAgent,
} from '../src/services/device-agent';

/**
 * F4 (Phase 8 fix-check, binding): ONE fail-closed parser for
 * RUST_AGENT_REGISTRATION. Unset, empty, unknown, malformed, or `allow:` with an
 * empty list are all OFF; a request with no workspace is enabled only by `on`.
 */

const A = '0199a1b2-0000-7000-8000-00000000000a';
const B = '0199a1b2-0000-7000-8000-00000000000b';

describe('parseRustRegistrationFlag (fails closed)', () => {
  it.each([
    [undefined],
    [''],
    ['   '],
    ['off'],
    ['OFF'],
    ['On'],
    ['ON'],
    ['true'],
    ['1'],
    ['yes'],
    ['enabled'],
    ['on,allow:x'],
    ['allow'],
    ['allow:'],
    ['allow: '],
    ['allow:,'],
    [`allow:${A},`],
    [`allow:${A},not-a-uuid`],
    ['allow:*'],
    [`deny:${A}`],
  ])('%j → off', (raw) => {
    expect(parseRustRegistrationFlag(raw)).toEqual({ mode: 'off' });
  });

  it('on → on (surrounding whitespace tolerated)', () => {
    expect(parseRustRegistrationFlag('on')).toEqual({ mode: 'on' });
    expect(parseRustRegistrationFlag(' on\n')).toEqual({ mode: 'on' });
  });

  it('allow:<uuid>,<uuid> → that allow-list', () => {
    const f = parseRustRegistrationFlag(`allow:${A}, ${B.toUpperCase()}`);
    expect(f.mode).toBe('allow');
    expect(f.mode === 'allow' && [...f.workspaceIds].sort()).toEqual([A, B].sort());
  });
});

describe('rustRegistrationEnabled', () => {
  const on = parseRustRegistrationFlag('on');
  const off = parseRustRegistrationFlag('off');
  const allowA = parseRustRegistrationFlag(`allow:${A}`);

  it('on enables every workspace, and the no-workspace case', () => {
    expect(rustRegistrationEnabled(on, A)).toBe(true);
    expect(rustRegistrationEnabled(on, undefined)).toBe(true);
    expect(rustRegistrationEnabled(on, null)).toBe(true);
  });

  it('off enables nothing', () => {
    expect(rustRegistrationEnabled(off, A)).toBe(false);
    expect(rustRegistrationEnabled(off, undefined)).toBe(false);
  });

  it('allow matches only a listed workspace, and NEVER a request with no workspace', () => {
    expect(rustRegistrationEnabled(allowA, A)).toBe(true);
    expect(rustRegistrationEnabled(allowA, A.toUpperCase())).toBe(true);
    expect(rustRegistrationEnabled(allowA, B)).toBe(false);
    expect(rustRegistrationEnabled(allowA, undefined)).toBe(false);
    expect(rustRegistrationEnabled(allowA, null)).toBe(false);
    expect(rustRegistrationEnabled(allowA, '')).toBe(false);
  });
});

describe('agent kinds', () => {
  it('only js and rust are agents', () => {
    expect(isAgentKind('js')).toBe(true);
    expect(isAgentKind('rust')).toBe(true);
    for (const v of ['JS', 'Rust', '', null, undefined, 0, 'node']) expect(isAgentKind(v)).toBe(false);
  });

  it('a stored value that is not exactly rust reads as js', () => {
    expect(storedAgent('rust')).toBe('rust');
    for (const v of ['js', null, undefined, '', 'RUST']) expect(storedAgent(v)).toBe('js');
  });
});
