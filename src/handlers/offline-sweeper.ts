import { sql } from 'drizzle-orm';
import { db } from '../db/index';

/**
 * Offline sweeper (P2). Invoked by an EventBridge schedule (~1 min). Flips
 * devices that stopped reporting from `online` → `offline`. Only touches
 * `online` rows, so `provisioned`/`decommissioned` are never affected. Pure
 * server-side time (no timestamptz bind needed); idempotent.
 */
export const handler = async (): Promise<void> => {
  await db.execute(sql`
    UPDATE devices
    SET status = 'offline', updated_at = now()
    WHERE status = 'online'
      AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')
  `);
};
