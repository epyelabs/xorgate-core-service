/**
 * Which device agent a registration installs and a device runs, and whether
 * this stage lets anyone register the Rust one (device-agent-js-to-rust plan,
 * Phase 8 "dual-agent registration", D2/D5).
 *
 * One module on purpose: the registrations, install-script and device-dist
 * Lambdas all gate Rust on the same flag, and three hand-rolled parsers would be
 * three chances to fail OPEN.
 */

export const AGENT_KINDS = ['js', 'rust'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(v: unknown): v is AgentKind {
  return v === 'js' || v === 'rust';
}

/**
 * A stored value read back as an agent. The column is NOT NULL DEFAULT 'js'
 * (manual/041), so this only matters for a row from before the migration or a
 * hand-edited value: anything that is not exactly 'rust' is the JS agent, which
 * is what every pre-Phase-8 device and registration is.
 */
export function storedAgent(v: unknown): AgentKind {
  return v === 'rust' ? 'rust' : 'js';
}

/** The env var the CDK sets on all three Lambdas, per stage. */
export const RUST_AGENT_REGISTRATION_ENV = 'RUST_AGENT_REGISTRATION';

export type RustRegistrationFlag =
  | { mode: 'on' }
  | { mode: 'off' }
  | { mode: 'allow'; workspaceIds: ReadonlySet<string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse `RUST_AGENT_REGISTRATION`. FAIL-CLOSED: the only values that enable
 * anything are exactly `on`, or `allow:` followed by a non-empty, comma-separated
 * list of workspace UUIDs. Everything else is OFF:
 *
 * - unset or empty (a Lambda the CDK forgot) → off, never on;
 * - an unknown word (`yes`, `ON`, `true`, a typo) → off;
 * - `allow:` with no ids, or with any entry that is not a UUID → off (a
 *   half-valid list is a misconfiguration, not a smaller allow-list).
 */
export function parseRustRegistrationFlag(raw: string | undefined): RustRegistrationFlag {
  const v = (raw ?? '').trim();
  if (v === 'on') return { mode: 'on' };
  if (v.startsWith('allow:')) {
    const entries = v
      .slice('allow:'.length)
      .split(',')
      .map((s) => s.trim().toLowerCase());
    if (entries.length === 0 || entries.some((e) => !UUID.test(e))) return { mode: 'off' };
    return { mode: 'allow', workspaceIds: new Set(entries) };
  }
  return { mode: 'off' };
}

/** The flag as this Lambda sees it. Read per call: it is a cheap env lookup. */
export function rustRegistrationFlag(): RustRegistrationFlag {
  return parseRustRegistrationFlag(process.env[RUST_AGENT_REGISTRATION_ENV]);
}

/**
 * May `workspaceId` register (or render) the Rust agent on this stage?
 *
 * With no workspace (the General tab's org-wide `device-dist` call sends no
 * `X-Workspace-Id`) only `on` says yes: an allow-list never matches a request
 * that names no workspace.
 */
export function rustRegistrationEnabled(
  flag: RustRegistrationFlag,
  workspaceId: string | null | undefined,
): boolean {
  if (flag.mode === 'on') return true;
  if (flag.mode === 'off') return false;
  if (!workspaceId) return false;
  return flag.workspaceIds.has(workspaceId.trim().toLowerCase());
}
