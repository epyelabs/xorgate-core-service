import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db/index';
import { publishDeviceConfig } from '../services/device-config';
import {
  applyConfigPatch,
  configNamespace,
  validateNamespaceValue,
  type DeviceConfigDocument,
} from '../config-registry/index';
import { legacyConfigColumns } from '../config-registry/legacy-columns';

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
 * The third job (Phase 4) is the reverse direction: an `origin: "local"` report
 * carries the namespaces a local writer changed on the box — `xorgate set`, the
 * manage TUI, a hand-edit with vim — and we fold them into `devices.config`.
 * That is what turns "local tweaks silently diverge and get reverted on
 * reconnect" into "local tweaks show up in the web UI and stick".
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
  /**
   * `origin: "local"` only: the namespaces a local writer changed, as
   * settings.json now holds them (`null` = removed locally, i.e. revert to
   * device defaults). Validated per namespace against the registry before it
   * reaches `devices.config` — unlike `effective`, this becomes the DESIRED
   * document, which must stay something the cloud would itself accept.
   *
   * Deliberately not derived from `effective`: that carries the modem's APPLIED
   * `gnssAntBias`, which lags a local change by up to a poll cycle, so mirroring
   * it would republish the pre-edit value and undo the edit being reported.
   */
  changed: z.record(z.string(), z.unknown()).optional(),
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
  //
  // The installed build rides along in the SAME statement (no extra round
  // trip). Absent — an agent predating the build manifest — leaves the column
  // untouched rather than nulling it, so a mixed-version fleet never loses a
  // version it already knew.
  const agentVersion = reportedAgentVersion(report);
  const updated = await db
    .update(schema.devices)
    .set({
      reportedConfig: report,
      reportedAt: new Date(),
      ...(agentVersion === null ? {} : { agentVersion }),
    })
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

  if (report.origin === 'local') {
    await mirrorLocalChange(deviceId, report, config as DeviceConfigDocument, configRev);
    return;
  }

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

/**
 * The installed agent build out of a report, or null when there isn't a usable
 * one (device_update_management, README §2.3).
 *
 * `effective` is an opaque, DEVICE-AUTHORED document, so this validates rather
 * than trusts: non-empty string only, trimmed, and clamped to 64 chars — long
 * enough for a release tag, short enough that a misbehaving device cannot grow
 * the column. Anything else is treated as absent, which leaves the stored value
 * alone.
 */
export function reportedAgentVersion(report: DeviceConfigReport): string | null {
  const agent = report.effective?.agent;
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  const build = (agent as { build?: unknown }).build;
  if (!build || typeof build !== 'object' || Array.isArray(build)) return null;
  const version = (build as { version?: unknown }).version;
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed;
}

/** Structural equality for two config documents (key order is not meaningful). */
function sameDocument(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameDocument(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && sameDocument(ao[k], bo[k]));
}

/**
 * Fold a device-originated edit back into the desired document
 * (settings-management plan, Phase 4 — design.md §5).
 *
 * The conflict rule (design.md §4) is last-write-wins with CLOUD PRIORITY, made
 * deterministic by the rev: a local report describes the world as of the rev the
 * device had applied when it built the report, so a report whose `rev` no longer
 * matches `config_rev` was overtaken by a cloud PATCH and is DISCARDED. That log
 * line is the diagnostic for "my SSH tweak got clobbered" — the one question an
 * operator will actually ask.
 *
 * The loop guard is the no-op check: a merge that changes nothing neither bumps
 * the rev nor republishes. Without it, device and cloud would trade a report and
 * a republish forever. With it the exchange terminates in one round: we
 * republish, the device applies a JSON-equal document, and its `cloud` report
 * comes back level.
 */
