import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EngineArtifactSink } from '../catalog/types';
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
