import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { DescribeEndpointCommand, IoTClient } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  buildEngineResult,
  eventsKey,
  frameKey,
  recordsKey,
  resultKey,
  runManifestSchema,
  IotRunProgress,
  type EngineArtifactSink,
  type EngineRunOutcome,
  type EngineSecretReader,
  type ProgressTransport,
  type RunManifest,
} from '@xorgate/workflow-engine';
import { isSecretGoneError, orgSecretName, PROVIDER_BY_LOGICAL_SECRET } from '../org-credentials';
import type { PlatformEngineResult, VideoArtifact } from './result';

/**
 * The AWS half of the cloud host (wf-engine-integration design §3.2): manifest
 * in from S3, artifacts and result.json out to S3, frames to S3, progress to
 * IoT, secrets from Secrets Manager. Moved verbatim from the former
 * the engine copy's `target.ts`; `cloud-host.ts` composes these into the
 * `EngineHost` both deployed targets hand to `createEngine`. The engine
 * package itself carries no AWS SDK (its smoke asserts it), so this file is
 * the one place a cloud provider appears on the execution path.
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

/** Platform-only additions to the result the package builds (host/result.ts). */
export interface RunArtifactExtras {
  /** Muxed visualization MP4s, already uploaded under the run prefix (Fargate host). */
  videos?: Record<string, VideoArtifact>;
}

/**
 * Writes events.jsonl, outputs/<nodeId>/records.*, and result.json for a
 * finished run. result.json goes LAST so the finalize rule fires only once
 * every other artifact is durable (callers upload anything else they add,
 * such as the visualization MP4s in `extras.videos`, BEFORE calling this).
 * Exported for the targets' "no manifest could be read" path; every other
 * write goes through the host's `writeArtifacts`, which is this function
 * bound to the run.
 */
export async function writeRunArtifacts(
  bucket: string,
  runId: string,
  outcome: EngineRunOutcome,
  formats: Record<string, 'jsonl' | 'json'> = {},
  extras: RunArtifactExtras = {},
): Promise<PlatformEngineResult> {
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
  const base = buildEngineResult(runId, outcome, formats);
  const videos = extras.videos && Object.keys(extras.videos).length > 0 ? extras.videos : undefined;
  const result: PlatformEngineResult = videos
    ? { ...base, artifacts: { ...base.artifacts, videos } }
    : base;
  await putJson(bucket, resultKey(runId), JSON.stringify(result), 'application/json');
  return result;
}

/** Uploads one local file (a muxed MP4) under the run prefix; the body is read whole (tens of MB at most). */
export async function s3PutFile(bucket: string, key: string, localPath: string, contentType: string): Promise<void> {
  const body = await readFile(localPath);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
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

/** Small text objects (telemetry CSV uploads, materialized inputs) for the fetchText source seam. */
export async function s3FetchText(bucket: string, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await res.Body?.transformToString();
  if (body === undefined) throw new Error(`Empty object at s3://${bucket}/${key}`);
  return body;
}

/** Streams a video object to `localPath` (the fetchVideo source seam on the container target). */
export async function s3FetchVideo(bucket: string, key: string, localPath: string): Promise<void> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty video object at s3://${bucket}/${key}`);
  await pipeline(res.Body as Readable, createWriteStream(localPath));
}

/** The S3 client the host's model store shares (one client per process). */
export function s3Client(): S3Client {
  return s3;
}

// The default IoTDataPlaneClient endpoint is the legacy (non-ATS) data
// endpoint; resolve the account's ATS endpoint once per process, same pattern
// as services/device-config.ts. Both the Lambda role and the engine task role
// carry iot:DescribeEndpoint + iot:Publish on wf/sim/* and wf/run/*.
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

/** The IoT publish transport behind every deployed progress sink (QoS 0, ATS endpoint). */
export const iotPublishTransport: ProgressTransport = async (topic, payload) => {
  const client = await iotDataClient();
  await client.send(new PublishCommand({ topic, qos: 0, payload: Buffer.from(payload) }));
};

/**
 * Builds the progress publisher for a manifest, or null when the manifest has
 * no progress block. The transport is injectable so the smoke drives the
 * class through an in-memory publisher; deployed code uses iotPublishTransport.
 */
