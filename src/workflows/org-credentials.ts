import { z } from 'zod';
import { buildGoogleRoadsUrl, buildHereRequest, buildOverpassRequest } from '@xorgate/workflow-engine';

/**
 * Pure half of the per-organization connector credentials (M7): secret naming,
 * the org-settings API request schemas, and the provider validation probes.
 * One Secrets Manager secret per org per provider —
 * xorgate/orgs/<orgId>/<provider> — rather than an encrypted column (no
 * KMS/crypto handling in app code). The handler
 * (src/handlers/organization-credentials.ts) owns auth and the Secrets Manager
 * calls; the engine resolution order (org key -> platform key -> clear
 * failure) lives in the secrets seam (engine/target.ts).
 *
 * `anthropic` is deliberately one more name in the pattern, NOT a
 * connector.third_party provider: it is the model.vlm backend and joins only
 * through this shared credentials mechanism (the M5 rider).
 *
 * Secret names carry no stage segment (the plan's exact pattern): org ids are
 * stage-local UUIDs, so dev and prod names cannot collide even in one account.
 */

export const CREDENTIAL_PROVIDERS = ['google_roads', 'here', 'anthropic'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

/** Providers the validate endpoint accepts; OSM has no key, so at most a reachability check. */
export const VALIDATABLE_PROVIDERS = [...CREDENTIAL_PROVIDERS, 'osm'] as const;
export type ValidatableProvider = (typeof VALIDATABLE_PROVIDERS)[number];

export const ORG_SECRET_PREFIX = 'xorgate/orgs/';

export function orgSecretName(orgId: string, provider: CredentialProvider): string {
  return `${ORG_SECRET_PREFIX}${orgId}/${provider}`;
}

/** Engine logical secret name -> the org-credential provider that can override it. */
export const PROVIDER_BY_LOGICAL_SECRET: Record<string, CredentialProvider> = {
  'google-roads-api-key': 'google_roads',
  'here-api-key': 'here',
  'anthropic-api-key': 'anthropic',
};

/** Platform-secret env var per provider (the M3/M5 secrets-seam mapping, reused by the probes). */
export const PLATFORM_SECRET_ENV: Record<CredentialProvider, string> = {
  google_roads: 'GOOGLE_ROADS_SECRET_NAME',
  here: 'HERE_SECRET_NAME',
  anthropic: 'ANTHROPIC_SECRET_NAME',
};

/**
 * True when a Secrets Manager error means "this secret is effectively absent":
 * it does not exist, OR it was force-deleted moments ago and still lingers in
 * "scheduled for deletion" (GetSecretValue then throws InvalidRequestException,
 * NOT ResourceNotFoundException — found by the M7 E2E). Every read path (the
 * org-settings handler and the engine secrets seam) must treat both as unset,
 * or a just-cleared org key blocks the platform fallback instead of enabling it.
 */
export function isSecretGoneError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  if (e.name === 'ResourceNotFoundException') return true;
  return e.name === 'InvalidRequestException' && /deletion/i.test(e.message ?? '');
}

export function isCredentialProvider(v: string | undefined): v is CredentialProvider {
  return CREDENTIAL_PROVIDERS.includes(v as CredentialProvider);
}
export function isValidatableProvider(v: string | undefined): v is ValidatableProvider {
  return VALIDATABLE_PROVIDERS.includes(v as ValidatableProvider);
}

// --- API request schemas (wire contract recorded in STATUS) -----------------------

export const setCredentialSchema = z.object({
  apiKey: z.string().trim().min(8, 'API key looks too short').max(512),
});

export const validateCredentialSchema = z.object({
  // Candidate key to probe BEFORE saving; omitted = probe the stored org key,
  // else the platform key (useful to check the platform default).
  apiKey: z.string().trim().min(1).max(512).optional(),
});

export interface ProbeResult {
  ok: boolean;
  message: string;
}

// --- Validation probes -------------------------------------------------------------
// Each probe makes ONE minimal real call with the candidate key so a bad key —
// or Google's missing speed-limits entitlement — surfaces at save time, not on
// the first run. `http` is injectable so the smoke script runs them offline.

// A public-road point (Google's own Roads documentation sample, central Lisbon):
// the probes only need the provider to accept the request, not coverage.
const PROBE_LAT = 38.7581;
const PROBE_LNG = -9.0371;

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
// Cheapest 1-token probe: enough to authenticate the key, negligible cost.
export const ANTHROPIC_PROBE_MODEL = 'claude-haiku-4-5';

async function bodyMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // fall through to the raw body
  }
  return text.slice(0, 200) || 'no body';
}

export async function probeCredential(
  provider: ValidatableProvider,
  apiKey: string | null,
  http: typeof fetch,
): Promise<ProbeResult> {
  if (provider === 'osm') {
    // No key to validate; check the public Overpass instance answers at all.
    const { url, init } = buildOverpassRequest(PROBE_LAT, PROBE_LNG);
    const res = await http(url, init);
    return res.ok
      ? { ok: true, message: 'Overpass is reachable (no key required)' }
      : { ok: false, message: `Overpass unreachable (HTTP ${res.status}): ${await bodyMessage(res)}` };
  }

  if (!apiKey) return { ok: false, message: 'No API key to validate' };

  if (provider === 'google_roads') {
    // The speedLimits endpoint itself, so the asset-tracking-entitlement 403
    // surfaces here instead of on the first run.
    const res = await http(buildGoogleRoadsUrl(PROBE_LAT, PROBE_LNG, apiKey));
    return res.ok
      ? { ok: true, message: 'Google Roads speed limits reachable with this key' }
      : { ok: false, message: `Google Roads rejected the key (HTTP ${res.status}): ${await bodyMessage(res)}` };
  }

  if (provider === 'here') {
    // The exact route-match call the connector executor makes. 400 (no road
    // match) still proves the key: HERE auth failures are 401/403.
    const { url, init } = buildHereRequest(PROBE_LAT, PROBE_LNG, apiKey);
    const res = await http(url, init);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `HERE rejected the key (HTTP ${res.status}): ${await bodyMessage(res)}` };
    }
    if (res.ok || res.status === 400) {
      return { ok: true, message: 'HERE route matching accepted this key' };
    }
    return { ok: false, message: `HERE probe failed (HTTP ${res.status}): ${await bodyMessage(res)}` };
  }

  // anthropic: a minimal 1-token Messages call (plain fetch — the SDK is
  // external in every Lambda bundle and only ships on the media engine image).
  const res = await http(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  if (res.ok) return { ok: true, message: 'Claude API accepted this key' };
  return { ok: false, message: `Claude API rejected the key (HTTP ${res.status}): ${await bodyMessage(res)}` };
}
