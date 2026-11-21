/**
 * Regenerate the cross-package artifacts from their sources in this repo and
 * write every committed copy:
 *
 *   config-contract.json   from the config registry   (design.md §3)
 *   camera-catalog.json    from the camera catalog    (plans/support-other-camera-models)
 *
 *   npm run contract:generate
 *   npm run contract:generate -- --help
 *
 * Copies (all COMMITTED; a copy whose bytes already match is left untouched):
 *
 *   backend  src/config-registry/config-contract.json            source of truth
 *            src/camera-catalog/camera-catalog.json              source of truth
 *   web      <root>/frontend/xorgate-web/src/lib/config-contract.json
 *            <root>/frontend/xorgate-web/src/lib/camera-catalog.json
 *   device   <root>/device/xorgate-device-agent-rust/fixtures/config-contract.json
 *            <root>/device/xorgate-device-agent-rust/crates/xorgate-core/data/camera-catalog.json
 *
 * `device` is the RUST agent. The JS agent (`device/xorgate-device-agent`) is
 * frozen and is no longer written: its `test/config-contract.json` stays as
 * the contract it was built against.
 *
 * The sibling packages are separate git repos inside one working tree; a
 * missing sibling is reported and skipped rather than failing, so a
 * backend-only checkout can still regenerate its own copies. From a linked git
 * worktree of this repo the siblings are NOT written unless named with
 * `--repo` or `--out-root` (see `src/contract-artifacts/targets.ts` for the
 * resolution rules and the reason).
 *
 * Each package has its own test asserting its copy is in sync —
 * `test/config-contract.test.ts` and `test/camera-catalog.test.ts` here do the
 * regenerate-and-diff that catches "edited the source, forgot to regenerate".
 */
import { resolve } from 'node:path';
import { serializeCameraCatalog } from '../src/camera-catalog';
import { serializeConfigContract } from '../src/config-registry/contract';
import {
  GENERATE_USAGE,
  applyTargets,
  describeCheckout,
  formatResult,
  isFailure,
  parseGenerateArgs,
  planTargets,
} from '../src/contract-artifacts/targets';

const backendRoot = resolve(__dirname, '..');

function main(): void {
  const options = parseGenerateArgs(process.argv.slice(2), process.env, backendRoot);
  if ('error' in options) {
    console.error(`${options.error}\n\n${GENERATE_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(GENERATE_USAGE);
    return;
  }

  const plan = planTargets(describeCheckout(backendRoot), options);
  const results = applyTargets(
    plan,
    {
      'config-contract': serializeConfigContract(),
      'camera-catalog': serializeCameraCatalog(),
    },
    { check: options.check },
  );
  for (const result of results) {
    const line = formatResult(result);
    if (isFailure(result.status)) console.error(line);
    else if (result.status === 'skipped') console.warn(line);
    else console.log(line);
  }
  if (results.some((r) => isFailure(r.status))) process.exitCode = 1;
}

main();
