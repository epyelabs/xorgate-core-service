import { routeKey as canonicalRouteKey } from '../utils/route';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { resolveWorkspaceScope } from '../services/workspace-scope';
import { accepted, conflict, errorResponse, methodNotAllowed, notFound } from '../utils/responses';
import {
  OBD_SCAN_MIN_INTERVAL_MS,
  publishDeviceCommand,
  type DeviceCommandName,
} from '../services/device-command';
import { deviceDeclaresObd } from '../services/device-config';
import type { MembershipRole } from '../types/index';
import { apiHandler } from '../utils/api-handler';
import { handleDeviceSmsReadRoutes } from './device-sms-reads';

/**
 * On-demand SMS reads (plans/device-sms-inbox) and clears (plans/device-sms-clear):
 * their own gates and shapes, see device-sms-reads.ts.
 */
const SMS_READ_ROUTES = new Set([
  'POST /devices/{id}/sms-reads',
  'POST /devices/{id}/sms/clear',
  'GET /devices/{id}/sms-reads/latest',
  'GET /devices/{id}/sms-reads/{readId}',
]);

const ROUTE_COMMANDS: Record<string, DeviceCommandName> = {
  'POST /devices/{id}/reboot': 'reboot',
  'POST /devices/{id}/power-off': 'power_off',
  'POST /devices/{id}/refresh-state': 'refresh',
  'POST /devices/{id}/update': 'update',
  'POST /devices/{id}/commands/obd-scan': 'obd_scan',
  'POST /devices/{id}/commands/obd-forget': 'obd_forget',
};

/**
 * Role gate per command. `undefined` = any member (the ordinary read gate).
 * Reboot/power-off/update are owner/admin (see the handler comment). The OBD
 * pair (plans/obd2-bluetooth-integration, P3): `obd_scan` is read-only on the
 * device (a bounded Bluetooth discovery, never a pairing) so it takes the
 * member gate like `refresh`; `obd_forget` drops a bond, a reversible write
 * of the same class as a config save, so it takes the ordinary write gate
 * (owner/admin/member) rather than the destructive one.
 */
const COMMAND_ROLES: Partial<Record<DeviceCommandName, MembershipRole[]>> = {
  reboot: ['owner', 'admin'],
  power_off: ['owner', 'admin'],
  update: ['owner', 'admin'],
  obd_forget: ['owner', 'admin', 'member'],
};

/** Commands that exist only for a device whose model declares `peripherals.obd`. */
const OBD_COMMANDS: ReadonlySet<DeviceCommandName> = new Set(['obd_scan', 'obd_forget']);

/**
 * One-shot device commands. Routes (all -> this Lambda):
 *   POST /devices/{id}/reboot
 *   POST /devices/{id}/power-off
 *   POST /devices/{id}/refresh-state
 *   POST /devices/{id}/update
 *   POST /devices/{id}/commands/obd-scan     (member; OBD models only; 1 per 60 s per device)
 *   POST /devices/{id}/commands/obd-forget   (owner/admin/member; OBD models only)
 * plus the SMS-read routes, dispatched to device-sms-reads.ts:
 *   POST /devices/{id}/sms-reads
 *   POST /devices/{id}/sms/clear      (owner/admin; deletes the modem's stored SMS)
 *   GET  /devices/{id}/sms-reads/latest
 *   GET  /devices/{id}/sms-reads/{readId}
 *
 * Reboot/power-off/update are restricted to owner/admin, unlike the other device
 * writes which effectively allow any member. Power-off in particular is not
 * remotely recoverable — someone has to physically walk to the device and press
 * a button — so it gets the same gate as provisioning rather than the ordinary
 * write gate. `update` replaces the software the device runs, which is the same
 * class of decision. `refresh` is READ-ONLY (the device just re-probes and
 * re-reports its state), so it takes the ordinary member gate.
 *
 * Ownership: the device must belong to a workspace in the caller's org (same
 * check as devices.ts / device-sessions.ts); cross-org reads surface as 404.
 */
const restHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const routeKey = canonicalRouteKey(event); // e.g. "POST /devices/{id}/reboot"
  const deviceId = event.pathParameters?.id;

  if (SMS_READ_ROUTES.has(routeKey)) return handleDeviceSmsReadRoutes(event, routeKey, deviceId);

  const command = ROUTE_COMMANDS[routeKey];
  if (!command) return methodNotAllowed(event.requestContext.http.method, 'POST');
  if (!deviceId) return notFound('Device "" not found');

  let auth;
  try {
    auth = await requireOrgContext(event, COMMAND_ROLES[command]);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await resolveWorkspaceScope(auth);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);

  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, deviceId),
      inArray(schema.devices.workspaceId, orgWorkspaceIds),
    ),
    columns: { id: true, name: true, serial: true, status: true, obdScanRequestedAt: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

  // The OBD commands are meaningless on a kit without an OBD reader, and the
  // model is what says a kit has one — the same fence as the `obd` config
  // namespace, with the same 400. Checked before the online test so the
  // answer for a plain device is stable whether or not it is up.
  if (OBD_COMMANDS.has(command) && !(await deviceDeclaresObd(deviceId))) {
    return errorResponse(
      400,
      'NOT_OBD_DEVICE',
      `Device "${device.name ?? device.serial}" is on a model that does not declare ` +
        'peripherals.obd (an OBD-II kit); OBD commands do not apply to it.',
    );
  }

  // Commands are not retained, so publishing to an offline device would drop the
  // message silently and report success. Fail loudly instead. This is a race, not
  // a guarantee — the device can drop off between this check and the publish —
  // but the failure mode of losing that race is just a no-op command.
  if (device.status !== 'online') {
    return conflict(
      `Device "${device.name ?? device.serial}" is ${device.status}. ` +
        'It must be online to accept commands.',
    );
  }

  // `obd_scan` is rate-limited server-side to one per device per 60 s: a
  // discovery stalls the helper's polling while it runs, and a console that
  // re-fires on every render would otherwise keep the vehicle card blank.
  // One conditional UPDATE claims the slot, so two concurrent requests cannot
  // both pass; the slot is handed back if the publish then fails.
  const now = new Date();
  if (command === 'obd_scan') {
    const claimed = await db
      .update(schema.devices)
      .set({ obdScanRequestedAt: now })
      .where(
        and(
          eq(schema.devices.id, deviceId),
          or(
            isNull(schema.devices.obdScanRequestedAt),
            lt(schema.devices.obdScanRequestedAt, new Date(now.getTime() - OBD_SCAN_MIN_INTERVAL_MS)),
          ),
        ),
      )
      .returning({ id: schema.devices.id });
    if (claimed.length === 0) {
      const last = device.obdScanRequestedAt?.getTime() ?? now.getTime();
      const retryAfterMs = Math.max(0, last + OBD_SCAN_MIN_INTERVAL_MS - now.getTime());
      const res = errorResponse(
        429,
        'RATE_LIMITED',
        `An OBD scan was requested for this device less than ${OBD_SCAN_MIN_INTERVAL_MS / 1000} s ago. ` +
          'Wait for its candidates in the config report (effective.obd.scan) before scanning again.',
        { retryAfterMs },
      ) as APIGatewayProxyStructuredResultV2;
      // The SDK's backoff honours Retry-After (seconds); the body carries ms.
      return {
        ...res,
        headers: { ...res.headers, 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
      };
    }
  }

  try {
    const message = await publishDeviceCommand(deviceId, command);
    return accepted({
      requestId: message.requestId,
      command: message.command,
      expiresAt: message.expiresAt,
    });
  } catch (err) {
    console.error('device command publish failed', { deviceId, command, err });
    if (command === 'obd_scan') {
      // The device never heard the request: release the slot so the operator
      // can retry at once instead of waiting out a window nothing used.
      try {
        await db
          .update(schema.devices)
          .set({ obdScanRequestedAt: device.obdScanRequestedAt ?? null })
          .where(eq(schema.devices.id, deviceId));
      } catch (releaseErr) {
        console.error('obd_scan slot release failed', { deviceId, releaseErr });
      }
    }
    return errorResponse(
      502,
      'COMMAND_PUBLISH_FAILED',
      'Delivering the command to the device failed. Try again.',
    );
  }
};

export const handler = apiHandler(restHandler);
