import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of workspace enforcement.
 *
 * `test/auth-middleware.test.ts` proves the boundary holds for the handlers that
 * apply it. Nothing there can prove that a handler written NEXT MONTH applies it
 * at all, and that is the failure mode worth guarding: a new organization-wide
 * route that resolves an org context and reads org-wide rows leaks every tenant
 * to a workspace-scoped token, silently, with no test failing and no reviewer
 * necessarily noticing.
 *
 * So the rule is structural and default-deny: a handler that authenticates with
 * `requireOrgContext` MUST also state its stance on workspace scope, by one of
 *
 *   - `resolveWorkspaceScope(auth)` — it narrows its reads to the allowed
 *     workspaces (every device-scoped handler), or
 *   - `assertOrgWideScope(auth)` — it refuses workspace-scoped tokens on some or
 *     all of its methods (`workspaces.ts`, whose reads are scoped and whose
 *     writes are not).
 *
 * Handlers that use `requireOrgWideContext` have already said it in the gate
 * they chose, so they satisfy the rule by construction. Anything else needs an
 * entry in EXEMPT below, with a reason, which is the point: an exemption is a
 * decision someone made on purpose rather than a line nobody wrote.
 *
 * Same family as `openapi-route-coverage.test.ts`: read the source, diff it
 * against a rule, fail loudly.
 */

const HANDLER_DIR = join(__dirname, '../src/handlers');

/**
 * Handlers that resolve an org context and legitimately consult no workspace
 * scope. Keep this list short and each reason specific.
 */
const EXEMPT: Record<string, string> = {
  'auth-session-tokens.ts':
    'Mints tokens and reads no organization data. Only an API key can reach it ' +
    '(a session token is refused on the credential shape), so there is no ' +
    'workspace-scoped caller to narrow for.',
};

function handlerFiles(): string[] {
  return readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.ts'));
}

describe('workspace scope coverage', () => {
  const offenders: string[] = [];
  const scoped: string[] = [];
  const orgWide: string[] = [];

  for (const file of handlerFiles()) {
    const src = readFileSync(join(HANDLER_DIR, file), 'utf8');
    if (src.includes('requireOrgWideContext(')) {
      orgWide.push(file);
      continue;
    }
    if (!src.includes('requireOrgContext(')) continue;
    if (src.includes('resolveWorkspaceScope(') || src.includes('assertOrgWideScope(')) {
      scoped.push(file);
      continue;
    }
    if (file in EXEMPT) continue;
    offenders.push(file);
  }

  it('every org-scoped handler states its workspace stance', () => {
    expect(
      offenders,
      'These handlers call requireOrgContext without narrowing to resolveWorkspaceScope(auth), ' +
        'refusing with assertOrgWideScope(auth), or switching to requireOrgWideContext. A ' +
        'workspace-scoped session token would see organization-wide data through them. Pick one, ' +
        'or add an entry to EXEMPT in this file with a reason.',
    ).toEqual([]);
  });

  it('both stances are actually in use, so the rule is not vacuous', () => {
    // A refactor that removed one of the two helpers entirely would otherwise
    // leave this file passing while enforcing nothing.
    expect(scoped.length).toBeGreaterThan(5);
    expect(orgWide.length).toBeGreaterThan(3);
  });

  it('the exemption list names only files that exist and still need it', () => {
    const files = new Set(handlerFiles());
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(files.has(file), `EXEMPT names a handler that no longer exists: ${file}`).toBe(true);
      expect(reason.length, `EXEMPT entry ${file} needs a real reason`).toBeGreaterThan(40);
      const src = readFileSync(join(HANDLER_DIR, file), 'utf8');
      expect(
        src.includes('requireOrgContext(') &&
          !src.includes('resolveWorkspaceScope(') &&
          !src.includes('assertOrgWideScope('),
        `EXEMPT entry ${file} is stale: it no longer needs an exemption`,
      ).toBe(true);
    }
  });
});
