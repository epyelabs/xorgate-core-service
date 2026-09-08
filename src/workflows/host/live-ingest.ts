import { createHash, createHmac } from 'node:crypto';
import mqtt from 'mqtt';
import { z } from 'zod';
import type { LiveIngestFrame } from '@xorgate/workflow-engine';

/**
 * Webcam-over-MQTT ingest transport (M5, architecture §5). The browser samples
 * webcam frames (<= 5 fps, <= 480p JPEG, under IoT's 128 KB message cap) and
 * publishes them to the run's ingest topic; this module is the CONTAINER
 * target's implementation of the EngineSourceReader.openLiveFrames seam: an
 * MQTT-over-WSS subscriber (SigV4-presigned URL, task-role credentials)
 * exposed as an AsyncIterable<LiveIngestFrame>.
 *
 * Imported ONLY by engine-runner/main.ts — the Lambda target has no live
 * plane, so `mqtt` never enters a Lambda bundle.
 *
 * Wire contract (browser -> engine), topic `<topicPrefix>/ingest/<nodeId>`
 * where topicPrefix is the run's progress prefix (wf/sim/<orgId>/<runId>):
 *   frame:  { "seq": n, "ts": epochMs, "jpegBase64": "..." }
 *   end:    { "end": true }               (explicit stop from the browser)
 * Delivery is QoS 0 best-effort: frames published before the engine subscribes
 * (e.g. during a cold start) are simply lost, which is correct live semantics.
 */

export function ingestTopic(topicPrefix: string, nodeId: string): string {
  return `${topicPrefix}/ingest/${nodeId}`;
}

export const ingestFramePayloadSchema = z.object({
  seq: z.number().int().min(0),
  ts: z.number(),
  jpegBase64: z.string().min(1),
});
export const ingestEndPayloadSchema = z.object({ end: z.literal(true) });

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// --- SigV4 query presign for IoT's MQTT-over-WSS endpoint --------------------
// Node-crypto port of the frontend's presignIotWssUrl (src/lib/iot-wss.ts),
// including the IoT quirk: the session token is appended AFTER signing.
function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function presignIotWssUrl(endpoint: string, region: string, creds: AwsCredentials): string {
  const service = 'iotdevicegateway';
  const method = 'GET';
  const canonicalUri = '/mqtt';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  let canonicalQuery =
    'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=' +
    encodeURIComponent(`${creds.accessKeyId}/${credentialScope}`) +
    '&X-Amz-Date=' +
    amzDate +
    '&X-Amz-SignedHeaders=host';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${endpoint}\n`,
    'host',
    sha256Hex(''),
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  canonicalQuery += `&X-Amz-Signature=${hmac(kSigning, stringToSign).toString('hex')}`;
  if (creds.sessionToken) {
    canonicalQuery += `&X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`;
  }
  return `wss://${endpoint}${canonicalUri}?${canonicalQuery}`;
}

// --- The frame stream ---------------------------------------------------------

type QueueItem =
  | { kind: 'frame'; frame: LiveIngestFrame }
  | { kind: 'end'; reason: string }
  | { kind: 'error'; error: Error };

/**
 * Bounded frame buffer between the MQTT callback and the consumer. Live
 * semantics: when the consumer lags, the OLDEST buffered frame is dropped
 * (latest wins) — the same drop-oldest stance as the engine's live frames
 * channels, applied one hop earlier.
 */
class FrameQueue {
  private items: QueueItem[] = [];
  private takers: Array<(item: QueueItem) => void> = [];
  private done = false;
  public droppedFrames = 0;

  constructor(private readonly capacity: number) {}

  push(item: QueueItem): void {
    if (this.done) return;
    if (item.kind !== 'frame') this.done = true;
    const taker = this.takers.shift();
    if (taker) {
      taker(item);
      return;
    }
    if (item.kind === 'frame' && this.items.length >= this.capacity) {
      const idx = this.items.findIndex((i) => i.kind === 'frame');
      if (idx >= 0) {
        this.items.splice(idx, 1);
        this.droppedFrames += 1;
      }
    }
    this.items.push(item);
  }

  take(): Promise<QueueItem> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    if (this.done) return Promise.resolve({ kind: 'end', reason: 'stream closed' });
    return new Promise((resolve) => this.takers.push(resolve));
  }
}

