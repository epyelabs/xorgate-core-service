/**
 * TOMBSTONE — delete this file in Phase 5 (destroy-kvs-recorder).
 *
 * The cloud viewer-recorder was removed in Phase 3; the real handler
 * (start/stop Fargate, presign, delete cloud recordings) is gone. This stub
 * exists only because `lib/stacks/api-stack.ts` still declares
 * `DeviceRecordingsFn` with this file as its `NodejsFunction` entry, and the
 * esbuild bundler resolves entry paths at **synth** time — so deleting the file
 * outright breaks `cdk synth` for the whole app, not just this Lambda.
 *
 * Phase 5 deletes the Lambda, its integration and its `/devices/{id}/recordings*`
 * routes; delete this file in the same change.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = async (
  _event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => ({
  statusCode: 410,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    error: {
      code: 'RECORDER_REMOVED',
      message: 'The cloud recorder has been removed. Use on-device recordings (/devices/{id}/sessions).',
    },
  }),
});
