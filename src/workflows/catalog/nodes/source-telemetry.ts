import { z } from 'zod';
import type { EngineInChannel, EngineRunCtx, TelemetrySample } from '../types';
import { defineNode } from '../types';

// Abstract telemetry input. The named metric keys become signals on the
// telemetry channel and drive the metric:<key> capability tokens checked at
// attach time; the CONCRETE feed (stored device history window, CSV replay,
// live stream) is a binding chosen at attach or simulation time.

const configSchema = z.object({
  metrics: z
    .array(z.string().min(1))
    .min(1)
    .describe('Signal keys this source provides, e.g. gps.speed, imu.accel_x'),
});

export const def = defineNode({
  type: 'source.telemetry',
  version: 1,
  group: 'source',
  label: 'Telemetry',
  description:
    'Telemetry input. The concrete feed (device history, CSV replay, live stream) is bound at attach or simulation time.',
  ui: { icon: 'radio' },
  inputs: [],
  outputs: [
    { id: 'telemetry', label: 'Telemetry', channel: 'telemetry', cardinality: 'many', required: false },
  ],
  config: configSchema,
  requires: [{ tokenTemplate: 'metric:{config.metrics}' }],
  runtime: { target: 'any' },
});

// Binding kinds this source accepts (EngineSourceBinding is deliberately loose;
// the union lives here, with the executor). No binding defaults to a history
// read over the run window.
const bindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('telemetry_history'),
    metrics: z.array(z.string().min(1)).min(1).optional(), // default: config.metrics
    window: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(), // default: run window
  }),
  z.object({
    kind: z.literal('telemetry_inline'),
    samples: z.array(z.object({ ts: z.number(), signals: z.record(z.string(), z.number()) })),
  }),
  z.object({ kind: z.literal('telemetry_csv') }).passthrough(), // M3
]);

async function readSamples(
  cfg: z.infer<typeof configSchema>,
  ctx: EngineRunCtx,
): Promise<{ samples: TelemetrySample[]; feed: string }> {
  const parsed = bindingSchema.safeParse(ctx.binding ?? { kind: 'telemetry_history' });
  if (!parsed.success) {
    throw new Error(`Unsupported telemetry binding "${String(ctx.binding?.kind)}"`);
  }
  const binding = parsed.data;
  switch (binding.kind) {
    case 'telemetry_inline':
      return { samples: [...binding.samples].sort((a, b) => a.ts - b.ts), feed: 'inline' };
    case 'telemetry_csv':
      throw new Error('CSV telemetry bindings are not implemented until M3');
    case 'telemetry_history': {
      const metrics = binding.metrics ?? cfg.metrics;
      const window = binding.window
        ? { fromMs: Date.parse(binding.window.from), toMs: Date.parse(binding.window.to) }
        : ctx.window;
      if (!ctx.deviceId) throw new Error('History telemetry needs a device on the run');
      if (!window || Number.isNaN(window.fromMs) || Number.isNaN(window.toMs)) {
        throw new Error('History telemetry needs a data window on the run or binding');
      }
      const samples = await ctx.sources.readTelemetryWindow({ deviceId: ctx.deviceId, metrics, window });
      return { samples, feed: 'history' };
    }
  }
}

export const executor = async function* sourceTelemetry(
  _inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
) {
  const cfg = configSchema.parse(config);
  const { samples, feed } = await readSamples(cfg, ctx);
  ctx.setSummary(`${samples.length} samples (${feed}: ${cfg.metrics.join(', ')})`);
  for (const sample of samples) {
    yield { ch: 'telemetry' as const, ts: sample.ts, payload: { signals: sample.signals } };
  }
};
