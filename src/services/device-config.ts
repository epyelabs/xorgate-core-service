import { IoTClient, DescribeEndpointCommand } from '@aws-sdk/client-iot';
import {
  IoTDataPlaneClient,
  PublishCommand,
} from '@aws-sdk/client-iot-data-plane';

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

export interface DeviceConfigMessage {
  v: 1;
  gnssAntBias: boolean;
  ts: number;
}

// The default IoTDataPlaneClient endpoint is the legacy (non-ATS) data
// endpoint, which devices' Amazon Root CA1 trust does not chain to. Resolve
// the account's ATS endpoint once per container and reuse it.
let dataClientPromise: Promise<IoTDataPlaneClient> | undefined;

async function dataClient(): Promise<IoTDataPlaneClient> {
  if (!dataClientPromise) {
    dataClientPromise = (async () => {
      const iot = new IoTClient({});
      const res = await iot.send(
        new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }),
      );
      if (!res.endpointAddress) {
        throw new Error('DescribeEndpoint returned no iot:Data-ATS address');
      }
      return new IoTDataPlaneClient({ endpoint: `https://${res.endpointAddress}` });
    })();
    // A failed resolution must not poison later invocations of a warm container.
    dataClientPromise.catch(() => {
      dataClientPromise = undefined;
    });
  }
  return dataClientPromise;
}

/** Publish the retained per-device config message. Throws on failure. */
export async function publishDeviceConfig(
  deviceId: string,
  config: { gnssAntBias: boolean },
): Promise<void> {
  const message: DeviceConfigMessage = {
    v: 1,
    gnssAntBias: config.gnssAntBias,
    ts: Date.now(),
  };
  const client = await dataClient();
  await client.send(
    new PublishCommand({
      topic: `xorgate/devices/${deviceId}/config`,
      qos: 1,
      retain: true,
      payload: Buffer.from(JSON.stringify(message)),
    }),
  );
}
