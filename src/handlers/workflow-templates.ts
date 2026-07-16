import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import type { DB } from '../db/index';
import { badRequest, created, errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import type { WorkflowDefinition } from '../schemas/workflows';
import {
  createWorkflowTemplateSchema,
  saveDraftSchema,
  updateWorkflowTemplateSchema,
  workflowDefinitionSchema,
} from '../schemas/workflows';
import { computeRequiredCapabilities } from '../services/workflow-capabilities';
import { upgradeDefinitionSafe } from '../workflows/compat';
import { validateDefinitionForPublish } from '../workflows/validate';

// Any executor that exposes the drizzle query-builder surface: the root db or a
// transaction handle (both share .select/.insert/.update/.delete signatures).
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type Executor = DB | Tx;

type Author = { id: string; name: string; email: string };

// Maps a joined user row (or null, when created_by was set-null) to the FE
// authorSchema. name falls back to the email localpart, then "Unknown user".
function authorFrom(
  row: { id: string; name: string | null; email: string } | null | undefined,
): Author {
  if (!row) return { id: '', name: 'Unknown user', email: '' };
  const localpart = row.email.split('@')[0] || row.email;
  return { id: row.id, name: row.name ?? localpart, email: row.email };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return base || 'workflow';
}

// Finds a slug free within the org, suffixing -2/-3/... on collision. The
// (org, slug) unique index is the backstop; this avoids a 409 on the happy path.
async function freeSlug(exec: Executor, orgId: string, base: string): Promise<string> {
  const rows = await exec
    .select({ slug: schema.workflowTemplates.slug })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.organizationId, orgId),
        or(
          eq(schema.workflowTemplates.slug, base),
          like(schema.workflowTemplates.slug, `${base}-%`),
        ),
      ),
    );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

async function loadUsers(exec: Executor, ids: (string | null)[]): Promise<Map<string, Author>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, Author>();
  if (unique.length === 0) return map;
  const rows = await exec
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.id, unique));
  for (const r of rows) map.set(r.id, authorFrom(r));
  return map;
}

type TemplateRow = typeof schema.workflowTemplates.$inferSelect;

function toSummary(
  t: TemplateRow,
  usedBy: number,
  users: Map<string, Author>,
  requiredCapabilities: string[],
) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description ?? null,
    status: t.status,
    currentVersion: t.currentVersion,
    publishedVersion: t.publishedVersion ?? null,
    usedBy,
    requiredCapabilities,
    createdBy: users.get(t.createdByUserId ?? '') ?? authorFrom(null),
    updatedBy: users.get(t.updatedByUserId ?? '') ?? authorFrom(null),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// Guarded capability computation over a stored (jsonb) definition.
function safeRequiredCaps(def: unknown): string[] {
  if (!def || typeof def !== 'object' || !Array.isArray((def as { nodes?: unknown }).nodes)) {
    return [];
  }
  return computeRequiredCapabilities(def as WorkflowDefinition);
}

// Versions (asc) mapped to workflowTemplateVersionSchema with joined authors.
async function loadVersions(exec: Executor, templateId: string) {
  const rows = await exec
    .select({
      id: schema.workflowTemplateVersions.id,
      version: schema.workflowTemplateVersions.version,
      status: schema.workflowTemplateVersions.status,
      message: schema.workflowTemplateVersions.message,
      definition: schema.workflowTemplateVersions.definition,
      createdAt: schema.workflowTemplateVersions.createdAt,
      authorId: schema.users.id,
      authorName: schema.users.name,
      authorEmail: schema.users.email,
    })
    .from(schema.workflowTemplateVersions)
    .leftJoin(schema.users, eq(schema.users.id, schema.workflowTemplateVersions.createdByUserId))
    .where(eq(schema.workflowTemplateVersions.templateId, templateId))
    .orderBy(asc(schema.workflowTemplateVersions.version));

  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    message: r.message ?? null,
    // Read-path v1 -> v2 upgrade (pure; the stored row is not rewritten).
    definition: upgradeDefinitionSafe(r.definition),
    // ADDITIVE (M6): the schemaVersion of the STORED row, before the read-path
    // upgrade. The batch-upgrade tooling keys off this to find templates whose
    // published definition still needs a v2 re-publish (the served definition
    // above is always upgraded, so it can't tell).
    storedSchemaVersion:
      ((r.definition as { schemaVersion?: number } | null)?.schemaVersion ?? 1),
    createdBy: authorFrom(
      r.authorId ? { id: r.authorId, name: r.authorName, email: r.authorEmail as string } : null,
    ),
    createdAt: r.createdAt.toISOString(),
  }));
}

