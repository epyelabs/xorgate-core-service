import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { uuidParam } from '../utils/sql';

/**
 * Device SMS read RESULT ingest (plans/device-sms-inbox, Phase 2; payload shape
 * is binding in contract.md §2). Invoked directly by the AWS IoT Topic Rule
 *
 *   SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/sms'
 *
 * so the `event` IS the device's payload plus `topicDeviceId`, not an API
 * Gateway event.
 *
 * The reply is matched to its `device_sms_reads` row by `requestId` AND the
 * device id from the TOPIC (the device IoT policy scopes publish to its own
 * thing name; the body's `deviceId` is not trusted). Only a row in `pending`
 * or `expired` is written:
 *
 * - `pending`: the normal case.
 * - `expired`: a slow device (the GET marked the row timed out at 45 s, but
 *   the sweep still finished inside the command's 60 s TTL). Its result is
 *   real and newer than the stored copy, so it lands (contract.md §2).
 * - `ok` / `error`: a duplicate (QoS 1 redelivery) or a replay. Dropped.
 *
 * A reply from another device, or for an unknown/deleted row, matches nothing
 * and is dropped.
 *
 * Retention (contract.md §5, no scheduled task anywhere): after storing an
 * `ok` result, delete every row of that device created BEFORE this one (old
 * results, old failures, old expired requests). Rows created after it (a read
 * started later, still pending) survive. An `error` deletes nothing.
 *
 * Statements are strictly sequential (the Data API driver cannot run two at
 * once). A bad payload logs and drops; a DB error throws so the async-invoke
 * retries get another go (a lost reply only costs the user a retry).
 *
 * PRIVACY: never log message text or sender numbers. Counts, status, ids and
 * durations only.
 */

/** IoT's own message ceiling; anything larger is not an honest agent reply. */
export const MAX_SMS_RESULT_BYTES = 128 * 1024;

const messageSchema = z.object({
  id: z.string().max(200),
  storage: z.string().max(8),
  indexes: z.array(z.number().int()).max(32),
  from: z.string().max(64),
  fromType: z.string().max(32),
  sentAt: z.string().max(64).nullable(),
  unread: z.boolean(),
  text: z.string().max(16_000),
  binary: z.boolean().optional().default(false),
  incomplete: z.boolean().optional().default(false),
  truncated: z.boolean().optional().default(false),
});

const storeSchema = z.object({ used: z.number().int().min(0), total: z.number().int().min(0) });

const resultSchema = z.object({
  v: z.literal(1),
  deviceId: z.string().optional(),
  requestId: z.string().uuid(),
  ts: z.number(),
  /** ok | no_modem | no_sim | modem_busy | error. Kept open: any non-ok is an error. */
  status: z.string().min(1).max(32),
  error: z.string().max(500).nullable().optional(),
  durationMs: z.number().min(0).optional(),
  storage: z.record(z.string().max(8), storeSchema).optional().default({}),
  total: z.number().int().min(0).optional().default(0),
  skipped: z.number().int().min(0).optional().default(0),
  partial: z.boolean().optional().default(false),
  messages: z.array(messageSchema).max(50).optional().default([]),
});

export type DeviceSmsResult = z.infer<typeof resultSchema>;

export const handler = async (event: unknown): Promise<void> => {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(event ?? null), 'utf8');
  } catch {
    console.error('device-sms-result: unserializable payload, dropping');
    return;
  }
  if (bytes > MAX_SMS_RESULT_BYTES) {
    console.error('device-sms-result: payload too large, dropping', { bytes });
    return;
  }

  const topicDeviceId = (event as { topicDeviceId?: unknown } | null)?.topicDeviceId;
  if (typeof topicDeviceId !== 'string' || topicDeviceId.length === 0) {
    console.error('device-sms-result: missing topic deviceId, dropping');
    return;
  }

  const parsed = resultSchema.safeParse(event);
  if (!parsed.success) {
    // Issue paths and codes only: zod messages can echo values (text, numbers).
    console.error('device-sms-result: invalid payload, dropping', {
      deviceId: topicDeviceId,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
    return;
  }
  const reply = parsed.data;
  const deviceId = topicDeviceId;
  if (reply.deviceId && reply.deviceId !== deviceId) {
    console.error('device-sms-result: deviceId/topic mismatch, dropping', {
      topicDeviceId: deviceId,
      requestId: reply.requestId,
    });
    return;
  }

  const isOk = reply.status === 'ok';
  const updated = await db
    .update(schema.deviceSmsReads)
    .set(
      isOk
        ? {
            status: 'ok',
            errorCode: null,
            errorMessage: null,
            result: {
              storage: reply.storage,
              total: reply.total,
              skipped: reply.skipped,
              partial: reply.partial,
              durationMs: reply.durationMs ?? null,
              messages: reply.messages,
            },
            completedAt: new Date(),
          }
        : {
            status: 'error',
            errorCode: reply.status,
            errorMessage: reply.error ?? null,
            result: null,
            completedAt: new Date(),
          },
    )
    .where(
      and(
        eq(schema.deviceSmsReads.id, reply.requestId),
        eq(schema.deviceSmsReads.deviceId, deviceId),
        inArray(schema.deviceSmsReads.status, ['pending', 'expired']),
      ),
    )
    .returning({ id: schema.deviceSmsReads.id });

  if (updated.length === 0) {
    console.log('device-sms-result: no pending row matched (late, duplicate, unknown or other device)', {
      deviceId,
      requestId: reply.requestId,
      status: reply.status,
    });
    return;
  }

  console.log('device-sms-result: stored', {
    deviceId,
    requestId: reply.requestId,
    status: reply.status,
    count: reply.messages.length,
    total: reply.total,
    partial: reply.partial,
    durationMs: reply.durationMs,
  });
  if (!isOk) return;

  // Keep only this read and anything requested after it. Compared in SQL
  // against the row's own created_at, so no timestamp round-trips the driver.
  const t = schema.deviceSmsReads;
  const removed = await db
    .delete(t)
    .where(
      and(
        eq(t.deviceId, deviceId),
        sql`${t.createdAt} < (select ${t.createdAt} from ${t} where ${t.id} = ${uuidParam(reply.requestId)})`,
      ),
    )
    .returning({ id: t.id });
  if (removed.length > 0) {
    console.log('device-sms-result: removed older reads', { deviceId, removed: removed.length });
  }
};
