/**
 * The engine's conformance kit against the platform's cloud host (wf-engine-
 * integration M3, Q7). Runs the four golden cases through `createEngine` over
 * `cloudHost({ target: 'fargate', localInputs: true })`: inputs are read from
 * the engine repository's fixtures by absolute path (the test-only switch),
 * models resolve from the S3 registry, artifacts land in the given bucket
 * under workflows/v2/runs/<prefix>-<case>/. Needs AWS credentials for the
 * bucket (dev), ffmpeg (ffmpeg-static devDependency) and the engine fixtures
 * pulled (`npm run fixtures:pull` in the engine repo).
 *
 *   BUCKET=<dev core bucket> FIXTURES=<engine repo>/fixtures npx ts-node -T --compilerOptions '{"module":"commonjs","target":"ES2022","esModuleInterop":true}' scripts/conformance-cloud.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runConformance } from '@xorgate/workflow-engine/testing';
import { cloudHost } from '../src/workflows/host/cloud-host';

// eslint-disable-next-line @typescript-eslint/no-var-requires
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH ?? (require('ffmpeg-static') as string);

async function main(): Promise<void> {
  const bucket = process.env.BUCKET;
  const fixturesDir = process.env.FIXTURES;
  if (!bucket || !fixturesDir) throw new Error('BUCKET and FIXTURES are required');
  const workDir = await mkdtemp(path.join(tmpdir(), 'conformance-cloud-'));
  const runIdPrefix = process.env.RUN_ID_PREFIX ?? `conf-${Date.now().toString(36)}`;
  const host = cloudHost({
    bucket,
    target: 'fargate',
    workDir,
    localInputs: true, // TEST ONLY: fixtures by absolute local path
    // No IoT: publish progress into the log instead.
    progressTransport: async (topic, payload) => {
      if (topic.endsWith('/status')) console.log(`  progress ${topic} ${payload.slice(0, 120)}`);
    },
    log: (m) => console.log(`  host: ${m}`),
  });
  console.log(`conformance-cloud: bucket=${bucket} fixtures=${fixturesDir} workDir=${workDir} prefix=${runIdPrefix}`);
  const report = await runConformance({ host, fixturesDir, runIdPrefix, log: (line) => console.log(line) });
  console.log(JSON.stringify({ ok: report.ok, cases: report.cases.map((c) => ({ name: c.name, ok: c.ok, runId: c.runId, runDir: c.runDir, durationMs: c.durationMs, detail: c.detail })) }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('conformance-cloud FAILED:', err);
  process.exit(1);
});
