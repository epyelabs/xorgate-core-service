/**
 * Regenerate `config-contract.json` from the config registry and write it to
 * every package that consumes it (design.md §3).
 *
 *   npm run contract:generate
 *
 * Targets (all COMMITTED, all rewritten every run):
 *   backend  src/config-registry/config-contract.json   source of truth
 *   web      ../../frontend/xorgate-web/src/lib/config-contract.json
 *   device   ../../device/xorgate-device-agent/test/config-contract.json
 *
 * The sibling packages are separate git repos inside one working tree; a
 * missing sibling is reported and skipped rather than failing, so a
 * backend-only checkout can still regenerate its own copy. Each package has its
 * own test asserting its copy is in sync — `test/config-contract.test.ts` here
 * does the regenerate-and-diff that catches "edited the registry, forgot to
 * regenerate".
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { serializeConfigContract } from '../src/config-registry/contract';

const backendRoot = resolve(__dirname, '..');
const monorepoRoot = resolve(backendRoot, '..', '..');

const json = serializeConfigContract();

const targets = [
  {
    label: 'backend',
    path: join(backendRoot, 'src/config-registry/config-contract.json'),
    required: true,
  },
  {
    label: 'web',
    path: join(monorepoRoot, 'frontend/xorgate-web/src/lib/config-contract.json'),
    required: false,
  },
  {
    label: 'device',
    path: join(monorepoRoot, 'device/xorgate-device-agent/test/config-contract.json'),
    required: false,
  },
];

for (const target of targets) {
  const dir = dirname(target.path);
  if (!existsSync(dir)) {
    if (target.required) {
      console.error(`missing required target directory: ${dir}`);
      process.exitCode = 1;
      continue;
    }
    console.warn(`skipped ${target.label}: ${dir} not present in this checkout`);
    continue;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(target.path, json);
  console.log(`wrote ${target.label}: ${target.path}`);
}
