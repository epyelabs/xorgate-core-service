#!/usr/bin/env node
/**
 * M6 batch template upgrade: re-publish every template whose PUBLISHED
 * definition is still stored as schemaVersion 1, using the versioning system
 * as the migration vehicle (a new draft seeded with the read-path-upgraded v2
 * definition, then published). Per-template rollback = restore the previous
 * (archived) version from the UI.
 *
 * Runs against the deployed API with a user id token (the deploy creds cannot
 * reach the DB; the API can). Safe by construction:
 *   - templates already published as v2 are skipped;
 *   - templates with an OPEN DRAFT that differs from the published definition
 *     are skipped and reported (our PUT /draft would clobber the user's work);
 *   - a publish-validation failure (e.g. a PoC graph whose upgraded edges are
 *     channel-invalid) is reported and the template is left as-is — its
 *     triggered runs will fail at dispatch with a clear error until someone
 *     fixes and re-publishes it in the editor;
 *   - attachments pinned to v1 versions are reported (pins are user choices;
 *     the dispatcher upgrades their snapshots at fire time).
 *
 * Usage:
 *   XORGATE_API_BASE=https://... XORGATE_ID_TOKEN=... XORGATE_ORG_ID=... \
 *     node scripts/upgrade-templates.mjs [--dry-run] [--template <id>]
 */

const API_BASE = process.env.XORGATE_API_BASE?.replace(/\/$/, '');
const ID_TOKEN = process.env.XORGATE_ID_TOKEN;
const ORG_ID = process.env.XORGATE_ORG_ID;
const DRY_RUN = process.argv.includes('--dry-run');
const onlyIdx = process.argv.indexOf('--template');
const ONLY_TEMPLATE = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

if (!API_BASE || !ID_TOKEN || !ORG_ID) {
  console.error('Set XORGATE_API_BASE, XORGATE_ID_TOKEN, XORGATE_ORG_ID');
  process.exit(2);
}

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ID_TOKEN}`,
      'X-Organization-Id': ORG_ID,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function fail(msg, extra) {
  console.error(`FATAL: ${msg}`, extra ?? '');
  process.exit(1);
}

const report = { upgraded: [], skippedV2: [], skippedDraft: [], skippedNoPublished: [], failedValidation: [], pinnedV1: [] };

const list = await api('GET', '/workflow-templates?limit=100');
if (list.status !== 200) fail(`GET /workflow-templates -> ${list.status}`, list.json);
let templates = list.json.templates ?? [];
if (ONLY_TEMPLATE) templates = templates.filter((t) => t.id === ONLY_TEMPLATE);
console.log(`${templates.length} template(s) in scope${DRY_RUN ? ' (dry run)' : ''}`);

for (const t of templates) {
  const detailRes = await api('GET', `/workflow-templates/${t.id}`);
  if (detailRes.status !== 200) fail(`GET template ${t.id} -> ${detailRes.status}`, detailRes.json);
  const tpl = detailRes.json.template;
  const versions = tpl.versions ?? [];
  const label = `${tpl.name} (${t.id})`;

  // Report attachments pinned to v1-stored versions regardless of outcome.
  for (const u of tpl.usage ?? []) {
    if (u.pinnedVersion == null) continue;
    const pinned = versions.find((v) => v.version === u.pinnedVersion);
    if (pinned && (pinned.storedSchemaVersion ?? 1) < 2) {
      report.pinnedV1.push(`${label}: attachment ${u.id} (${u.name}) pinned to v1 version ${u.pinnedVersion}`);
    }
  }

  if (tpl.publishedVersion == null) {
    report.skippedNoPublished.push(label);
    continue;
  }
  const published = versions.find((v) => v.version === tpl.publishedVersion);
  if (!published) fail(`${label}: published version ${tpl.publishedVersion} row missing`);
  if ((published.storedSchemaVersion ?? 1) >= 2) {
    report.skippedV2.push(label);
    continue;
  }

  const draft = versions.find((v) => v.status === 'draft');
  if (draft && JSON.stringify(draft.definition) !== JSON.stringify(published.definition)) {
    report.skippedDraft.push(`${label}: open draft v${draft.version} differs from published v${published.version}`);
    continue;
  }

  console.log(`upgrading ${label}: published v${published.version} stored as schemaVersion ${published.storedSchemaVersion ?? 1}`);
  if (DRY_RUN) {
    report.upgraded.push(`${label} (dry run)`);
    continue;
  }

  // The served definition is already the read-path-upgraded v2 view.
  const draftRes = await api('PUT', `/workflow-templates/${t.id}/draft`, {
    definition: published.definition,
    message: `M6: upgraded v${published.version} to catalog schemaVersion 2`,
  });
  if (draftRes.status !== 200) fail(`${label}: PUT draft -> ${draftRes.status}`, draftRes.json);
  const newDraft = draftRes.json.version;

  const pubRes = await api('POST', `/workflow-templates/${t.id}/versions/${newDraft.id}/publish`);
  if (pubRes.status === 200) {
    report.upgraded.push(`${label}: v${published.version} -> v${newDraft.version}`);
  } else if (pubRes.status === 400 && pubRes.json?.error?.code === 'WORKFLOW_VALIDATION_FAILED') {
    const issues = pubRes.json.error.details?.issues ?? [];
    report.failedValidation.push(
      `${label}: upgraded graph failed publish validation (left on v${published.version}); issues: ${issues
        .map((i) => `${i.code}${i.nodeId ? `@${i.nodeId}` : ''}: ${i.message}`)
        .join(' | ')}`,
    );
  } else {
    fail(`${label}: publish -> ${pubRes.status}`, pubRes.json);
  }
}

console.log('\n===== batch upgrade report =====');
for (const [k, rows] of Object.entries(report)) {
  console.log(`${k}: ${rows.length}`);
  for (const r of rows) console.log(`  - ${r}`);
}
if (report.failedValidation.length > 0 || report.skippedDraft.length > 0) process.exitCode = 3;
