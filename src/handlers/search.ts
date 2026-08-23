import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import {
  AuthError,
  authErrorResponse,
  requireOrgContext,
} from '../middleware/auth';
import { db, schema } from '../db/index';
import { isWorkspaceScoped, resolveWorkspaceScope } from '../services/workspace-scope';
import { methodNotAllowed, ok } from '../utils/responses';
import { apiHandler } from '../utils/api-handler';

// Global cross-resource search. `GET /search?q=<term>` returns a flat, normalized
// list of results the caller's org can see. The result shape is intentionally
// generic so the web UI renders any resource type from one code path and adding a
// new searchable resource is a single query block here (+ one FE registry entry):
//
//   { type, id, title, subtitle }
//
// Tenant isolation mirrors the other handlers: org-scoped tables (workflow
// templates) filter by organizationId; workspace-owned tables (devices, runs)
// filter by workspaceId IN <the org's workspaces>.

type SearchResultType = 'device' | 'workflow-template' | 'workflow-instance';

interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle: string | null;
}

// Max hits returned per resource type. Keeps the palette snappy and the payload
// small; the UI is a jump-to-detail navigator, not a full result browser.
const PER_TYPE_LIMIT = 6;

// Escape LIKE/ILIKE wildcards so a user typing "%" or "_" matches literally
// (default ESCAPE is backslash).
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  if (method !== 'GET') return methodNotAllowed(method, 'GET');

  let auth;
  try {
    auth = await requireOrgContext(event);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const q = event.queryStringParameters?.q?.trim();
  if (!q || q.length < 2) return ok({ results: [] });
  const pat = `%${escapeLike(q)}%`;

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  const hasWorkspaces = orgWorkspaceIds.length > 0;

  const [devices, templates, runs] = await Promise.all([
    // Devices (workspace-owned): match name or serial.
    hasWorkspaces
      ? db.query.devices.findMany({
          where: and(
            inArray(schema.devices.workspaceId, orgWorkspaceIds),
            or(ilike(schema.devices.name, pat), ilike(schema.devices.serial, pat)),
          ),
          columns: { id: true, name: true, serial: true },
          orderBy: [desc(schema.devices.updatedAt)],
          limit: PER_TYPE_LIMIT,
        })
      : Promise.resolve([]),

    // Workflow templates (org-scoped): match name, slug, or description.
    //
    // Suppressed entirely for a workspace-scoped session token. Templates have
    // no workspace column, so there is nothing to intersect: the choice is
    // "every template in the consumer's organization" or "none". Search is the
    // one endpoint where an org-wide resource rides along with scoped ones, and
    // silently returning a tenant every other organization-wide route refuses
    // would make this the hole in the boundary. The devices and runs sections
    // are unaffected.
    isWorkspaceScoped(auth)
      ? Promise.resolve([])
      : db.query.workflowTemplates.findMany({
          where: and(
            eq(schema.workflowTemplates.organizationId, auth.organizationId),
            or(
              ilike(schema.workflowTemplates.name, pat),
              ilike(schema.workflowTemplates.slug, pat),
              ilike(schema.workflowTemplates.description, pat),
            ),
          ),
          columns: { id: true, name: true, slug: true },
          orderBy: [desc(schema.workflowTemplates.updatedAt)],
          limit: PER_TYPE_LIMIT,
        }),

    // Workflow runs (workspace-owned, joined): match template name, device name,
    // or device serial. Reuses the join shape from workflow-runs.ts.
    hasWorkspaces
      ? db
          .select({
            id: schema.workflowRuns.id,
            templateName: schema.workflowTemplates.name,
            deviceName: schema.devices.name,
            serial: schema.devices.serial,
          })
          .from(schema.workflowRuns)
          .innerJoin(
            schema.workflowTemplates,
            eq(schema.workflowTemplates.id, schema.workflowRuns.templateId),
          )
          .innerJoin(
            schema.devices,
            eq(schema.devices.id, schema.workflowRuns.deviceId),
          )
          .where(
            and(
              inArray(schema.workflowRuns.workspaceId, orgWorkspaceIds),
              or(
                ilike(schema.workflowTemplates.name, pat),
                ilike(schema.devices.name, pat),
                ilike(schema.devices.serial, pat),
              ),
            ),
          )
          .orderBy(desc(schema.workflowRuns.startedAt))
          .limit(PER_TYPE_LIMIT)
      : Promise.resolve([]),
  ]);

  const results: SearchResult[] = [
    ...devices.map((d): SearchResult => ({
      type: 'device',
      id: d.id,
      title: d.name ?? d.serial,
      subtitle: d.serial,
    })),
    ...templates.map((t): SearchResult => ({
      type: 'workflow-template',
      id: t.id,
      title: t.name,
      subtitle: t.slug,
    })),
    ...runs.map((r): SearchResult => ({
      type: 'workflow-instance',
      id: r.id,
      title: r.templateName,
      subtitle: r.deviceName ?? r.serial,
    })),
  ];

  return ok({ results });
};

export const handler = apiHandler(restHandler);