export interface OpenIngestOptions {
  /** IoT ATS data endpoint hostname (DescribeEndpoint, target-resolved). */
  endpoint: string;
  region: string;
  credentials: () => Promise<AwsCredentials>;
  /** The run's progress topic prefix (wf/sim/<orgId>/<runId>). */
  topicPrefix: string;
  nodeId: string;
  maxDurationMs: number;
  idleTimeoutMs: number;
  log?: (message: string) => void;
}

const QUEUE_CAPACITY = 8;

/**
 * Subscribes to the node's ingest topic and yields frames until the browser
 * publishes an end message, maxDurationMs elapses, or idleTimeoutMs passes
 * with no frames. All three are CLEAN ends (the run drains and succeeds); a
 * connection failure is an error the consumer sees on next().
 */
export function openIngestFrames(opts: OpenIngestOptions): AsyncIterable<LiveIngestFrame> {
  const log = opts.log ?? ((m: string) => console.log(`live-ingest[${opts.nodeId}]: ${m}`));
  const topic = ingestTopic(opts.topicPrefix, opts.nodeId);

  return {
    [Symbol.asyncIterator](): AsyncIterator<LiveIngestFrame> {
      const queue = new FrameQueue(QUEUE_CAPACITY);
      let client: mqtt.MqttClient | null = null;
      let idleTimer: NodeJS.Timeout | null = null;
      let maxTimer: NodeJS.Timeout | null = null;
      let closed = false;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
        client?.end(true);
        client = null;
      };
      const endWith = (reason: string): void => {
        queue.push({ kind: 'end', reason });
      };
      const resetIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => endWith(`no frames for ${Math.round(opts.idleTimeoutMs / 1000)}s`),
          opts.idleTimeoutMs,
        );
      };

      void (async () => {
        try {
          const creds = await opts.credentials();
          const url = presignIotWssUrl(opts.endpoint, opts.region, creds);
          const c = mqtt.connect(url, {
            protocolVersion: 5,
            reconnectPeriod: 0, // presigned URL is effectively single-use
            clientId: `engine-ingest-${opts.nodeId}-${Math.random().toString(36).slice(2, 10)}`,
            transformWsUrl: () => url,
          });
          client = c;
          c.on('connect', () => {
            c.subscribe(topic, { qos: 0 }, (err) => {
              if (err) queue.push({ kind: 'error', error: new Error(`Ingest subscribe failed: ${err.message}`) });
              else log(`subscribed to ${topic}`);
            });
          });
          c.on('message', (_topic, payload) => {
            let json: unknown;
            try {
              json = JSON.parse(payload.toString('utf8'));
            } catch {
              return;
            }
            if (ingestEndPayloadSchema.safeParse(json).success) {
              endWith('browser ended the stream');
              return;
            }
            const frame = ingestFramePayloadSchema.safeParse(json);
            if (!frame.success) return;
            resetIdle();
            queue.push({
              kind: 'frame',
              frame: {
                seq: frame.data.seq,
                ts: frame.data.ts,
                jpeg: Buffer.from(frame.data.jpegBase64, 'base64'),
              },
            });
          });
          c.on('error', (err) => {
            queue.push({ kind: 'error', error: new Error(`Ingest MQTT error: ${err.message}`) });
          });
          c.on('close', () => {
            if (!closed) endWith('ingest connection closed');
          });
          maxTimer = setTimeout(
            () => endWith(`max duration of ${Math.round(opts.maxDurationMs / 1000)}s reached`),
            opts.maxDurationMs,
          );
          resetIdle();
        } catch (err) {
          queue.push({
            kind: 'error',
            error: new Error(`Failed to open ingest stream: ${err instanceof Error ? err.message : String(err)}`),
          });
        }
      })();

      return {
        async next(): Promise<IteratorResult<LiveIngestFrame>> {
          const item = await queue.take();
          if (item.kind === 'frame') return { value: item.frame, done: false };
          cleanup();
          if (item.kind === 'error') throw item.error;
          log(`ingest ended: ${item.reason}${queue.droppedFrames > 0 ? ` (${queue.droppedFrames} frame(s) dropped)` : ''}`);
          return { value: undefined as never, done: true };
        },
        async return(): Promise<IteratorResult<LiveIngestFrame>> {
          cleanup();
          return { value: undefined as never, done: true };
        },
      };
    },
  };
}