// Usage rows mapped to workflowDeploymentSchema (attachment × device × workspace).
async function loadUsage(exec: Executor, templateId: string) {
  const rows = await exec
    .select({
      attachmentId: schema.workflowAttachments.id,
      deviceName: schema.devices.name,
      serial: schema.devices.serial,
      workspaceName: schema.workspaces.name,
      pinnedVersion: schema.workflowAttachments.pinnedVersion,
      enabled: schema.workflowAttachments.enabled,
      lastRunAt: schema.workflowAttachments.lastRunAt,
    })
    .from(schema.workflowAttachments)
    .innerJoin(schema.devices, eq(schema.devices.id, schema.workflowAttachments.deviceId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.devices.workspaceId))
    .where(eq(schema.workflowAttachments.templateId, templateId));

  return rows.map((r) => ({
    id: r.attachmentId,
    name: r.deviceName ?? r.serial,
    workspaceName: r.workspaceName,
    target: r.serial,
    pinnedVersion: r.pinnedVersion ?? null,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
  }));
}

async function buildDetail(exec: Executor, t: TemplateRow) {
  // Run sequentially, not via Promise.all: the aws-data-api driver serializes
  // statements within a transaction, so concurrent queries on a `tx` handle throw
  // "Transaction is still running a query". buildDetail runs inside the write-path
  // transactions (create/draft/publish/restore), so it must not fan out.
  const versions = await loadVersions(exec, t.id);
  const usage = await loadUsage(exec, t.id);
  const users = await loadUsers(exec, [t.createdByUserId, t.updatedByUserId]);
  // Capabilities of the version that would actually run (published, else current).
  const target = t.publishedVersion ?? t.currentVersion;
  const relevant = versions.find((v) => v.version === target) ?? versions.at(-1);
  const requiredCapabilities = safeRequiredCaps(relevant?.definition);
  return {
    ...toSummary(t, usage.length, users, requiredCapabilities),
    versions,
    usage,
  };
}

// Loads the template if it belongs to the caller's org (404-shielding).
async function loadTemplate(orgId: string, id: string): Promise<TemplateRow | undefined> {
  return db.query.workflowTemplates.findFirst({
    where: and(
      eq(schema.workflowTemplates.id, id),
      eq(schema.workflowTemplates.organizationId, orgId),
    ),
  });
}