export function manifestProgress(
  manifest: RunManifest,
  log?: (m: string) => void,
  transport: ProgressTransport = iotPublishTransport,
): IotRunProgress | null {
  if (!manifest.progress) return null;
  const { topicPrefix } = manifest.progress;
  return new IotRunProgress({ runId: manifest.runId, topicPrefix, publish: transport, log });
}

/**
 * Secrets seam implementation over Secrets Manager. Logical names map to
 * physical secret names via env (GOOGLE_ROADS_SECRET_NAME / HERE_SECRET_NAME /
 * ANTHROPIC_SECRET_NAME); values are cached for the process lifetime, so
 * per-sample connector lookups never re-hit the API.
 *
 * M7 resolution order: when the manifest carries an orgId and the logical name
 * maps to an org-settable provider, the per-org secret
 * (xorgate/orgs/<orgId>/<provider>) wins when it exists; otherwise the
 * platform secret; otherwise the existing clear failure. Values are cached per
 * physical name for the process/task lifetime (the M3/M5 rotation caveat);
 * org-secret MISSES are deliberately not cached, so a newly set org key is
 * picked up on the next run even on a warm target.
 */
const SECRET_ENV_BY_LOGICAL_NAME: Record<string, string> = {
  'google-roads-api-key': 'GOOGLE_ROADS_SECRET_NAME',
  'here-api-key': 'HERE_SECRET_NAME', // connector.third_party provider "here" (M7)
  'anthropic-api-key': 'ANTHROPIC_SECRET_NAME', // model.vlm (M5)
};

export interface SecretReaderDeps {
  orgId: string | null;
  env: Record<string, string | undefined>;
  /** Resolved SecretString, or null when the secret does not exist. */
  fetchSecretValue: (secretName: string) => Promise<string | null>;
  /** Process-lifetime value cache, keyed by physical secret name. */
  cache?: Map<string, Promise<string | null>>;
}

/**
 * The pure resolution half of the secrets seam (smoke-testable offline);
 * secretsManagerReader() below wires it to Secrets Manager.
 */
export function createSecretReader(deps: SecretReaderDeps): EngineSecretReader {
  const cache = deps.cache ?? new Map<string, Promise<string | null>>();
  const cachedFetch = (secretName: string): Promise<string | null> => {
    let entry = cache.get(secretName);
    if (!entry) {
      entry = deps.fetchSecretValue(secretName).then((value) => {
        // Never cache a miss: a just-created org secret must be seen next run.
        if (value === null || value === '') cache.delete(secretName);
        return value;
      });
      entry.catch(() => cache.delete(secretName));
      cache.set(secretName, entry);
    }
    return entry;
  };

  return {
    async getSecret(logicalName: string): Promise<string> {
      const envVar = SECRET_ENV_BY_LOGICAL_NAME[logicalName];
      if (!envVar) throw new Error(`Unknown secret "${logicalName}"`);

      const provider = PROVIDER_BY_LOGICAL_SECRET[logicalName];
      if (deps.orgId && provider) {
        const orgValue = await cachedFetch(orgSecretName(deps.orgId, provider));
        if (orgValue) return orgValue; // empty/missing org secret -> platform
      }

      const secretName = deps.env[envVar];
      if (!secretName) {
        throw new Error(
          `Secret "${logicalName}" is not configured: no organization credential` +
            (provider ? ` for ${provider}` : '') +
            ` and ${envVar} is unset on this engine target`,
        );
      }
      const value = await cachedFetch(secretName);
      if (value === null) {
        throw new Error(
          `Secret "${secretName}" does not exist` +
            (provider ? `; set an organization ${provider} credential or create the platform secret` : ''),
        );
      }
      if (!value) throw new Error(`Secret "${secretName}" has no string value`);
      return value;
    },
  };
}

const secretCache = new Map<string, Promise<string | null>>();
export function secretsManagerReader(orgId: string | null = null): EngineSecretReader {
  const client = new SecretsManagerClient({});
  return createSecretReader({
    orgId,
    env: process.env,
    cache: secretCache,
    fetchSecretValue: async (secretName) => {
      try {
        const res = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
        return res.SecretString ?? '';
      } catch (err) {
        // Missing AND scheduled-for-deletion both mean "absent" (a just-
        // cleared org key must fall back to the platform key, not fail).
        if (isSecretGoneError(err)) return null;
        throw err;
      }
    },
  });
}