async function mirrorLocalChange(
  deviceId: string,
  report: DeviceConfigReport,
  config: DeviceConfigDocument,
  configRev: number,
): Promise<void> {
  const changed = report.changed ?? {};

  // The conflict check comes FIRST, before looking at what changed: a local
  // report describes the world as of the rev the device had applied, so once
  // that rev is stale the whole report is, whether or not it carries edits.
  if (report.rev !== configRev) {
    if (Object.keys(changed).length > 0) {
      console.warn('device-config-report: local change discarded, cloud config is newer', {
        deviceId,
        reportedRev: report.rev,
        configRev,
        namespaces: Object.keys(changed),
      });
    }
    // The device is behind; the retained document it is about to receive is the
    // authority, and republishing makes sure it actually gets there.
    if (report.rev < configRev) {
      try {
        await publishDeviceConfig(deviceId, config, configRev);
        console.log('device-config-report: republished desired config', {
          deviceId,
          reportedRev: report.rev,
          configRev,
        });
      } catch (err) {
        console.error('device-config-report: republish failed', { deviceId, configRev, err });
      }
    }
    return;
  }

  if (Object.keys(changed).length === 0) {
    // A local report with nothing to merge: an agent that predates `changed`,
    // or an edit reverted before the report went out. Storing it was the job.
    console.log('device-config-report: local report carried no changes', { deviceId });
    return;
  }

  // Validate before storing. `effective` is mirrored opaquely because it only
  // ever DESCRIBES the device, but this becomes the desired document that every
  // future PATCH edits and that the publisher serializes — an unvalidated value
  // here would poison it. The device's clamp range is deliberately wider than
  // the cloud's, so a rejection is possible and must not lose the rest.
  const patch: Record<string, unknown> = {};
  for (const [ns, value] of Object.entries(changed)) {
    if (!configNamespace(ns)) {
      console.warn('device-config-report: unknown namespace in local change, skipping', {
        deviceId,
        namespace: ns,
      });
      continue;
    }
    const parsed = validateNamespaceValue(ns, value);
    if ('error' in parsed) {
      console.warn('device-config-report: local change rejected by the registry, skipping', {
        deviceId,
        namespace: ns,
        error: parsed.error,
      });
      continue;
    }
    patch[ns] = parsed.value;
  }
  if (Object.keys(patch).length === 0) return;

  const nextConfig = applyConfigPatch(config, patch) as DeviceConfigDocument;
  if (sameDocument(nextConfig, config)) {
    // The loop guard. Reached on every republish round trip, and whenever the
    // device re-asserts something the cloud already stores.
    console.log('device-config-report: local change already matches stored config', {
      deviceId,
      namespaces: Object.keys(patch),
    });
    return;
  }

  const now = new Date();
  const updated = await db
    .update(schema.devices)
    .set({
      config: nextConfig,
      configRev: sql`${schema.devices.configRev} + 1`,
      configUpdatedAt: now,
      updatedAt: now,
      ...legacyConfigColumns(nextConfig),
    })
    // Optimistic guard on the rev we read: a cloud PATCH landing between the
    // read above and this write must win, exactly as if it had arrived first.
    .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.configRev, configRev)))
    .returning({ config: schema.devices.config, configRev: schema.devices.configRev });

  if (updated.length === 0) {
    console.warn('device-config-report: local change lost a race with a cloud write', {
      deviceId,
      configRev,
      namespaces: Object.keys(patch),
    });
    return;
  }

  const row = updated[0];
  console.log('device-config-report: merged local change into desired config', {
    deviceId,
    namespaces: Object.keys(patch),
    configRev: row.configRev,
  });

  // Republish so the retained document matches the row again. The device
  // applies it as a no-op (it is already holding these values) and reports
  // `cloud` at the new rev, which closes the exchange.
  try {
    await publishDeviceConfig(deviceId, row.config as DeviceConfigDocument, row.configRev);
  } catch (err) {
    // Same reasoning as the self-heal path: the row is written, and the
    // device's next report re-triggers the republish through the `rev` branch.
    console.error('device-config-report: republish after local merge failed', {
      deviceId,
      configRev: row.configRev,
      err,
    });
  }
}
