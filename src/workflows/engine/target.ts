import { DescribeEndpointCommand, IoTClient } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { EngineArtifactSink, EngineSecretReader } from '../catalog/types';
import type { WorkflowDefinition } from '../../schemas/workflows';
import type { EngineRunOutcome } from './index';
import {
  buildEngineResult,
  eventsKey,
  frameKey,
  recordsKey,
  resultKey,
  runManifestSchema,
  type EngineResult,
  type RunManifest,
} from './manifest';
import { IotRunProgress } from './progress';

/**
 * The shared half of every DEPLOYED engine target (Lambda handler, Fargate
 * container main): manifest-in from S3, artifacts + result.json out to S3. The
 * engine core stays storage-free; this module is where a target's I/O lives so
 * the two targets cannot drift. Each target keeps only what is genuinely its
 * own: the Lambda's drizzle telemetry reader and media refusal, the
 * container's S3 video/model fetchers.
 */

const s3 = new S3Client({});

export async function loadRunManifest(bucket: string, key: string): Promise<RunManifest> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  return runManifestSchema.parse(JSON.parse(body ?? '{}'));
}

async function putJson(bucket: string, key: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

/** Each output.data_capture node's configured artifact format. */
export function captureFormats(definition: WorkflowDefinition): Record<string, 'jsonl' | 'json'> {
  const formats: Record<string, 'jsonl' | 'json'> = {};
  for (const node of definition.nodes) {
    if (node.type === 'output.data_capture') {
      formats[node.id] = node.data.config?.format === 'json' ? 'json' : 'jsonl';
    }
  }
  return formats;
}

/**
 * Writes events.jsonl, outputs/<nodeId>/records.*, and result.json for a
 * finished run. result.json goes LAST so the finalize rule fires only once
 * every other artifact is durable.
 */
export async function writeRunArtifacts(
  bucket: string,
  runId: string,
  outcome: EngineRunOutcome,
  formats: Record<string, 'jsonl' | 'json'> = {},
): Promise<EngineResult> {
  const puts: Array<Promise<void>> = [];
  if (outcome.events.length > 0) {
    puts.push(
      putJson(
        bucket,
        eventsKey(runId),
        outcome.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'application/x-ndjson',
      ),
    );
  }
  for (const [nodeId, records] of Object.entries(outcome.captures)) {
    const format = formats[nodeId] ?? 'jsonl';
    puts.push(
      format === 'json'
        ? putJson(bucket, recordsKey(runId, nodeId, 'json'), JSON.stringify(records), 'application/json')
        : putJson(
            bucket,
            recordsKey(runId, nodeId, 'jsonl'),
            records.map((r) => JSON.stringify(r)).join('\n') + '\n',
            'application/x-ndjson',
          ),
    );
  }
  await Promise.all(puts);
  const result = buildEngineResult(runId, outcome, formats);
  await putJson(bucket, resultKey(runId), JSON.stringify(result), 'application/json');
  return result;
}

/** An outcome for runs that failed before (or instead of) executing the graph. */
export function failureOutcome(
  nodeCount: number,
  failedNodeId: string | null,
  error: string,
): EngineRunOutcome {
  return {
    status: 'failed',
    error,
    failedNodeId,
    steps: [],
    events: [],
    captures: {},
    metrics: { nodes: nodeCount, okSteps: 0, events: 0, messages: 0 },
  };
}

/** Artifact sink writing visualization frames under the run prefix. */
export function s3ArtifactSink(bucket: string, runId: string): EngineArtifactSink {
  return {
    async putFrame(nodeId: string, frameSeq: number, jpegBuf: Buffer): Promise<string> {
      const key = frameKey(runId, nodeId, frameSeq);
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: jpegBuf, ContentType: 'image/jpeg' }),
      );
      return key;
    },
  };
}

/** Small text objects (telemetry CSV uploads) for the fetchText source seam. */
export async function s3FetchText(bucket: string, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  if (body === undefined) throw new Error(`Empty object at s3://${bucket}/${key}`);
  return body;
}

// The default IoTDataPlaneClient endpoint is the legacy (non-ATS) data
// endpoint; resolve the account's ATS endpoint once per process, same pattern
// as services/device-config.ts. Both the Lambda role and the engine task role
// carry iot:DescribeEndpoint + iot:Publish on wf/sim/*.
let iotAtsEndpointPromise: Promise<string> | undefined;
/** The account's iot:Data-ATS endpoint hostname, resolved once per process. */
export async function iotAtsEndpoint(): Promise<string> {
  if (!iotAtsEndpointPromise) {
    iotAtsEndpointPromise = (async () => {
      const iot = new IoTClient({});
      const res = await iot.send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }));
      if (!res.endpointAddress) throw new Error('DescribeEndpoint returned no iot:Data-ATS address');
      return res.endpointAddress;
    })();
    iotAtsEndpointPromise.catch(() => {
      iotAtsEndpointPromise = undefined;
    });
  }
  return iotAtsEndpointPromise;
}

let iotDataClientPromise: Promise<IoTDataPlaneClient> | undefined;
async function iotDataClient(): Promise<IoTDataPlaneClient> {
  if (!iotDataClientPromise) {
    iotDataClientPromise = (async () => {
      const endpointAddress = await iotAtsEndpoint();
      return new IoTDataPlaneClient({ endpoint: `https://${endpointAddress}` });
    })();
    iotDataClientPromise.catch(() => {
      iotDataClientPromise = undefined;
    });
  }
  return iotDataClientPromise;
}

/**
 * Builds the progress publisher for a manifest, or null when the manifest has
 * no progress block (every production/batch run today). Shared by the Lambda
 * handler and the container main so the transport cannot drift.
 */
export function manifestProgress(manifest: RunManifest, log?: (m: string) => void): IotRunProgress | null {
  if (!manifest.progress) return null;
  const { topicPrefix } = manifest.progress;
  return new IotRunProgress({
    runId: manifest.runId,
    topicPrefix,
    publish: async (topic, payload) => {
      const client = await iotDataClient();
      await client.send(new PublishCommand({ topic, qos: 0, payload: Buffer.from(payload) }));
    },
    log,
  });
}

/**
 * Secrets seam implementation over Secrets Manager. Logical names map to
 * physical secret names via env (GOOGLE_ROADS_SECRET_NAME today); values are
 * cached for the process lifetime, so per-sample connector lookups never
 * re-hit the API.
 */
const SECRET_ENV_BY_LOGICAL_NAME: Record<string, string> = {
  'google-roads-api-key': 'GOOGLE_ROADS_SECRET_NAME',
  'anthropic-api-key': 'ANTHROPIC_SECRET_NAME', // model.vlm (M5)
};
const secretCache = new Map<string, Promise<string>>();
export function secretsManagerReader(): EngineSecretReader {
  const client = new SecretsManagerClient({});
  return {
    getSecret(logicalName: string): Promise<string> {
      const envVar = SECRET_ENV_BY_LOGICAL_NAME[logicalName];
      if (!envVar) return Promise.reject(new Error(`Unknown secret "${logicalName}"`));
      const secretName = process.env[envVar];
      if (!secretName) {
        return Promise.reject(
          new Error(`Secret "${logicalName}" is not configured on this engine target (${envVar} unset)`),
        );
      }
      let entry = secretCache.get(secretName);
      if (!entry) {
        entry = (async () => {
          const res = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
          if (!res.SecretString) throw new Error(`Secret "${secretName}" has no string value`);
          return res.SecretString;
        })();
        entry.catch(() => secretCache.delete(secretName));
        secretCache.set(secretName, entry);
      }
      return entry;
    },
  };
}
