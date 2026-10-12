import { randomUUID } from 'node:crypto';
import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { iotDataClient } from './iot-data';

/**
 * Cloud -> device one-shot commands. Publishes to
 * `xorgate/devices/{deviceId}/command`, NOT retained, QoS 1.
 *
 * Deliberately not the config plane (see plans/two-way-sync-config, which rules
 * imperative actions out of config): config is desired state and is retained so
 * an offline device converges on reconnect. A command is one-shot — retaining a
 * reboot would replay it on every reconnect, i.e. a boot loop. Non-retained
 * means a command published to an offline device is dropped, which is what we
 * want: you only reboot a device that is online right now, and callers check
 * that before publishing.
 *
 * Every command carries `ts` + `expiresAt`. The device refuses anything past
 * `expiresAt` (clamped device-side to its own ceiling) and separately refuses a
 * requestId it has already executed, using a ledger it persists across the
 * reboot. Belt and braces, because a surprise reboot on a fielded device is
 * expensive.
 *
 * The device IoT policy already allows subscribe/receive on
 * `xorgate/devices/${thingName}/*` (thingName = deviceId), so no device policy
 * change is needed. The Lambda role needs `iot:Publish` on the command topic
 * (granted in api-stack.ts). No `iot:RetainPublish` — we never retain here.
 */

/**
 * `refresh` (manage_sim_card_info plan, Phase 2 §4d) is the one read-only
 * command: it asks the device to re-probe what it can (SIM identity, applied
 * APN, antenna bias) and publish a fresh config report NOW instead of on the
 * hourly heartbeat. Same one-shot semantics as the others — an offline device
 * misses it, which is fine, because a refresh of a device that cannot report
 * is meaningless.
 */
/**
 * `update` (device_update_management plan, Phase 3) asks the device to install
 * the latest published agent build: it starts a one-shot systemd unit that runs
 * `xorgate update` as root, then restarts the agent. Latest-only by design —
 * there is no version argument, because pinning would require a wildcard
 * sudoers grant on the device, i.e. arbitrary root installs.
 *
 * Completion is NOT observable from the ack (the agent is restarted mid-update,
 * and nothing consumes `command/response` yet): the outcome signal is the new
 * build in the device's next config report, mirrored to `devices.agent_version`.
 */
/**
 * `read_sms` (plans/device-sms-inbox) asks the agent to read the modem's stored
 * SMS over its spare AT port (non-destructively) and publish the newest
 * `args.limit` on `xorgate/devices/{id}/sms`. The only command that carries
 * `args`, and the only one whose requestId is caller-supplied: it is the
 * `device_sms_reads` row id the reply is matched against.
 */
/**
 * `clear_sms` (plans/device-sms-clear) asks the agent to DELETE every stored
 * SMS (`AT+CMGD=0,4` on SM, then ME), then run a normal sweep and reply on the
 * same `xorgate/devices/{id}/sms` topic with it, proving the stores are empty.
 * Same `args.limit` (the follow-up sweep's size) and the same caller-supplied
 * requestId (a `device_sms_reads` row with `action = 'clear'`) as `read_sms`.
 */
export type DeviceCommandName = 'reboot' | 'power_off' | 'refresh' | 'update' | 'read_sms' | 'clear_sms';

/**
 * How long a command stays valid. Generous next to a sub-second publish, tight
 * enough that a command stalled behind a degraded link expires instead of
 * landing minutes later on a device whose operator has moved on. The device
 * clamps anything longer than its own MAX_TTL_MS (120s) regardless.
 */
export const COMMAND_TTL_MS = 60_000;

export interface DeviceCommandMessage {
  v: 1;
  requestId: string;
  command: DeviceCommandName;
  ts: number;
  expiresAt: number;
  /** Command parameters. Omitted unless the caller passes some (only `read_sms` / `clear_sms` do). */
  args?: Record<string, unknown>;
}

export interface PublishDeviceCommandOptions {
  /** Parameters for the command; the device ignores them for every command but `read_sms` / `clear_sms`. */
  args?: Record<string, unknown>;
  /** Use this requestId instead of minting one (the caller's correlation row id). */
  requestId?: string;
}

/**
 * Publish a one-shot command to a device. Returns the issued message so the
 * caller can echo requestId/expiresAt back to the client. Throws on failure.
 */
export async function publishDeviceCommand(
  deviceId: string,
  command: DeviceCommandName,
  options: PublishDeviceCommandOptions = {},
): Promise<DeviceCommandMessage> {
  const ts = Date.now();
  const message: DeviceCommandMessage = {
    v: 1,
    requestId: options.requestId ?? randomUUID(),
    command,
    ts,
    expiresAt: ts + COMMAND_TTL_MS,
    ...(options.args ? { args: options.args } : {}),
  };
  const client = await iotDataClient();
  await client.send(
    new PublishCommand({
      topic: `xorgate/devices/${deviceId}/command`,
      qos: 1,
      retain: false,
      payload: Buffer.from(JSON.stringify(message)),
    }),
  );
  return message;
}
