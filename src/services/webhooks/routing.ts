import { and, eq, sql } from 'drizzle-orm';
import { schema } from '../../db/index';
import { textArrayParam } from '../../utils/sql';
import type { WebhookDb } from './emit';

/**
 * Which endpoints an outbox row goes to (README D1/D4):
 *
 * - `endpointId` set (workflow.event resolved from the node's `webhook` name
 *   at finalize, and ping): that endpoint, if it is enabled and in the event's
 *   organization.
 * - otherwise: the `webhook_routes` rows for `data.deviceId` whose
 *   `event_types` contain the type, joined to ENABLED endpoints of the same
 *   organization.
 *
 * Returns distinct endpoint ids; empty means "unrouted" (logged, not an error).
 */
export interface RoutableEvent {
  type: string;
  organizationId: string;
  endpointId: string | null;
  data: Record<string, unknown>;
}

export async function resolveEndpoints(dbx: WebhookDb, event: RoutableEvent): Promise<string[]> {
  const e = schema.webhookEndpoints;
  if (event.endpointId) {
    const rows = await dbx
      .select({ id: e.id })
      .from(e)
      .where(and(eq(e.id, event.endpointId), eq(e.organizationId, event.organizationId), eq(e.enabled, true)));
    return rows.map((r) => r.id);
  }
  const deviceId = event.data.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) return [];
  const r = schema.webhookRoutes;
  const rows = await dbx
    .selectDistinct({ id: r.endpointId })
    .from(r)
    .innerJoin(e, eq(e.id, r.endpointId))
    .where(
      and(
        eq(r.deviceId, deviceId),
        eq(e.organizationId, event.organizationId),
        eq(e.enabled, true),
        sql`${r.eventTypes} @> ${textArrayParam([event.type])}`,
      ),
    );
  return rows.map((row) => row.id);
}
