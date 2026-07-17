import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { iotDataClient } from './iot-data';

/**
 * Cloud -> device config delivery. Publishes the device's full config object
 * to `xorgate/devices/{deviceId}/config` with the MQTT retain flag, so an
 * offline device receives the latest config on its next connect — no shadow
 * service or reconciliation loop. The payload is the complete config (not a
 * delta) so redelivery is idempotent and self-contained.
 *
 * The device IoT policy already allows subscribe/receive on
 * `xorgate/devices/${thingName}/*` (thingName = deviceId), so no policy change
 * is needed device-side. The Lambda role needs `iot:Publish` on the config
 * topic (granted in api-stack.ts).
 */

export interface ImuMountConfig {
  enabled: boolean;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

export interface DeviceConfigMessage {
  v: 1;
  gnssAntBias: boolean;
  /** Omitted (not null) when the device has never had a mount configured. */
  imuMount?: ImuMountConfig;
  ts: number;
}

/** Publish the retained per-device config message. Throws on failure. */
export async function publishDeviceConfig(
  deviceId: string,
  config: { gnssAntBias: boolean; imuMount?: ImuMountConfig | null },
): Promise<void> {
  const message: DeviceConfigMessage = {
    v: 1,
    gnssAntBias: config.gnssAntBias,
    ...(config.imuMount ? { imuMount: config.imuMount } : {}),
    ts: Date.now(),
  };
  const client = await iotDataClient();
  await client.send(
    new PublishCommand({
      topic: `xorgate/devices/${deviceId}/config`,
      qos: 1,
      retain: true,
      payload: Buffer.from(JSON.stringify(message)),
    }),
  );
}
