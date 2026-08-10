import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { and, eq, inArray } from 'drizzle-orm';
import { AuthError, authErrorResponse, requireOrgContext } from '../middleware/auth';
import { db, schema } from '../db/index';
import { accepted, conflict, errorResponse, methodNotAllowed, notFound } from '../utils/responses';
import {
  publishDeviceCommand,
  type DeviceCommandName,
} from '../services/device-command';

async function workspaceIdsForOrg(organizationId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: eq(schema.workspaces.organizationId, organizationId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

const ROUTE_COMMANDS: Record<string, DeviceCommandName> = {
  'POST /devices/{id}/reboot': 'reboot',
  'POST /devices/{id}/power-off': 'power_off',
  'POST /devices/{id}/refresh-state': 'refresh',
  'POST /devices/{id}/update': 'update',
};

/**
 * One-shot device commands. Routes (all -> this Lambda):
 *   POST /devices/{id}/reboot
 *   POST /devices/{id}/power-off
 *   POST /devices/{id}/refresh-state
 *   POST /devices/{id}/update
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
export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const routeKey = event.routeKey; // e.g. "POST /devices/{id}/reboot"
  const deviceId = event.pathParameters?.id;

  const command = ROUTE_COMMANDS[routeKey];
  if (!command) return methodNotAllowed(event.requestContext.http.method, 'POST');
  if (!deviceId) return notFound('Device "" not found');

  let auth;
  try {
    auth =
      command === 'refresh'
        ? await requireOrgContext(event)
        : await requireOrgContext(event, ['owner', 'admin']);
  } catch (err) {
    if (err instanceof AuthError) return authErrorResponse(err);
    throw err;
  }

  const orgWorkspaceIds = await workspaceIdsForOrg(auth.organizationId);
  if (orgWorkspaceIds.length === 0) return notFound(`Device "${deviceId}" not found`);

  const device = await db.query.devices.findFirst({
    where: and(
      eq(schema.devices.id, deviceId),
      inArray(schema.devices.workspaceId, orgWorkspaceIds),
    ),
    columns: { id: true, name: true, serial: true, status: true },
  });
  if (!device) return notFound(`Device "${deviceId}" not found`);

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

  try {
    const message = await publishDeviceCommand(deviceId, command);
    return accepted({
      requestId: message.requestId,
      command: message.command,
      expiresAt: message.expiresAt,
    });
  } catch (err) {
    console.error('device command publish failed', { deviceId, command, err });
    return errorResponse(
      502,
      'COMMAND_PUBLISH_FAILED',
      'Delivering the command to the device failed. Try again.',
    );
  }
};
