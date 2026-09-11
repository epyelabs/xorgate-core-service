import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq } from 'drizzle-orm';
import { routeKey as canonicalRouteKey } from '../utils/route';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, conflict, methodNotAllowed, notFound, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';
import type { MembershipRole } from '../types/index';
import { patchModelSchema } from '../models/schemas';
import { isKeyUnder } from '../models/keys';
import { MODEL_REGISTRY_PREFIX, modelRootsFor, orgModelRegistryRoot, type ModelManifest } from '../workflows/models/registry';
import { listModelManifests } from '../workflows/models/store';
import { getNodeType } from '../workflows/catalog';
import { datasetS3, deletePrefix, presignGet } from '../services/dataset-store';

/**
 * The merged model read the picker uses (xorgate-models design §4c, §4e):
 *
 *   GET    /models?family=            platform manifests (S3-listed, 60 s cache) + org_models rows,
 *                                     each tagged { scope: platform | organization }
 *   GET    /models/{id}               an org model with lineage and usage; `platform:<family>/<name>` for a platform entry
 *   PATCH  /models/{id}               label, archive / unarchive (admin, owner)
 *   DELETE /models/{id}               409 while any published template version names it (admin, owner)
 *   GET    /models/{id}/download      presigned GETs for manifest.json and model.onnx (member and up, Q13)
 *
 * `GET /model-registry` (the raw platform listing) is unchanged and stays the
 * smoke's read. Platform models are never rows: they are listed from the
 * `models/` prefix exactly as before; organization models are the
 * `org_models` rows the training finalizer (M3) inserts, resolvable by the
 * engine under `org-models/<orgId>/` (cloud-host.ts root chain).
 */

const BUCKET = process.env.BUCKET_NAME;
const CACHE_TTL_MS = 60_000;
const DOWNLOAD_EXPIRES_SECONDS = 15 * 60;
const MANAGE_ROLES: MembershipRole[] = ['owner', 'admin'];
const DOWNLOAD_ROLES: MembershipRole[] = ['owner', 'admin', 'member'];

let platformCache: { at: number; models: ModelManifest[] } | null = null;

async function platformManifests(): Promise<ModelManifest[]> {
  if (!BUCKET) throw new Error('models: BUCKET_NAME is not configured');
  if (!platformCache || Date.now() - platformCache.at > CACHE_TTL_MS) {
    platformCache = { at: Date.now(), models: await listModelManifests(datasetS3(), BUCKET, MODEL_REGISTRY_PREFIX) };
  }
  return platformCache.models;
}

type OrgModelRow = typeof schema.orgModels.$inferSelect;

function platformId(m: ModelManifest): string {
  return `platform:${m.family}/${m.name}@${m.version}`;
}

/** `platform:<family>/<name>[@<version>]` */
function parsePlatformId(id: string): { family: string; name: string; version?: number } | null {
  const m = /^platform:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:@(\d+))?$/.exec(id);
  if (!m) return null;
  return { family: m[1], name: m[2], ...(m[3] ? { version: Number(m[3]) } : {}) };
}

function toPlatformEntry(m: ModelManifest) {
  return {
    id: platformId(m),
    scope: 'platform' as const,
    family: m.family,
    name: m.name,
    version: m.version,
    label: m.label ?? m.name,
    classNames: m.classNames ?? [],
    status: 'ready' as const,
    manifest: m,
    s3Prefix: `${MODEL_REGISTRY_PREFIX}${m.family}/${m.name}/${m.version}/`,
    provenance: null,
    createdAt: null,
    updatedAt: null,
  };
}

