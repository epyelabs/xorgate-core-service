import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The API answers every origin (`allowOrigins: ['*']`). That is a deliberate
 * Phase 5 decision, not an oversight, and the full reasoning sits above the
 * CORS block in `lib/stacks/api-stack.ts`. The short version: CORS protects
 * AMBIENT browser credentials, and this API has none. Auth is the
 * `Authorization` header alone, no cookie is ever read or written, and
 * `allowCredentials` is false.
 *
 * Both halves of that sentence are load-bearing, and both are the kind of thing
 * a future change makes false WITHOUT anyone noticing this file. A wildcard is
 * safe only as long as they hold:
 *
 *   - `allowCredentials: true` alongside a wildcard is the combination browsers
 *     reject and the one that would make "no ambient credentials" a lie.
 *   - Cookie-based auth anywhere would hand the browser an ambient credential
 *     that a hostile origin could then spend, which is precisely the attack
 *     CORS exists to stop and precisely what a wildcard would stop stopping.
 *
 * So this is a default-deny structural guard in the same family as
 * `workspace-scope-coverage.test.ts` and `openapi-route-coverage.test.ts`: read
 * the source, diff it against a rule, fail loudly. If you are here because this
 * test failed, the fix is probably NOT to edit this file. It is to reopen the
 * per-org origin allowlist that Phase 5 declined to build, because the reason
 * it was declined has just stopped being true.
 */

const API_STACK = join(__dirname, '../lib/stacks/api-stack.ts');
const SRC_DIR = join(__dirname, '../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Strip comments so a sentence ABOUT cookies does not read as cookie handling. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('CORS configuration', () => {
  const stack = readFileSync(API_STACK, 'utf8');

  it('serves a wildcard preflight, which is the decision Phase 5 recorded', () => {
    expect(stack).toMatch(/allowOrigins:\s*\["\*"\]/);
  });

  it('never sets allowCredentials: wildcard + credentials is the unsafe pair', () => {
    // Not "is not true": the property must be ABSENT. Writing it out at all,
    // even as `false`, is a sign someone is reaching for cookie auth.
    expect(stripComments(stack)).not.toMatch(/allowCredentials/);
  });

  it('keeps the reasoning next to the decision, so it cannot be cargo-culted', () => {
    // A bare `['*']` with no explanation is indistinguishable from a mistake,
    // and the next agent's correct instinct would be to "fix" it.
    const corsBlockStart = stack.indexOf('corsPreflight:');
    const preamble = stack.slice(Math.max(0, corsBlockStart - 3000), corsBlockStart);
    expect(preamble).toMatch(/allowCredentials/);
    expect(preamble).toMatch(/Phase 5|N3/);
  });

  it('reads no cookie anywhere in src/, which the wildcard depends on', () => {
    const offenders = walk(SRC_DIR)
      .filter((file) => {
        const code = stripComments(readFileSync(file, 'utf8'));
        return /\bcookie\b/i.test(code);
      })
      .map((file) => file.replace(SRC_DIR, 'src'));

    expect(offenders).toEqual([]);
  });

  it('authenticates from the Authorization header, not an ambient credential', () => {
    const auth = readFileSync(join(SRC_DIR, 'middleware/auth.ts'), 'utf8');
    expect(auth).toMatch(/headers\['authorization'\]/);
  });
});
