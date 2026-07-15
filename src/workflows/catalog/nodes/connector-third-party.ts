import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineEmit, EngineInChannel, EngineRunCtx } from '../types';
import { defineNode } from '../types';

// Third-party data connector; the provider is node config. Google Roads (posted
// speed limits along the incoming GPS track) is the only provider for now, so
// the ports are its signature. The json:speed_limit record shape is PINNED
// (M3): { ts, speedLimitKph, placeId? } — ts is the triggering sample's ts, so
// logic.comparator's ts-tie rule applies the limit to that same sample.
// A future provider with a different output shape needs either its own node
// type or config-dependent ports (a NodeTypeDef contract extension) — revisit
// then, not now.
export const def = defineNode({
  type: 'connector.third_party',
  version: 1,
  group: 'source',
  label: 'Connector',
  description: 'Third-party data lookup along the incoming stream (Google Roads speed limits).',
  ui: { icon: 'plug' },
  inputs: [
    { id: 'positions', label: 'GPS positions', channel: 'telemetry', cardinality: 'one', required: true },
  ],
  outputs: [
    {
      id: 'speed_limit',
      label: 'Speed limits',
      channel: 'json',
      tag: 'speed_limit',
      cardinality: 'many',
      required: false,
    },
  ],
  config: z.object({
    provider: z.enum(['google_roads']).default('google_roads').describe('Data provider'),
    cacheTtlSeconds: z
      .number()
      .int()
      .positive()
      .default(300)
      .describe('How long looked-up results are cached'),
  }),
  requires: [],
  runtime: { target: 'any' },
});

// Executor decisions (M3, recorded in STATUS):
// - Positions come from the fixed signal names gps.latitude / gps.longitude
//   (the def's config is frozen, so no signal-name knobs); samples missing
//   either signal are skipped.
// - Lookups are per unique position (rounded to 4 decimals, ~11 m) with a TTL
//   cache, NOT batched across samples: batching would buffer the input while
//   downstream consumers of the same source wait on ts-merged channels, which
//   deadlocks bounded fan-out graphs. At 1 Hz GPS this is at most ~1 request/s
//   on a cache-cold track; revisit with a look-ahead buffer if quota hurts.
// - API key via ctx.secrets.getSecret('google-roads-api-key'); HTTP via
//   ctx.http so the smoke script runs scenario 2 offline.

const ROADS_URL = 'https://roads.googleapis.com/v1/speedLimits';

interface RoadsResponse {
  speedLimits?: Array<{ placeId?: string; speedLimit?: number; units?: string }>;
  snappedPoints?: Array<{ placeId?: string; originalIndex?: number }>;
}

interface CacheEntry {
  at: number;
  speedLimitKph: number | null; // null = no coverage for this position
  placeId?: string;
}

function roundCoord(v: number): string {
  return v.toFixed(4);
}

export const executor = async function* connectorThirdParty(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = def.config.parse(config) as { provider: 'google_roads'; cacheTtlSeconds: number };
  if (!ctx.secrets) {
    throw new Error('This engine target has no secret access; the Connector node cannot run here');
  }
  const apiKey = await ctx.secrets.getSecret('google-roads-api-key');
  const cache = new Map<string, CacheEntry>();
  const ttlMs = cfg.cacheTtlSeconds * 1000;
  let emitted = 0;
  let requests = 0;
  let skippedNoPosition = 0;
  let noCoverage = 0;

  const lookup = async (lat: number, lng: number): Promise<CacheEntry> => {
    const key = `${roundCoord(lat)},${roundCoord(lng)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit;
    const url = `${ROADS_URL}?path=${roundCoord(lat)}%2C${roundCoord(lng)}&units=KPH&key=${encodeURIComponent(apiKey)}`;
    requests += 1;
    const res = await ctx.http(url);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Google Roads request failed (HTTP ${res.status}): ${body || 'no body'}`);
    }
    const data = (await res.json()) as RoadsResponse;
    const placeId = data.snappedPoints?.[0]?.placeId;
    const limit = data.speedLimits?.find((l) => l.placeId === placeId) ?? data.speedLimits?.[0];
    const entry: CacheEntry = {
      at: Date.now(),
      speedLimitKph: typeof limit?.speedLimit === 'number' ? limit.speedLimit : null,
      ...(limit?.placeId ? { placeId: limit.placeId } : {}),
    };
    cache.set(key, entry);
    return entry;
  };

  for await (const sample of telemetrySamples(requireInput(inputs, 'positions'))) {
    const lat = sample.signals['gps.latitude'];
    const lng = sample.signals['gps.longitude'];
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      skippedNoPosition += 1;
      continue;
    }
    const entry = await lookup(lat, lng);
    if (entry.speedLimitKph === null) {
      noCoverage += 1;
      continue;
    }
    emitted += 1;
    yield {
      ch: 'json' as const,
      ts: sample.ts,
      payload: {
        ts: sample.ts,
        speedLimitKph: entry.speedLimitKph,
        ...(entry.placeId ? { placeId: entry.placeId } : {}),
      },
    };
  }
  ctx.setSummary(
    `${emitted} speed-limit record(s), ${requests} lookup(s)` +
      (noCoverage > 0 ? `, ${noCoverage} without coverage` : '') +
      (skippedNoPosition > 0 ? `, ${skippedNoPosition} without position` : ''),
  );
};
