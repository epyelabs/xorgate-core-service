import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F4 (Phase 8 fix-check, binding): all THREE Lambdas that gate the Rust agent
 * carry RUST_AGENT_REGISTRATION, `on` in both stages since U9 (2026-11-19).
 *
 * The registrations, install-script and device-dist Lambdas are separate
 * functions. One forgotten variable fails closed (the parser reads unset as
 * off), but it would still be a silent split-brain: say a registration that
 * mints but whose script refuses. Like api-stack-budget and
 * openapi-route-coverage, this reads the stack source instead of synthesizing
 * the whole app. The DEV deploy evidence (wp-b.md) checks the synthesized
 * template too.
 */

const source = readFileSync(join(__dirname, '..', 'lib', 'stacks', 'api-stack.ts'), 'utf8');

describe('RUST_AGENT_REGISTRATION in the API stack', () => {
  it('is on in dev and on in prod', () => {
    const map = source.match(
      /const RUST_AGENT_REGISTRATION: Record<"dev" \| "prod", string> = \{\s*dev: "([^"]*)",\s*prod: "([^"]*)",\s*\};/,
    );
    expect(map, 'the per-stage RUST_AGENT_REGISTRATION map is missing or reshaped').not.toBeNull();
    expect(map![1]).toBe('on');
    expect(map![2]).toBe('on');
  });

  it('is set on exactly the three gating Lambdas, from the map', () => {
    const loop = source.match(
      /for \(const fn of \[([^\]]*)\]\) \{\s*fn\.addEnvironment\("RUST_AGENT_REGISTRATION", RUST_AGENT_REGISTRATION\[isProd \? "prod" : "dev"\]\);\s*\}/,
    );
    expect(loop, 'the RUST_AGENT_REGISTRATION loop is missing or reshaped').not.toBeNull();
    const fns = loop![1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    expect(fns).toEqual(['deviceDistFn', 'deviceRegistrationsFn', 'installScriptFn']);
  });

  it('is never set anywhere else (one source of truth)', () => {
    const sets = [...source.matchAll(/"RUST_AGENT_REGISTRATION"/g)].length;
    expect(sets).toBe(1);
  });

  it('the three Lambdas are the ones running the gating handlers', () => {
    expect(source).toMatch(/DeviceRegistrationsFn[\s\S]{0,200}"device-registrations\.ts"/);
    expect(source).toMatch(/InstallScriptFn[\s\S]{0,200}"install-script\.ts"/);
    expect(source).toMatch(/DeviceDistFn[\s\S]{0,200}"device-dist\.ts"/);
  });

  it('device-dist may read the Rust manifest', () => {
    expect(source).toContain('distBucket.grantRead(deviceDistFn, "latest-rs.json");');
  });
});
