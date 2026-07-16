import { IoTClient, DescribeEndpointCommand } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';

/**
 * Shared IoT data-plane client for cloud -> device publishes.
 *
 * The default IoTDataPlaneClient endpoint is the legacy (non-ATS) data
 * endpoint, which devices' Amazon Root CA1 trust does not chain to. Resolve the
 * account's ATS endpoint once per container and reuse it.
 *
 * Any Lambda importing this must be bundled with `bundlingWithSdk` in
 * api-stack.ts — @aws-sdk/client-iot-data-plane is not in the Lambda runtime SDK.
 */
let dataClientPromise: Promise<IoTDataPlaneClient> | undefined;

export async function iotDataClient(): Promise<IoTDataPlaneClient> {
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
