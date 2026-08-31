import type { Organization, Workspace } from '../db/schema';
import { imageUrl } from './images';

/**
 * How an organization or a workspace goes onto the wire.
 *
 * Both rows used to be serialized verbatim, and every handler that returned
 * one just handed drizzle's object to `ok()`. That stopped being right when
 * they grew a `logo_key`: the key names a private S3 object, so what a client
 * needs is a presigned GET minted for this response, not the key itself. The
 * translation lives here rather than in each handler because three of them
 * (`organizations.ts`, `workspaces.ts`, `me.ts`) return these rows, and a
 * fourth that forgot to strip the key would leak it silently.
 *
 * Everything else about the shape is unchanged — same fields, same casing — so
 * existing clients and the SDK's normalizers see exactly what they did before,
 * plus `logoUrl`.
 */

export interface OrganizationView extends Omit<Organization, 'logoKey'> {
  /** Presigned GET, valid one hour. Null when the organization has no logo. */
  logoUrl: string | null;
}

export interface WorkspaceView extends Omit<Workspace, 'logoKey'> {
  /** Presigned GET, valid one hour. Null when the workspace has no logo. */
  logoUrl: string | null;
}

export async function organizationView(row: Organization): Promise<OrganizationView> {
  const { logoKey, ...rest } = row;
  return { ...rest, logoUrl: await imageUrl(logoKey) };
}

export async function workspaceView(row: Workspace): Promise<WorkspaceView> {
  const { logoKey, ...rest } = row;
  return { ...rest, logoUrl: await imageUrl(logoKey) };
}

/**
 * Presigning is local signing, not a network call, so a page of rows costs
 * nothing extra to sign in parallel.
 */
export function organizationViews(rows: Organization[]): Promise<OrganizationView[]> {
  return Promise.all(rows.map(organizationView));
}

export function workspaceViews(rows: Workspace[]): Promise<WorkspaceView[]> {
  return Promise.all(rows.map(workspaceView));
}