function toOrgEntry(row: OrgModelRow) {
  const manifest = row.manifest as ModelManifest;
  return {
    id: row.id,
    scope: 'organization' as const,
    family: row.family,
    name: row.name,
    version: row.version,
    label: row.label ?? manifest.label ?? row.name,
    classNames: manifest.classNames ?? [],
    status: row.status,
    manifest,
    s3Prefix: row.s3Prefix,
    provenance: row.provenance ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Published template versions in the org whose model nodes name this model
 * (`name` or `name@<version>` in the node's `model` config, for node types
 * whose catalog runtime declares a `modelRef` of the same family). The same
 * usage rule `DELETE /workflow-templates/{id}` applies to attachments.
 */
async function modelUsage(orgId: string, family: string, name: string, version: number) {
  const rows = await db
    .select({
      templateId: schema.workflowTemplates.id,
      templateName: schema.workflowTemplates.name,
      version: schema.workflowTemplateVersions.version,
      definition: schema.workflowTemplateVersions.definition,
    })
    .from(schema.workflowTemplateVersions)
    .innerJoin(schema.workflowTemplates, eq(schema.workflowTemplates.id, schema.workflowTemplateVersions.templateId))
    .where(and(eq(schema.workflowTemplates.organizationId, orgId), eq(schema.workflowTemplateVersions.status, 'published')));
  const refs = new Set([name, `${name}@${version}`]);
  const usage: Array<{ templateId: string; templateName: string; version: number; nodeId: string }> = [];
  for (const r of rows) {
    const nodes = (r.definition as { nodes?: Array<{ id: string; type: string; data?: { config?: Record<string, unknown> } }> })?.nodes ?? [];
    for (const node of nodes) {
      const typeDef = getNodeType(node.type);
      if (!typeDef?.runtime.modelRef || typeDef.runtime.modelRef.family !== family) continue;
      const model = node.data?.config?.model;
      if (typeof model === 'string' && refs.has(model.trim())) {
        usage.push({ templateId: r.templateId, templateName: r.templateName, version: r.version, nodeId: node.id });
      }
    }
  }
  return usage;
}

async function loadOrgModel(orgId: string, id: string): Promise<OrgModelRow | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  return db.query.orgModels.findFirst({ where: and(eq(schema.orgModels.id, id), eq(schema.orgModels.organizationId, orgId)) });
}

const restHandler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const id = event.pathParameters?.id;
  const isDownload = routeKey === 'GET /models/{id}/download';

  let auth;
  try {
    auth = await requireOrgWideContext(event, method === 'GET' ? (isDownload ? DOWNLOAD_ROLES : undefined) : MANAGE_ROLES);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgId = auth.organizationId;
  if (!BUCKET) throw new Error('models: BUCKET_NAME is not configured');

  switch (routeKey) {
    case 'GET /models': {
      const qs = event.queryStringParameters ?? {};
      const family = qs.family;
      const scope = qs.scope;
      if (scope && scope !== 'platform' && scope !== 'organization') return badRequest('"scope" must be platform or organization');
      const includeArchived = qs.includeArchived === '1' || qs.includeArchived === 'true';
      const entries: Array<ReturnType<typeof toPlatformEntry> | ReturnType<typeof toOrgEntry>> = [];
      if (scope !== 'platform') {
        const rows = await db
          .select()
          .from(schema.orgModels)
          .where(
            and(
              eq(schema.orgModels.organizationId, orgId),
              family ? eq(schema.orgModels.family, family) : undefined,
              includeArchived ? undefined : eq(schema.orgModels.status, 'ready'),
            ),
          )
          .orderBy(schema.orgModels.family, schema.orgModels.name, desc(schema.orgModels.version));
        entries.push(...rows.map(toOrgEntry));
      }
      if (scope !== 'organization') {
        const manifests = (await platformManifests()).filter((m) => !family || m.family === family);
        entries.push(...manifests.map(toPlatformEntry));
      }
      return ok({ models: entries, roots: modelRootsFor(orgId) });
    }

    case 'GET /models/{id}': {
      if (!id) return badRequest('model id required');
      const platformRef = parsePlatformId(id);
      if (platformRef) {
        const manifests = (await platformManifests()).filter(
          (m) => m.family === platformRef.family && m.name === platformRef.name && (platformRef.version === undefined || m.version === platformRef.version),
        );
        if (manifests.length === 0) return notFound(`Model "${id}" not found`);
        return ok({ model: { ...toPlatformEntry(manifests[0]), usage: await modelUsage(orgId, manifests[0].family, manifests[0].name, manifests[0].version), lineage: null } });
      }
      const row = await loadOrgModel(orgId, id);
      if (!row) return notFound(`Model "${id}" not found`);
      const provenance = (row.provenance ?? {}) as { datasetVersionId?: string; jobId?: string };
      let lineage: { datasetId: string; datasetName: string; datasetVersion: number; datasetVersionId: string; jobId: string | null } | null = null;
      if (provenance.datasetVersionId) {
        const [dv] = await db
          .select({
            datasetId: schema.datasets.id,
            datasetName: schema.datasets.name,
            datasetVersion: schema.datasetVersions.version,
            datasetVersionId: schema.datasetVersions.id,
          })
          .from(schema.datasetVersions)
          .innerJoin(schema.datasets, eq(schema.datasets.id, schema.datasetVersions.datasetId))
          .where(and(eq(schema.datasetVersions.id, provenance.datasetVersionId), eq(schema.datasets.organizationId, orgId)));
        if (dv) lineage = { ...dv, jobId: provenance.jobId ?? null };
      }
      const siblings = await db
        .select({ id: schema.orgModels.id, version: schema.orgModels.version, status: schema.orgModels.status })
        .from(schema.orgModels)
        .where(and(eq(schema.orgModels.organizationId, orgId), eq(schema.orgModels.family, row.family), eq(schema.orgModels.name, row.name)))
        .orderBy(desc(schema.orgModels.version));
      return ok({
        model: {
          ...toOrgEntry(row),
          lineage,
          versions: siblings,
          usage: await modelUsage(orgId, row.family, row.name, row.version),
        },
      });
    }

    case 'PATCH /models/{id}': {
      if (!id) return badRequest('model id required');
      const row = await loadOrgModel(orgId, id);
      if (!row) return notFound(`Model "${id}" not found`);
      const parsed = patchModelSchema.safeParse(JSON.parse(event.body || '{}'));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const patch: Partial<typeof schema.orgModels.$inferInsert> = { updatedAt: new Date() };
      if (parsed.data.label !== undefined) patch.label = parsed.data.label;
      if (parsed.data.status !== undefined) patch.status = parsed.data.status;
      const [updated] = await db.update(schema.orgModels).set(patch).where(eq(schema.orgModels.id, row.id)).returning();
      return ok({ model: toOrgEntry(updated) });
    }

    case 'DELETE /models/{id}': {
      if (!id) return badRequest('model id required');
      const row = await loadOrgModel(orgId, id);
      if (!row) return notFound(`Model "${id}" not found`);
      const usage = await modelUsage(orgId, row.family, row.name, row.version);
      if (usage.length > 0) {
        return conflict(
          `Model "${row.name}" v${row.version} is named by ${usage.length} published workflow version(s): ${[...new Set(usage.map((u) => u.templateName))].join(', ')}. Archive it instead, or unpublish those templates first.`,
        );
      }
      // The prefix must be this org's own root, by construction; asserted anyway.
      if (!isKeyUnder(orgModelRegistryRoot(orgId), `${row.s3Prefix}manifest.json`)) {
        throw new Error(`org model ${row.id} prefix ${row.s3Prefix} is outside ${orgModelRegistryRoot(orgId)}`);
      }
      const drained = await deletePrefix(BUCKET, row.s3Prefix);
      await db.delete(schema.orgModels).where(eq(schema.orgModels.id, row.id));
      return ok({ deleted: true, objectsDeleted: drained.deleted });
    }

    case 'GET /models/{id}/download': {
      if (!id) return badRequest('model id required');
      let prefix: string;
      let label: string;
      const platformRef = parsePlatformId(id);
      if (platformRef) {
        const manifests = (await platformManifests()).filter(
          (m) => m.family === platformRef.family && m.name === platformRef.name && (platformRef.version === undefined || m.version === platformRef.version),
        );
        if (manifests.length === 0) return notFound(`Model "${id}" not found`);
        const m = manifests[0];
        prefix = `${MODEL_REGISTRY_PREFIX}${m.family}/${m.name}/${m.version}/`;
        label = `${m.family}/${m.name}@${m.version}`;
      } else {
        const row = await loadOrgModel(orgId, id);
        if (!row) return notFound(`Model "${id}" not found`);
        prefix = row.s3Prefix;
        label = `${row.family}/${row.name}@${row.version}`;
      }
      const files: Record<string, string> = {};
      for (const name of ['manifest.json', 'model.onnx'] as const) {
        const key = `${prefix}${name}`;
        if (!isKeyUnder(prefix, key)) continue;
        files[name] = await presignGet(BUCKET, key, { expiresIn: DOWNLOAD_EXPIRES_SECONDS, downloadName: name });
      }
      // `xwe run --models-dir <dir>` wants <dir>/<family>/<name>/<version>/{manifest.json, model.onnx}.
      return ok({ model: label, files, expiresInSeconds: DOWNLOAD_EXPIRES_SECONDS, localPath: label.replace('@', '/') });
    }

    default:
      return methodNotAllowed(method, 'GET, PATCH, DELETE');
  }
};

export const handler = apiHandler(restHandler);