/**
 * CRUD + versioning for org-scoped workflow templates. Routes (all -> this Lambda):
 *   GET    /workflow-templates
 *   POST   /workflow-templates
 *   GET    /workflow-templates/{id}
 *   PUT    /workflow-templates/{id}
 *   PUT    /workflow-templates/{id}/draft
 *   POST   /workflow-templates/{id}/versions/{versionId}/publish
 *   POST   /workflow-templates/{id}/versions/{versionId}/restore
 *   GET    /workflow-templates/{id}/usage
 * Version invariant (mirrors the FE mock): at most one draft and one published
 * version per template; publish archives the previous published row and sets both
 * template.publishedVersion and template.currentVersion.
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = event.routeKey;
  const id = event.pathParameters?.id;
  const versionId = event.pathParameters?.versionId;

  let auth;
  try {
    const writeMethod = method === 'POST' || method === 'PUT';
    auth = await requireOrgContext(event, writeMethod ? ['owner', 'admin', 'member'] : undefined);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgId = auth.organizationId;

  switch (routeKey) {
    case 'GET /workflow-templates': {
      // Standardized list dialect (utils/list-params): limit/offset/order/sort/
      // status, plus a `page` block. Default order preserves the prior behaviour
      // (most-recently-updated first).
      const parsed = parseListParams(event, {
        sortable: ['updatedAt', 'createdAt', 'name'],
        defaultSort: 'updatedAt',
        statusValues: ['draft', 'published'],
      });
      if ('error' in parsed) return parsed.error;
      const { limit, offset, order, sortBy, status } = parsed;

      const where = and(
        eq(schema.workflowTemplates.organizationId, orgId),
        status ? eq(schema.workflowTemplates.status, status) : undefined,
      );

      const totalRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.workflowTemplates)
        .where(where);
      const total = Number(totalRows[0]?.total ?? 0);
      const page = pageMeta(parsed, total);
      if (total === 0) return ok({ templates: [], page });

      const sortCol =
        sortBy === 'createdAt'
          ? schema.workflowTemplates.createdAt
          : sortBy === 'name'
            ? schema.workflowTemplates.name
            : schema.workflowTemplates.updatedAt;

      const templates = await db.query.workflowTemplates.findMany({
        where,
        orderBy: [order === 'asc' ? asc(sortCol) : desc(sortCol)],
        limit,
        offset,
      });
      if (templates.length === 0) return ok({ templates: [], page });

      const ids = templates.map((t) => t.id);
      const [counts, users, versionRows] = await Promise.all([
        db
          .select({
            templateId: schema.workflowAttachments.templateId,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.workflowAttachments)
          .where(inArray(schema.workflowAttachments.templateId, ids))
          .groupBy(schema.workflowAttachments.templateId),
        loadUsers(db, templates.flatMap((t) => [t.createdByUserId, t.updatedByUserId])),
        db
          .select({
            templateId: schema.workflowTemplateVersions.templateId,
            version: schema.workflowTemplateVersions.version,
            definition: schema.workflowTemplateVersions.definition,
          })
          .from(schema.workflowTemplateVersions)
          .where(inArray(schema.workflowTemplateVersions.templateId, ids)),
      ]);
      const countByTemplate = new Map(counts.map((c) => [c.templateId, c.count]));
      // templateId -> version -> definition, to compute requiredCapabilities of
      // the version that would run (published, else current).
      const defByTemplate = new Map<string, Map<number, unknown>>();
      for (const r of versionRows) {
        let inner = defByTemplate.get(r.templateId);
        if (!inner) defByTemplate.set(r.templateId, (inner = new Map()));
        inner.set(r.version, r.definition);
      }
      return ok({
        templates: templates.map((t) => {
          const target = t.publishedVersion ?? t.currentVersion;
          const def = defByTemplate.get(t.id)?.get(target);
          return toSummary(t, countByTemplate.get(t.id) ?? 0, users, safeRequiredCaps(def));
        }),
        page,
      });
    }

    case 'POST /workflow-templates': {
      const parsed = createWorkflowTemplateSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const { name, description } = parsed.data;

      const detail = await db.transaction(async (tx) => {
        const slug = await freeSlug(tx, orgId, slugify(name));
        const [template] = await tx
          .insert(schema.workflowTemplates)
          .values({
            organizationId: orgId,
            name,
            slug,
            description: description?.trim() ? description.trim() : null,
            status: 'draft',
            currentVersion: 1,
            publishedVersion: null,
            createdByUserId: auth.userId,
            updatedByUserId: auth.userId,
          })
          .returning();
        await tx.insert(schema.workflowTemplateVersions).values({
          templateId: template.id,
          version: 1,
          status: 'draft',
          message: 'Initial draft.',
          definition: { nodes: [], edges: [] },
          createdByUserId: auth.userId,
        });
        return buildDetail(tx, template);
      });
      return created({ template: detail });
    }

    case 'GET /workflow-templates/{id}': {
      if (!id) return badRequest('template id required');
      const template = await loadTemplate(orgId, id);
      if (!template) return notFound(`Workflow template "${id}" not found`);
      return ok({ template: await buildDetail(db, template) });
    }

    case 'PUT /workflow-templates/{id}': {
      if (!id) return badRequest('template id required');
      const parsed = updateWorkflowTemplateSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const template = await loadTemplate(orgId, id);
      if (!template) return notFound(`Workflow template "${id}" not found`);

      const updates: Record<string, unknown> = { updatedByUserId: auth.userId, updatedAt: new Date() };
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.description !== undefined) {
        updates.description = parsed.data.description?.trim() ? parsed.data.description.trim() : null;
      }
      const [updated] = await db
        .update(schema.workflowTemplates)
        .set(updates)
        .where(eq(schema.workflowTemplates.id, id))
        .returning();
      return ok({ template: await buildDetail(db, updated) });
    }

    case 'PUT /workflow-templates/{id}/draft': {
      if (!id) return badRequest('template id required');
      const parsed = saveDraftSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid definition');
      const template = await loadTemplate(orgId, id);
      if (!template) return notFound(`Workflow template "${id}" not found`);
      const { definition, message } = parsed.data;

      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(schema.workflowTemplateVersions)
          .where(
            and(
              eq(schema.workflowTemplateVersions.templateId, id),
              eq(schema.workflowTemplateVersions.status, 'draft'),
            ),
          );
        let draftId: string;
        if (existing.length > 0) {
          const draft = existing[0];
          await tx
            .update(schema.workflowTemplateVersions)
            .set({
              definition,
              message: message !== undefined ? message : draft.message,
              createdByUserId: auth.userId,
              createdAt: new Date(),
            })
            .where(eq(schema.workflowTemplateVersions.id, draft.id));
          draftId = draft.id;
        } else {
          const nextVersion = await nextVersionNumber(tx, id);
          const [draft] = await tx
            .insert(schema.workflowTemplateVersions)
            .values({
              templateId: id,
              version: nextVersion,
              status: 'draft',
              message: message ?? `Draft v${nextVersion}`,
              definition,
              createdByUserId: auth.userId,
            })
            .returning({ id: schema.workflowTemplateVersions.id });
          draftId = draft.id;
          await tx
            .update(schema.workflowTemplates)
            .set({ currentVersion: nextVersion })
            .where(eq(schema.workflowTemplates.id, id));
        }
        const [freshTemplate] = await tx
          .update(schema.workflowTemplates)
          .set({ updatedByUserId: auth.userId, updatedAt: new Date() })
          .where(eq(schema.workflowTemplates.id, id))
          .returning();
        const versions = await loadVersions(tx, id);
        const detail = await buildDetail(tx, freshTemplate);
        const version = versions.find((v) => v.id === draftId)!;
        return { detail, version };
      });
      return ok({ template: result.detail, version: result.version });
    }

    case 'POST /workflow-templates/{id}/versions/{versionId}/publish': {
      if (!id || !versionId) return badRequest('template id and version id required');
      const template = await loadTemplate(orgId, id);
      if (!template) return notFound(`Workflow template "${id}" not found`);

      // Strict catalog validation before anything is mutated (drafts stay
      // shape-valid only; publish is the enforcement point). Validates the
      // upgraded v2 view; the stored definition is not rewritten.
      const candidate = await db.query.workflowTemplateVersions.findFirst({
        where: and(
          eq(schema.workflowTemplateVersions.id, versionId),
          eq(schema.workflowTemplateVersions.templateId, id),
        ),
      });
      if (!candidate) return notFound(`Version "${versionId}" not found`);
      const shape = workflowDefinitionSchema.safeParse(candidate.definition);
      if (!shape.success) {
        return errorResponse(400, 'WORKFLOW_VALIDATION_FAILED', 'Workflow definition failed publish validation', {
          issues: [{ code: 'INVALID_SHAPE', message: 'Definition is not a valid node/edge graph' }],
        });
      }
      const { issues } = validateDefinitionForPublish(shape.data);
      if (issues.length > 0) {
        return errorResponse(400, 'WORKFLOW_VALIDATION_FAILED', 'Workflow definition failed publish validation', {
          issues,
        });
      }

      const detail = await db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(schema.workflowTemplateVersions)
          .where(
            and(
              eq(schema.workflowTemplateVersions.id, versionId),
              eq(schema.workflowTemplateVersions.templateId, id),
            ),
          );
        if (!target) return null;
        // Archive the currently published version, then promote the target.
        await tx
          .update(schema.workflowTemplateVersions)
          .set({ status: 'archived' })
          .where(
            and(
              eq(schema.workflowTemplateVersions.templateId, id),
              eq(schema.workflowTemplateVersions.status, 'published'),
            ),
          );
        await tx
          .update(schema.workflowTemplateVersions)
          .set({ status: 'published' })
          .where(eq(schema.workflowTemplateVersions.id, target.id));
        const [freshTemplate] = await tx
          .update(schema.workflowTemplates)
          .set({
            status: 'published',
            publishedVersion: target.version,
            currentVersion: target.version,
            updatedByUserId: auth.userId,
            updatedAt: new Date(),
          })
          .where(eq(schema.workflowTemplates.id, id))
          .returning();
        return buildDetail(tx, freshTemplate);
      });
      if (!detail) return notFound(`Version "${versionId}" not found`);
      return ok({ template: detail });
    }

    case 'POST /workflow-templates/{id}/versions/{versionId}/restore': {
      if (!id || !versionId) return badRequest('template id and version id required');
      const template = await loadTemplate(orgId, id);
      if (!template) return notFound(`Workflow template "${id}" not found`);

      const result = await db.transaction(async (tx) => {
        const [source] = await tx
          .select()
          .from(schema.workflowTemplateVersions)
          .where(
            and(
              eq(schema.workflowTemplateVersions.id, versionId),
              eq(schema.workflowTemplateVersions.templateId, id),
            ),
          );
        if (!source) return null;
        // Replace any open draft with a fresh one seeded from the source definition.
        await tx
          .delete(schema.workflowTemplateVersions)
          .where(
            and(
              eq(schema.workflowTemplateVersions.templateId, id),
              eq(schema.workflowTemplateVersions.status, 'draft'),
            ),
          );
        const nextVersion = await nextVersionNumber(tx, id);
        const [draft] = await tx
          .insert(schema.workflowTemplateVersions)
          .values({
            templateId: id,
            version: nextVersion,
            status: 'draft',
            message: `Restored from v${source.version}`,
            // Restore seeds the new draft with the upgraded (v2) definition.
            definition: upgradeDefinitionSafe(source.definition),
            createdByUserId: auth.userId,
          })
          .returning({ id: schema.workflowTemplateVersions.id });
        const [freshTemplate] = await tx
          .update(schema.workflowTemplates)
          .set({ currentVersion: nextVersion, updatedByUserId: auth.userId, updatedAt: new Date() })
          .where(eq(schema.workflowTemplates.id, id))
          .returning();
        const versions = await loadVersions(tx, id);
        const detail = await buildDetail(tx, freshTemplate);
        return { detail, version: versions.find((v) => v.id === draft.id)! };
      });
      if (!result) return notFound(`Version "${versionId}" not found`);
      return ok({ template: result.detail, version: result.version });
    }

    case 'GET /workflow-templates/{id}/usage': {
      if (!id) return badRequest('template id required');
      const template = await loadTemplate(orgId, id);
      if (!template) return notFound(`Workflow template "${id}" not found`);
      return ok({ instances: await loadUsage(db, id) });
    }

    default:
      return methodNotAllowed(method, 'GET, POST, PUT');
  }
};

// max(version)+1 for a template (1 when it somehow has no versions).
async function nextVersionNumber(exec: Executor, templateId: string): Promise<number> {
  const [row] = await exec
    .select({ max: sql<number>`coalesce(max(${schema.workflowTemplateVersions.version}), 0)::int` })
    .from(schema.workflowTemplateVersions)
    .where(eq(schema.workflowTemplateVersions.templateId, templateId));
  return (row?.max ?? 0) + 1;
}

function safeJson(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return {};
  }
}
