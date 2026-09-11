import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { routeKey as canonicalRouteKey } from '../utils/route';
import { AuthError, authErrorResponse, requireOrgWideContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { badRequest, conflict, created, errorResponse, methodNotAllowed, notFound, ok } from '../utils/responses';
import { pageMeta, parseListParams } from '../utils/list-params';
import { tsParam } from '../utils/sql';
import { apiHandler } from '../utils/api-handler';
import type { MembershipRole } from '../types/index';
import { applyClassEdits, classesFromNames, parseStoredClasses } from '../models/classes';
import { freeSlugFrom, slugifyDatasetName } from '../models/names';
import {
  datasetItemKey,
  datasetPrefix,
  datasetVersionPrefix,
  IMAGE_EXTENSIONS,
  isKeyUnder,
  MAX_IMAGE_BYTES,
  MAX_ITEMS_PER_DATASET,
  parseItemKey,
  VERSION_FILES,
} from '../models/keys';
import {
  createDatasetSchema,
  createImportSchema,
  createUploadsSchema,
  createVersionSchema,
  ITEM_SOURCE_KINDS,
  ITEM_STATUSES,
  putAnnotationsSchema,
  registerItemsSchema,
  updateDatasetSchema,
} from '../models/schemas';
import {
  datasetS3,
  deleteObjects,
  deletePrefix,
  presignGet,
  probeImageObject,
} from '../services/dataset-store';
import { prepareVersionFromDb } from '../services/dataset-version-build';
import { refreshItemCount } from '../services/dataset-import';
import { enqueueModelJob } from '../services/model-jobs';
import { findOrgSessions } from '../services/media-session-input';

/**
 * Datasets API (xorgate-models design §4c; all routes -> this Lambda):
 *
 *   GET|POST   /datasets
 *   GET|PATCH|DELETE /datasets/{id}
 *   GET|POST   /datasets/{id}/items                       list (paged, presigned URLs) | register uploaded keys
 *   POST       /datasets/{id}/items/uploads               presigned POST per file (image/jpeg|png, 20 MiB)
 *   DELETE     /datasets/{id}/items/{itemId}              hard delete, or exclude when a version references it
 *   GET|PUT    /datasets/{id}/items/{itemId}/annotations  PUT = replace-all + item status, If-Match on the item's etag
 *   GET|POST   /datasets/{id}/imports                     recording-frame import jobs (SQS)
 *   GET        /datasets/{id}/imports/{importId}
 *   GET|POST   /datasets/{id}/versions                    POST = health-checked, then built async (SQS)
 *   GET        /datasets/{id}/versions/{version}
 *
 * Roles (Q5): every member reads; member and up write (annotate, upload,
 * import, version); admin and owner delete a dataset. Every route is
 * org-wide (`requireOrgWideContext`); a dataset has no workspace. Responses
 * are camelCase like the workflow endpoints. Keys carry ids, not tenancy: the
 * organization is the dataset row's, and every presign is gated to the
 * dataset's own prefix.
 */

const BUCKET = process.env.BUCKET_NAME;
const UPLOAD_EXPIRES_SECONDS = 15 * 60;
const WRITE_ROLES: MembershipRole[] = ['owner', 'admin', 'member'];
const DELETE_ROLES: MembershipRole[] = ['owner', 'admin'];

type DatasetRow = typeof schema.datasets.$inferSelect;
type ItemRow = typeof schema.datasetItems.$inferSelect;
type AnnotationRow = typeof schema.datasetAnnotations.$inferSelect;
type ImportRow = typeof schema.datasetImports.$inferSelect;
type VersionRow = typeof schema.datasetVersions.$inferSelect;

function safeJson(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return {};
  }
}

