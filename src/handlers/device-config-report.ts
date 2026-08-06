import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { publishDeviceConfig } from '../services/device-config';
import type { DeviceConfigDocument } from '../config-registry/index';

/**
 * Device config REPORT mirror (improve_device_settings_management, Phase 3).
 * Invoked directly by the AWS IoT Topic Rule
 *
 *   SELECT *, topic(3) AS topicDeviceId FROM 'xorgate/devices/+/config/reported'
 *
 * so the `event` IS the report payload (plus `topicDeviceId` injected by the
 * rule), NOT an API Gateway event. There is no HTTP auth context.
 *
 * This is the half of the config plane the system never had: until now the
 * cloud could say a setting was *saved*, never that it was *in force*. The
 * device publishes what it actually holds after every apply, on connect, and
 * hourly; we mirror that into `devices.reported_config` / `reported_at`, and
 * `GET /devices/{id}` serves it. `pending` is COMPUTED by the reader
 * (`config_rev > reported.rev && device online`) rather than stored, so it can
 * never go stale in the row.
 *
 * The second job is self-healing. A publish that failed after the DB commit
 * used to leave the device permanently behind with nothing but a 502 telling
 * the operator to "re-save to retry" (`handlers/devices.ts`). Now any report
 * whose `rev` trails `config_rev` triggers a republish of the retained desired
 * document, so the divergence closes on the device's own next report.
 *
 * Error semantics mirror telemetry-ingest (IoT rule lambda actions are async
 * invokes): unrecoverable/bad payloads log and drop; a transient DB error
 * throws so the async-retry path and the DLQ can recover the message. A failed
 * REPUBLISH deliberately does not throw — the report itself is already stored,
 * and re-running the whole handler would only rewrite the same row; the next
 * report retries the republish anyway.
 */

const namespaceStatusSchema = z.object({
  state: z.enum(['applied', 'adjusted', 'rejected']),
  /** Epoch ms the device determined this verdict. */
  at: z.number().optional(),
  /** Why an `adjusted` value differs from what was asked for. */
  detail: z.string().max(500).optional(),
  /** Why a namespace was rejected outright. */
  reason: z.string().max(500).optional(),
});

/**
 * `effective` is stored as an OPAQUE document, deliberately not validated
 * against the config registry. The device clamps where the cloud rejects, and
 * its clamp range is wider on purpose (design.md §3) — a value set locally with
 * `xorgate set` can legitimately sit outside what the cloud would accept, and
 * refusing to mirror it would hide exactly the divergence this plane exists to
 * surface. Bounding is by SIZE, below, not by shape.
 */
const reportSchema = z.object({
  v: z.literal(1),
  deviceId: z.string().optional(),
  ts: z.number(),
  /** Last desired rev the device applied; 0 = it has never received one. */
  rev: z.number().int().min(0),
  origin: z.enum(['cloud', 'local', 'boot']),
  effective: z.record(z.string(), z.unknown()).optional(),
  status: z.record(z.string(), namespaceStatusSchema).optional(),
});

export type DeviceConfigReport = z.infer<typeof reportSchema>;

/**
 * Ceiling on a stored report. The honest documents are ~1 KB; this only stops a
 * misbehaving or compromised device from growing its own row without bound.
 */
const MAX_REPORT_BYTES = 32_768;

export const handler = async (event: unknown): Promise<void> => {
  const parsed = reportSchema.safeParse(event);
  if (!parsed.success) {
    console.error('device-config-report: invalid payload, dropping', {
      issues: parsed.error.issues,
    });
    return;
  }

  // The device IoT policy scopes publish to its own thing name (= deviceId), so
  // the topic segment is trustworthy and the in-body one is not.
  const topicDeviceId = (event as { topicDeviceId?: unknown }).topicDeviceId;
  if (typeof topicDeviceId !== 'string' || topicDeviceId.length === 0) {
    console.error('device-config-report: missing topic deviceId, dropping');
    return;
  }
  const deviceId = topicDeviceId;
  if (parsed.data.deviceId && parsed.data.deviceId !== deviceId) {
    console.error('device-config-report: deviceId/topic mismatch, dropping', {
      topicDeviceId: deviceId,
      bodyDeviceId: parsed.data.deviceId,
    });
    return;
  }

  const report: DeviceConfigReport = {
    ...parsed.data,
    deviceId,
    effective: parsed.data.effective ?? {},
    status: parsed.data.status ?? {},
  };
  const serialized = JSON.stringify(report);
  if (serialized.length > MAX_REPORT_BYTES) {
    console.error('device-config-report: report too large, dropping', {
      deviceId,
      bytes: serialized.length,
    });
    return;
  }

  // Last-writer-wins guarded by the DEVICE's own clock: two reports a blink
  // apart can be delivered to concurrent Lambda invocations out of order, and
  // an older one must not overwrite a newer one. `ts` is monotonic within a
  // boot; across a clock step it can jump backwards, which at worst drops one
  // report — the next one (or the hourly heartbeat) repairs it.
  const updated = await db
    .update(schema.devices)
    .set({ reportedConfig: report, reportedAt: new Date() })
    .where(
      and(
        eq(schema.devices.id, deviceId),
        sql`(${schema.devices.reportedConfig} is null
             or coalesce((${schema.devices.reportedConfig}->>'ts')::bigint, 0) <= ${String(report.ts)}::bigint)`,
      ),
    )
    .returning({
      config: schema.devices.config,
      configRev: schema.devices.configRev,
    });

  if (updated.length === 0) {
    // Either the device row is gone (deleted/decommissioned) or this report is
    // older than the one already stored. Neither is retryable, and neither
    // should trigger a republish.
    console.log('device-config-report: no row updated (unknown device or stale report)', {
      deviceId,
      ts: report.ts,
      rev: report.rev,
    });
    return;
  }

  const { config, configRev } = updated[0];
  console.log('device-config-report: stored', {
    deviceId,
    origin: report.origin,
    reportedRev: report.rev,
    configRev,
    states: Object.fromEntries(
      Object.entries(report.status ?? {}).map(([ns, s]) => [ns, s.state]),
    ),
  });

  // origin=local mirroring (fold the device's own edits back into
  // `devices.config`) is PHASE 4. We accept and store such a report today —
  // the UI can already show the divergence — but must not republish over it:
  // that would revert the local edit, which is the exact bug Phase 4 removes.
  if (report.origin === 'local') return;

  if (report.rev >= configRev) return;

  // The device is behind. Republishing the retained desired document is the
  // repair path for a publish that failed after the DB commit, for a retained
  // message the broker dropped, and for a device that applied while the
  // backend was mid-deploy. It terminates on its own: once the device applies
  // it, its next report carries `rev === configRev` and this branch stops
  // firing. A device that CANNOT apply re-triggers at most once per report
  // (on connect + hourly), not in a loop.
  try {
    await publishDeviceConfig(deviceId, config as DeviceConfigDocument, configRev);
    console.log('device-config-report: republished desired config', {
      deviceId,
      reportedRev: report.rev,
      configRev,
    });
  } catch (err) {
    // Not thrown: the report is already mirrored, and a retry of this handler
    // would only rewrite the same row. The next report retries the republish.
    console.error('device-config-report: republish failed', { deviceId, configRev, err });
  }
};
