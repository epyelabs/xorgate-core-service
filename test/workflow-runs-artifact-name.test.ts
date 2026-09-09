import { describe, expect, it } from 'vitest';
import { artifactFileName } from '../src/workflows/host/result';

describe('artifactFileName (GET /workflow-runs/{id}/artifact-url?download=1)', () => {
  const runId = '0336f969-62cd-4b06-9add-b38ff25a1d7d';
  const prefix = `workflows/v2/runs/${runId}/`;
  it('folds the path under the run prefix into one name', () => {
    expect(artifactFileName(runId, `${prefix}outputs/cap/records.jsonl`)).toBe('outputs-cap-records.jsonl');
    expect(artifactFileName(runId, `${prefix}video/viz.mp4`)).toBe('video-viz.mp4');
    expect(artifactFileName(runId, `${prefix}frames/viz/12.jpg`)).toBe('frames-viz-12.jpg');
    expect(artifactFileName(runId, `${prefix}result.json`)).toBe('result.json');
  });
  it('sanitizes anything outside the safe set and never returns an empty name', () => {
    expect(artifactFileName(runId, `${prefix}outputs/a b"c/records.json`)).toBe('outputs-a_b_c-records.json');
    expect(artifactFileName(runId, prefix)).toBe('artifact');
  });
});