function toDataset(d: DatasetRow, extra: { versionCount?: number; latestVersion?: number | null } = {}) {
  return {
    id: d.id,
    name: d.name,
    slug: d.slug,
    description: d.description ?? null,
    task: d.task,
    classes: parseStoredClasses(d.classes),
    itemCount: d.itemCount,
    labeledCount: d.labeledCount,
    versionCount: extra.versionCount ?? 0,
    latestVersion: extra.latestVersion ?? null,
    createdByUserId: d.createdByUserId ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** The item's optimistic-concurrency token: its `updatedAt`, quoted as a weak ETag. */
function itemEtag(item: ItemRow): string {
  return `W/"${item.updatedAt.getTime()}"`;
}

function toItem(item: ItemRow, url: string | null, annotationCount: number) {
  return {
    id: item.id,
    datasetId: item.datasetId,
    key: item.s3Key,
    url,
    width: item.width,
    height: item.height,
    bytes: item.bytes,
    sha256: item.sha256,
    source: item.source,
    groupKey: item.groupKey ?? null,
    status: item.status,
    annotationCount,
    labeledByUserId: item.labeledByUserId ?? null,
    labeledAt: item.labeledAt ? item.labeledAt.toISOString() : null,
    etag: itemEtag(item),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function toAnnotation(a: AnnotationRow) {
  return {
    id: a.id,
    classId: a.classId,
    x1: a.x1,
    y1: a.y1,
    x2: a.x2,
    y2: a.y2,
    source: a.source,
    sourceRef: a.sourceRef ?? null,
    confidence: a.confidence ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

function toImport(r: ImportRow) {
  return {
    id: r.id,
    datasetId: r.datasetId,
    kind: r.kind,
    params: r.params,
    status: r.status,
    progress: r.progress,
    itemsAdded: r.itemsAdded,
    error: r.error ?? null,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toVersion(v: VersionRow, files: Record<string, string> | null = null) {
  return {
    id: v.id,
    datasetId: v.datasetId,
    version: v.version,
    message: v.message ?? null,
    splitConfig: v.splitConfig,
    classNames: v.classNames,
    stats: v.stats ?? null,
    health: v.health ?? null,
    s3Prefix: v.s3Prefix,
    status: v.status,
    error: v.error ?? null,
    files,
    readyAt: v.readyAt ? v.readyAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

async function loadDataset(orgId: string, id: string): Promise<DatasetRow | undefined> {
  return db.query.datasets.findFirst({
    where: and(eq(schema.datasets.id, id), eq(schema.datasets.organizationId, orgId)),
  });
}

async function versionSummary(datasetIds: string[]): Promise<Map<string, { versionCount: number; latestVersion: number | null }>> {
  const out = new Map<string, { versionCount: number; latestVersion: number | null }>();
  if (datasetIds.length === 0) return out;
  const rows = await db
    .select({
      datasetId: schema.datasetVersions.datasetId,
      versionCount: sql<number>`count(*)::int`,
      latestVersion: sql<number | null>`max(case when ${schema.datasetVersions.status} = 'ready' then ${schema.datasetVersions.version} end)`,
    })
    .from(schema.datasetVersions)
    .where(inArray(schema.datasetVersions.datasetId, datasetIds))
    .groupBy(schema.datasetVersions.datasetId);
  for (const r of rows) out.set(r.datasetId, { versionCount: Number(r.versionCount), latestVersion: r.latestVersion === null ? null : Number(r.latestVersion) });
  return out;
}

async function classUsage(datasetId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ classId: schema.datasetAnnotations.classId, n: sql<number>`count(*)::int` })
    .from(schema.datasetAnnotations)
    .innerJoin(schema.datasetItems, eq(schema.datasetItems.id, schema.datasetAnnotations.itemId))
    .where(eq(schema.datasetItems.datasetId, datasetId))
    .groupBy(schema.datasetAnnotations.classId);
  return new Map(rows.map((r) => [r.classId, Number(r.n)]));
}

const restHandler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const routeKey = canonicalRouteKey(event);
  const id = event.pathParameters?.id;
  const isWrite = method !== 'GET';
  const isDatasetDelete = routeKey === 'DELETE /datasets/{id}';

  let auth;
  try {
    auth = await requireOrgWideContext(event, isDatasetDelete ? DELETE_ROLES : isWrite ? WRITE_ROLES : undefined);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }
  const orgId = auth.organizationId;
  if (!BUCKET) throw new Error('datasets: BUCKET_NAME is not configured');

  // --- collection routes -------------------------------------------------------
  if (routeKey === 'GET /datasets') {
    const parsed = parseListParams(event, { sortable: ['createdAt', 'updatedAt', 'name'], defaultSort: 'updatedAt' });
    if ('error' in parsed) return parsed.error;
    const { limit, offset, order, sortBy } = parsed;
    const where = eq(schema.datasets.organizationId, orgId);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.datasets).where(where);
    const col =
      sortBy === 'name' ? schema.datasets.name : sortBy === 'createdAt' ? schema.datasets.createdAt : schema.datasets.updatedAt;
    const rows = await db
      .select()
      .from(schema.datasets)
      .where(where)
      .orderBy(order === 'asc' ? asc(col) : desc(col))
      .limit(limit)
      .offset(offset);
    const summary = await versionSummary(rows.map((r) => r.id));
    return ok({ datasets: rows.map((r) => toDataset(r, summary.get(r.id))), page: pageMeta(parsed, Number(total)) });
  }

  if (routeKey === 'POST /datasets') {
    const parsed = createDatasetSchema.safeParse(safeJson(event.body));
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
    const classes = classesFromNames(parsed.data.classes);
    if (!classes.ok) return badRequest(classes.error);
    const taken = await db
      .select({ slug: schema.datasets.slug })
      .from(schema.datasets)
      .where(eq(schema.datasets.organizationId, orgId));
    const slug = freeSlugFrom(slugifyDatasetName(parsed.data.name), taken.map((t) => t.slug));
    const [row] = await db
      .insert(schema.datasets)
      .values({
        organizationId: orgId,
        name: parsed.data.name,
        slug,
        description: parsed.data.description ?? null,
        classes: classes.classes,
        createdByUserId: auth.userId,
      })
      .returning();
    return created({ dataset: toDataset(row) });
  }

  // --- everything below is /datasets/{id}... ------------------------------------
  if (!id) return badRequest('dataset id required');
  const dataset = await loadDataset(orgId, id);
  if (!dataset) return notFound(`Dataset "${id}" not found`);
  const classes = parseStoredClasses(dataset.classes);
  const classIds = new Set(classes.map((c) => c.id));

  switch (routeKey) {
    case 'GET /datasets/{id}': {
      const summary = await versionSummary([dataset.id]);
      const statusRows = await db
        .select({ status: schema.datasetItems.status, n: sql<number>`count(*)::int` })
        .from(schema.datasetItems)
        .where(eq(schema.datasetItems.datasetId, dataset.id))
        .groupBy(schema.datasetItems.status);
      const usage = await classUsage(dataset.id);
      return ok({
        dataset: {
          ...toDataset(dataset, summary.get(dataset.id)),
          itemsByStatus: Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)])),
          classUsage: Object.fromEntries(classes.map((c) => [c.id, usage.get(c.id) ?? 0])),
        },
      });
    }

    case 'PATCH /datasets/{id}': {
      const parsed = updateDatasetSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const patch: Partial<typeof schema.datasets.$inferInsert> = { updatedAt: new Date() };
      if (parsed.data.name !== undefined) patch.name = parsed.data.name;
      if (parsed.data.description !== undefined) patch.description = parsed.data.description;
      if (parsed.data.classes !== undefined) {
        const edited = applyClassEdits(classes, parsed.data.classes, await classUsage(dataset.id));
        if (!edited.ok) return badRequest(edited.error);
        patch.classes = edited.classes;
      }
      const [row] = await db.update(schema.datasets).set(patch).where(eq(schema.datasets.id, dataset.id)).returning();
      const summary = await versionSummary([dataset.id]);
      return ok({ dataset: toDataset(row, summary.get(dataset.id)) });
    }

    case 'DELETE /datasets/{id}': {
      // Objects first (items, versions), then the row; the FK graph cascades
      // items, annotations, imports and versions. A prefix too large for one
      // request's budget is reported, never silently left behind.
      const drained = await deletePrefix(BUCKET, datasetPrefix(dataset.id));
      await db.delete(schema.datasets).where(eq(schema.datasets.id, dataset.id));
      return ok({ deleted: true, objectsDeleted: drained.deleted, drained: drained.drained });
    }

    case 'GET /datasets/{id}/items': {
      const parsed = parseListParams(event, {
        defaultLimit: 48,
        maxLimit: 200,
        defaultOrder: 'asc',
        sortable: ['createdAt'],
        defaultSort: 'createdAt',
        statusValues: ITEM_STATUSES,
      });
      if ('error' in parsed) return parsed.error;
      const qs = event.queryStringParameters ?? {};
      const classFilter = qs.class;
      if (classFilter && !classIds.has(classFilter)) return badRequest(`"class" must be one of the dataset's class ids`);
      const sourceKind = qs.source;
      if (sourceKind && !(ITEM_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
        return badRequest(`"source" must be one of: ${ITEM_SOURCE_KINDS.join(', ')}`);
      }
      const groupKey = qs.group;
      const conditions: (SQL | undefined)[] = [
        eq(schema.datasetItems.datasetId, dataset.id),
        parsed.status ? eq(schema.datasetItems.status, parsed.status) : undefined,
        sourceKind ? sql`${schema.datasetItems.source}->>'kind' = ${sourceKind}` : undefined,
        groupKey ? eq(schema.datasetItems.groupKey, groupKey) : undefined,
        classFilter
          ? sql`exists (select 1 from dataset_annotations a where a.item_id = ${schema.datasetItems.id} and a.class_id = ${classFilter})`
          : undefined,
      ];
      const where = and(...conditions);
      const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.datasetItems).where(where);
      const rows = await db
        .select({
          item: schema.datasetItems,
          annotationCount: sql<number>`(select count(*)::int from dataset_annotations a where a.item_id = ${schema.datasetItems.id})`,
        })
        .from(schema.datasetItems)
        .where(where)
        .orderBy(parsed.order === 'asc' ? asc(schema.datasetItems.createdAt) : desc(schema.datasetItems.createdAt), asc(schema.datasetItems.id))
        .limit(parsed.limit)
        .offset(parsed.offset);
      // One presigned GET per row, batched for the page (Q14: the browser
      // scales the original; there is no thumbnail object).
      const urls = await Promise.all(rows.map((r) => presignGet(BUCKET, r.item.s3Key)));
      return ok({
        items: rows.map((r, i) => toItem(r.item, urls[i], Number(r.annotationCount))),
        page: pageMeta(parsed, Number(total)),
      });
    }

    case 'POST /datasets/{id}/items/uploads': {
      const parsed = createUploadsSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      if (dataset.itemCount + parsed.data.files.length > MAX_ITEMS_PER_DATASET) {
        return conflict(`A dataset holds at most ${MAX_ITEMS_PER_DATASET} items (${dataset.itemCount} now)`);
      }
      const uploads = [];
      for (const file of parsed.data.files) {
        const itemId = randomUUID();
        const key = datasetItemKey(dataset.id, itemId, IMAGE_EXTENSIONS[file.contentType]);
        const post = await createPresignedPost(datasetS3(), {
          Bucket: BUCKET,
          Key: key,
          Expires: UPLOAD_EXPIRES_SECONDS,
          Conditions: [['content-length-range', 1, MAX_IMAGE_BYTES], ['eq', '$Content-Type', file.contentType]],
          Fields: { 'Content-Type': file.contentType },
        });
        uploads.push({
          itemId,
          key,
          filename: file.filename,
          url: post.url,
          fields: post.fields,
          expiresInSeconds: UPLOAD_EXPIRES_SECONDS,
          maxBytes: MAX_IMAGE_BYTES,
        });
      }
      return created({ uploads });
    }

    case 'POST /datasets/{id}/items': {
      // Register uploaded keys as rows: read dimensions from the header
      // bytes and sha256 by streaming; a duplicate (same bytes already in the
      // dataset) or a non-image is reported and its object removed, never
      // stored twice.
      const parsed = registerItemsSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const existingRows = await db
        .select({ id: schema.datasetItems.id, sha256: schema.datasetItems.sha256 })
        .from(schema.datasetItems)
        .where(eq(schema.datasetItems.datasetId, dataset.id));
      const bySha = new Map(existingRows.map((r) => [r.sha256, r.id]));
      const existingIds = new Set(existingRows.map((r) => r.id));
      let count = existingRows.length;
      const items: ReturnType<typeof toItem>[] = [];
      const duplicates: Array<{ key: string; itemId: string }> = [];
      const rejected: Array<{ key: string; reason: string }> = [];
      const toDelete: string[] = [];
      const seenKeys = new Set<string>();
      for (const key of parsed.data.keys) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const ref = parseItemKey(dataset.id, key);
        if (!ref) {
          rejected.push({ key, reason: 'key was not issued by this dataset\'s uploads endpoint' });
          continue;
        }
        if (existingIds.has(ref.itemId)) {
          rejected.push({ key, reason: 'already registered' });
          continue;
        }
        if (count >= MAX_ITEMS_PER_DATASET) {
          rejected.push({ key, reason: `dataset cap of ${MAX_ITEMS_PER_DATASET} items reached` });
          toDelete.push(key);
          continue;
        }
        const probe = await probeImageObject(BUCKET, key);
        if (!probe) {
          rejected.push({ key, reason: 'object missing or not a JPEG or PNG' });
          toDelete.push(key);
          continue;
        }
        if (probe.bytes > MAX_IMAGE_BYTES) {
          rejected.push({ key, reason: `image exceeds ${MAX_IMAGE_BYTES} bytes` });
          toDelete.push(key);
          continue;
        }
        const dup = bySha.get(probe.sha256);
        if (dup) {
          duplicates.push({ key, itemId: dup });
          toDelete.push(key);
          continue;
        }
        const [row] = await db
          .insert(schema.datasetItems)
          .values({
            id: ref.itemId,
            datasetId: dataset.id,
            s3Key: key,
            width: probe.width,
            height: probe.height,
            bytes: probe.bytes,
            sha256: probe.sha256,
            source: { kind: 'upload', filename: null },
            groupKey: parsed.data.groupKey ?? null,
            status: 'unlabeled',
          })
          .returning();
        bySha.set(probe.sha256, row.id);
        existingIds.add(row.id);
        count += 1;
        items.push(toItem(row, null, 0));
      }
      if (toDelete.length > 0) await deleteObjects(BUCKET, toDelete);
      if (items.length > 0) await refreshItemCount(dataset.id);
      return created({ items, duplicates, rejected });
    }

    case 'DELETE /datasets/{id}/items/{itemId}': {
      const itemId = event.pathParameters?.itemId;
      if (!itemId) return badRequest('item id required');
      const item = await db.query.datasetItems.findFirst({
        where: and(eq(schema.datasetItems.id, itemId), eq(schema.datasetItems.datasetId, dataset.id)),
      });
      if (!item) return notFound(`Item "${itemId}" not found`);
      // A version built after the item existed may reference its copy; the
      // original then stays and the item is excluded from later versions.
      const [ref] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.datasetVersions)
        .where(
          and(
            eq(schema.datasetVersions.datasetId, dataset.id),
            inArray(schema.datasetVersions.status, ['ready', 'building']),
            sql`${schema.datasetVersions.createdAt} >= ${tsParam(item.createdAt.toISOString())}`,
          ),
        );
      if (Number(ref.n) > 0) {
        const [row] = await db
          .update(schema.datasetItems)
          .set({ status: 'excluded', updatedAt: new Date() })
          .where(eq(schema.datasetItems.id, item.id))
          .returning();
        await refreshItemCount(dataset.id);
        return ok({ action: 'excluded', item: toItem(row, null, 0), reason: `${ref.n} version(s) reference this item` });
      }
      await deleteObjects(BUCKET, [item.s3Key]);
      await db.delete(schema.datasetItems).where(eq(schema.datasetItems.id, item.id));
      await refreshItemCount(dataset.id);
      return ok({ action: 'deleted', itemId: item.id });
    }

    case 'GET /datasets/{id}/items/{itemId}/annotations':
    case 'PUT /datasets/{id}/items/{itemId}/annotations': {
      const itemId = event.pathParameters?.itemId;
      if (!itemId) return badRequest('item id required');
      const item = await db.query.datasetItems.findFirst({
        where: and(eq(schema.datasetItems.id, itemId), eq(schema.datasetItems.datasetId, dataset.id)),
      });
      if (!item) return notFound(`Item "${itemId}" not found`);

      if (method === 'GET') {
        const anns = await db
          .select()
          .from(schema.datasetAnnotations)
          .where(eq(schema.datasetAnnotations.itemId, item.id))
          .orderBy(asc(schema.datasetAnnotations.createdAt), asc(schema.datasetAnnotations.id));
        const url = await presignGet(BUCKET, item.s3Key);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ETag: itemEtag(item) },
          body: JSON.stringify({ item: toItem(item, url, anns.length), annotations: anns.map(toAnnotation), etag: itemEtag(item) }),
        };
      }

      // PUT: replace-all. If-Match carries the etag the client last saw, so
      // two tabs cannot silently overwrite each other (412 on mismatch).
      const ifMatch = event.headers['if-match'] ?? event.headers['If-Match'];
      if (!ifMatch) return badRequest('If-Match header required (the item etag from the last read)');
      const current = itemEtag(item);
      const matches = ifMatch === '*' || ifMatch.split(',').some((t) => t.trim() === current || t.trim() === current.slice(2));
      if (!matches) {
        return errorResponse(412, 'PRECONDITION_FAILED', 'The item changed since it was read; reload and try again', {
          etag: current,
        });
      }
      const parsed = putAnnotationsSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      for (const [i, a] of parsed.data.annotations.entries()) {
        if (!classIds.has(a.classId)) return badRequest(`Annotation ${i + 1}: unknown class id "${a.classId}"`);
        if (!(a.x2 > a.x1 && a.y2 > a.y1)) return badRequest(`Annotation ${i + 1}: box has no area`);
        if (a.x1 < -0.5 || a.y1 < -0.5 || a.x2 > item.width + 0.5 || a.y2 > item.height + 0.5) {
          return badRequest(`Annotation ${i + 1}: box lies outside the image (${item.width}x${item.height})`);
        }
      }
      const status = parsed.data.status ?? 'labeled';
      const now = new Date();
      const result = await db.transaction(async (tx) => {
        // Sequential awaits: the Data API serializes statements in a transaction.
        await tx.delete(schema.datasetAnnotations).where(eq(schema.datasetAnnotations.itemId, item.id));
        let inserted: AnnotationRow[] = [];
        if (parsed.data.annotations.length > 0) {
          inserted = await tx
            .insert(schema.datasetAnnotations)
            .values(
              parsed.data.annotations.map((a) => ({
                itemId: item.id,
                classId: a.classId,
                x1: Math.max(0, a.x1),
                y1: Math.max(0, a.y1),
                x2: Math.min(item.width, a.x2),
                y2: Math.min(item.height, a.y2),
                source: a.source ?? 'human',
                sourceRef: a.sourceRef ?? null,
                confidence: a.confidence ?? null,
                createdByUserId: auth.userId,
              })),
            )
            .returning();
        }
        const [updated] = await tx
          .update(schema.datasetItems)
          .set({
            status,
            labeledByUserId: status === 'labeled' ? auth.userId : item.labeledByUserId,
            labeledAt: status === 'labeled' ? now : item.labeledAt,
            updatedAt: now,
          })
          .where(eq(schema.datasetItems.id, item.id))
          .returning();
        return { inserted, updated };
      });
      await refreshItemCount(dataset.id);
      const etag = itemEtag(result.updated);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ETag: etag },
        body: JSON.stringify({
          item: toItem(result.updated, null, result.inserted.length),
          annotations: result.inserted.map(toAnnotation),
          etag,
        }),
      };
    }

    case 'GET /datasets/{id}/imports': {
      const rows = await db
        .select()
        .from(schema.datasetImports)
        .where(eq(schema.datasetImports.datasetId, dataset.id))
        .orderBy(desc(schema.datasetImports.createdAt))
        .limit(100);
      return ok({ imports: rows.map(toImport) });
    }

    case 'POST /datasets/{id}/imports': {
      const parsed = createImportSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      if (parsed.data.everySeconds !== undefined && parsed.data.fps !== undefined) {
        return badRequest('Give either everySeconds or fps, not both');
      }
      if (parsed.data.from && parsed.data.to && Date.parse(parsed.data.from) >= Date.parse(parsed.data.to)) {
        return badRequest('"from" must be earlier than "to"');
      }
      const sessions = await findOrgSessions([parsed.data.sessionId], orgId);
      if (sessions.length === 0) return notFound(`Session "${parsed.data.sessionId}" not found`);
      if (dataset.itemCount >= MAX_ITEMS_PER_DATASET) {
        return conflict(`A dataset holds at most ${MAX_ITEMS_PER_DATASET} items (${dataset.itemCount} now)`);
      }
      const { kind, ...params } = parsed.data;
      const [row] = await db
        .insert(schema.datasetImports)
        .values({ datasetId: dataset.id, kind, params, status: 'queued', createdByUserId: auth.userId })
        .returning();
      try {
        await enqueueModelJob({ kind: 'import', importId: row.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(schema.datasetImports)
          .set({ status: 'failed', error: `enqueue failed: ${message}`, endedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.datasetImports.id, row.id));
        return errorResponse(502, 'IMPORT_DISPATCH_FAILED', 'Failed to queue the import', { importId: row.id, message });
      }
      return created({ import: toImport(row) });
    }

    case 'GET /datasets/{id}/imports/{importId}': {
      const importId = event.pathParameters?.importId;
      if (!importId) return badRequest('import id required');
      const row = await db.query.datasetImports.findFirst({
        where: and(eq(schema.datasetImports.id, importId), eq(schema.datasetImports.datasetId, dataset.id)),
      });
      if (!row) return notFound(`Import "${importId}" not found`);
      return ok({ import: toImport(row) });
    }

    case 'GET /datasets/{id}/versions': {
      const rows = await db
        .select()
        .from(schema.datasetVersions)
        .where(eq(schema.datasetVersions.datasetId, dataset.id))
        .orderBy(desc(schema.datasetVersions.version));
      return ok({ versions: rows.map((v) => toVersion(v)) });
    }

    case 'POST /datasets/{id}/versions': {
      const parsed = createVersionSchema.safeParse(safeJson(event.body));
      if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
      const cfg = parsed.data;
      if (!(cfg.split.train + cfg.split.val + cfg.split.test > 0)) return badRequest('split fractions must sum to a positive number');
      if (classes.length === 0) return badRequest('The dataset has no classes');
      const building = await db
        .select({ id: schema.datasetVersions.id })
        .from(schema.datasetVersions)
        .where(and(eq(schema.datasetVersions.datasetId, dataset.id), eq(schema.datasetVersions.status, 'building')));
      if (building.length > 0) return conflict('A version of this dataset is already building');
      const [last] = await db
        .select({ v: sql<number | null>`max(${schema.datasetVersions.version})` })
        .from(schema.datasetVersions)
        .where(eq(schema.datasetVersions.datasetId, dataset.id));
      const version = (last?.v === null || last?.v === undefined ? 0 : Number(last.v)) + 1;
      const config = { split: cfg.split, seed: cfg.seed, keepPrevious: cfg.keepPrevious, includeAiLabeled: cfg.includeAiLabeled };
      // The health check runs here, on the same inputs the builder will read,
      // so an unhealthy version is refused before a row or a prefix exists.
      const { prepared } = await prepareVersionFromDb(BUCKET, dataset, version, config);
      if (!prepared.health.ok) {
        return errorResponse(400, 'DATASET_VERSION_UNHEALTHY', prepared.health.errors.map((e) => e.message).join('; '), {
          health: prepared.health,
          stats: prepared.stats,
        });
      }
      const [row] = await db
        .insert(schema.datasetVersions)
        .values({
          datasetId: dataset.id,
          version,
          message: cfg.message ?? null,
          splitConfig: config,
          classNames: prepared.classNames,
          stats: prepared.stats,
          health: prepared.health,
          s3Prefix: datasetVersionPrefix(dataset.id, version),
          status: 'building',
          createdByUserId: auth.userId,
        })
        .returning();
      try {
        await enqueueModelJob({ kind: 'version_build', versionId: row.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(schema.datasetVersions)
          .set({ status: 'failed', error: `enqueue failed: ${message}`, updatedAt: new Date() })
          .where(eq(schema.datasetVersions.id, row.id));
        return errorResponse(502, 'VERSION_DISPATCH_FAILED', 'Failed to queue the version build', { versionId: row.id, message });
      }
      return created({ version: toVersion(row), preview: { splitCounts: prepared.splitCounts, droppedBoxes: prepared.droppedBoxes } });
    }

    case 'GET /datasets/{id}/versions/{version}': {
      const raw = event.pathParameters?.version;
      if (!raw || !/^\d+$/.test(raw)) return badRequest('version must be a positive integer');
      const row = await db.query.datasetVersions.findFirst({
        where: and(eq(schema.datasetVersions.datasetId, dataset.id), eq(schema.datasetVersions.version, Number(raw))),
      });
      if (!row) return notFound(`Version ${raw} not found`);
      let files: Record<string, string> | null = null;
      if (row.status === 'ready') {
        files = {};
        for (const name of VERSION_FILES) {
          const key = `${row.s3Prefix}${name}`;
          if (!isKeyUnder(datasetVersionPrefix(dataset.id, row.version), key)) continue; // the gate, by construction true
          files[name] = await presignGet(BUCKET, key, { downloadName: name });
        }
      }
      return ok({ version: toVersion(row, files) });
    }

    default:
      return methodNotAllowed(method, 'GET, POST, PUT, PATCH, DELETE');
  }
};

export const handler = apiHandler(restHandler);
