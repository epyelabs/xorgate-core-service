import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The API stack sits under CloudFormation's hard 500-resource cap, and on
 * 2026-10-01 it reached 497. Most of that was one `AWS::Lambda::Permission` per
 * route, created by `HttpLambdaIntegration`'s default `scopePermissionToRoute`.
 * The stack now builds every integration through a local `lambdaInt` helper
 * that turns that off (one permission per function), and counts its own
 * resources at synth.
 *
 * Like openapi-route-coverage, this reads the stack's source rather than
 * synthesizing it: the synth-time count lives in the stack itself, and this
 * file keeps the helper the only way in, so a copy-pasted
 * `new HttpLambdaIntegration(...)` cannot quietly bring back a permission per
 * route.
 */

const API_STACK = join(__dirname, '..', 'lib', 'stacks', 'api-stack.ts');

describe('API stack resource budget', () => {
  const source = readFileSync(API_STACK, 'utf8');

  it('constructs HttpLambdaIntegration only inside the lambdaInt helper', () => {
    const direct = [...source.matchAll(/new apigwv2int\.HttpLambdaIntegration\(/g)].length;
    expect(direct, 'build route integrations with lambdaInt(id, fn)').toBe(1);
  });

  it('keeps one permission per function, not per route', () => {
    expect(source).toMatch(
      /new apigwv2int\.HttpLambdaIntegration\(id, fn, \{ scopePermissionToRoute: false \}\)/,
    );
  });

  it('routes every integration through the helper', () => {
    // Floor, so a reshaped declaration fails here instead of matching nothing.
    const uses = [...source.matchAll(/=\s*lambdaInt\(/g)].length;
    expect(uses).toBeGreaterThanOrEqual(30);
  });
});
