import { z } from 'zod';
import { engineResultSchema, runPrefix, type EngineResult } from '@xorgate/workflow-engine';

/**
 * The platform's ADDITIVE extension of the frozen `result.json` v2 contract
 * (wf-engine-integration design §5): `artifacts.videos` names the MP4 the
 * Fargate host muxes from each visualization node's annotated frames
 * (`video/<nodeId>.mp4` under the run prefix). The package's
 * `engineResultSchema` is a plain `z.object`, so a `result.json` carrying the
 * extra key still parses there; but a plain object STRIPS unknown keys, so the
 * finalize path must parse with this schema or the videos never reach the run
 * row. Every other field is the package's own; nothing here changes what the
 * engine writes. Absent on Lambda runs (no media nodes ever route there), on
 * failed runs (no mux) and on every pre-existing result.json.
 */

export const videoArtifactSchema = z.object({
  /** S3 key under the run prefix: workflows/v2/runs/<runId>/video/<nodeId>.mp4 */
  key: z.string(),
  /** JPEGs muxed (one output frame each). */
  frames: z.number().int().min(0),
  /** Playback rate: the decode_sample fps feeding the visualization node. */
  fps: z.number().positive(),
});
export type VideoArtifact = z.infer<typeof videoArtifactSchema>;

export const platformArtifactsSchema = engineResultSchema.shape.artifacts.extend({
  videos: z.record(z.string(), videoArtifactSchema).optional(),
});
export type PlatformArtifacts = z.infer<typeof platformArtifactsSchema>;

export const platformResultSchema = engineResultSchema.extend({
  artifacts: platformArtifactsSchema,
});
/** `EngineResult` plus the optional `artifacts.videos` map; assignable to `EngineResult`. */
export type PlatformEngineResult = z.infer<typeof platformResultSchema>;

/** workflows/v2/runs/<runId>/video/<nodeId>.mp4 (the one key the platform adds to the tree). */
export function videoKey(runId: string, nodeId: string): string {
  return `${runPrefix(runId)}video/${nodeId}.mp4`;
}

/** Narrowing helper for callers holding the package type. */
export function videosOf(result: EngineResult): Record<string, VideoArtifact> | undefined {
  return (result as PlatformEngineResult).artifacts.videos;
}
