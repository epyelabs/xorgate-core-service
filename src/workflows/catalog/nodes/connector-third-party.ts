import { z } from 'zod';
import { defineNode, stubExecutor } from '../types';

// Third-party data connector; the provider is node config. Google Roads (posted
// speed limits along the incoming GPS track) is the only provider for now, so
// the ports are its signature: ts-aligned json:speed_limit records
// ({ ts, speedLimitKph, placeId? }; final shape pinned with the M3 executor).
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

export const executor = stubExecutor(def.type);
