import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import type { OrgAuthContext } from '../types/index';

/**
 * The workspace-id set a request is allowed to see.
 *
 * Eleven handlers used to carry a byte-identical private `workspaceIdsForOrg`
 * and filter with `inArray(devices.workspaceId, orgWorkspaceIds)`. That
 * duplication was harmless while the answer was always "every workspace in the
 * organization"; it stops being harmless the moment the answer depends on the
 * credential, because eleven copies is eleven chances to enforce a security
 * boundary in ten places. So the helper moved here and takes the auth context
 * rather than an organization id — the call site can no longer ask the question
 * in a way that loses the scope.
 *
 * Enforcement is an intersection with the filter that already existed, which is
 * the whole reason workspace-as-consumer-tenant was chosen over the
 * alternatives (see the plan README).
 *
 * Note what this does NOT do: it never returns `[auth.allowedWorkspaceId]`
 * unverified. The workspace is re-read against the organization on every
 * request, so a token naming a workspace that has since been deleted resolves to
 * the empty set (and every device lookup 404s) rather than to a live filter over
 * a dangling id.
 */
export async function resolveWorkspaceScope(auth: OrgAuthContext): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where:
      auth.allowedWorkspaceId === null
        ? eq(schema.workspaces.organizationId, auth.organizationId)
        : and(
            eq(schema.workspaces.organizationId, auth.organizationId),
            eq(schema.workspaces.id, auth.allowedWorkspaceId),
          ),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Whether this caller is confined to one workspace.
 *
 * For the handful of places that need to change SHAPE rather than narrow a
 * filter: `GET /search` drops its organization-wide workflow-template section,
 * and `POST /device-registrations` defaults the required `X-Workspace-Id` to the
 * token's own workspace instead of demanding a header the caller has no way to
 * choose differently.
 */
export function isWorkspaceScoped(auth: OrgAuthContext): boolean {
  return auth.allowedWorkspaceId !== null;
}
