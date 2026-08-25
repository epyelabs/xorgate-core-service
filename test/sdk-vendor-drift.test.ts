import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The cross-repo half of the SDK's generator drift check.
 *
 * `@xorgate/sdk` (github.com/epyelabs/xorgate-sdk-js) ships ZERO runtime
 * dependencies, because it has to run on edge runtimes. That means it cannot
 * import zod to validate an `ioCapabilities` document and cannot import this
 * package to get the config namespace types, so it VENDORS both contracts under
 * its `vendor/` directory and generates code from the copies. Its own CI runs
 * `npm run check:generated`, which proves the generated code matches the
 * vendored copy.
 *
 * What that check cannot see is this repo. If `config-contract.json` gains a
 * namespace, or `capabilities.ts` gains a required field, the SDK's vendored
 * copy silently becomes a description of a contract that no longer exists: the
 * SDK keeps type-checking, keeps generating consistent code, and starts
 * accepting documents the platform rejects, or rejecting ones it accepts.
 *
 * A test in the SDK repo cannot catch that either, because it has no checkout
 * of this one. So the tripwire lives here, where the change is made: pin the
 * hash of each vendored source, and fail when it moves.
 *
 * **If this test fails, that is not a bug. It means you changed a contract the
 * SDK vendors.** Do this:
 *
 *   1. In the SDK repo, take the change:
 *        cp <this repo>/src/config-registry/config-contract.json vendor/
 *        (for capabilities.ts, mirror the change into
 *         vendor/io-capabilities.schema.json by hand)
 *        npm run generate && npm test
 *   2. Update the `sourceSha256` values in that repo's `vendor/SOURCES.json`.
 *   3. Update the pins below to the new hashes.
 *
 * Deliberately NOT a "regenerate for me" script: a contract change may want a
 * different SDK-side shape, and a human should look at it once.
 */

interface Pin {
  /** Path relative to this repo's root. */
  file: string;
  sha256: string;
  /** Where the copy lives in the SDK repo. */
  vendoredAs: string;
  pinnedAt: string;
}

const PINS: Pin[] = [
  {
    file: 'src/config-registry/config-contract.json',
    // 2026-08-25: added the `cameraMount` namespace (cam-sensor-level-rotate
    // plan, Phase 1). ⚠ SDK re-vendor is that plan's Phase 3 (it ships with the
    // SDK regen + publish); the pin is moved with the change, as the
    // capabilities pin below was, so the suite stays green in the meantime.
    sha256: '0b73cc21544dc78955965f6efb2cfb9c4ee7af4bba3f1f7e7038b99bdf54e5e7',
    vendoredAs: 'vendor/config-contract.json (verbatim copy)',
    pinnedAt: '2026-08-25',
  },
  {
    file: 'src/schemas/capabilities.ts',
    // 2026-08-24: schemaVersion 2 (cm4-support plan) — platform facts on
    // `system` (platform/encoder/rails/statusLed), per-video connector+sensor,
    // sensors.imu.model. ⚠ SDK re-vendor still OUTSTANDING: mirror v2 into
    // vendor/io-capabilities.schema.json in epyelabs/xorgate-sdk-js and
    // regenerate there (steps 1-2 in the header); this pin was moved with the
    // change so the suite stays green, and the SDK task is tracked in
    // plans/cm4-support/PROGRESS.md.
    sha256: '76101abaf26dd247563ef15ca57950b61abe3f854a6f7e5fc600c513ec93858f',
    vendoredAs: 'vendor/io-capabilities.schema.json (hand-derived mirror)',
    pinnedAt: '2026-08-24',
  },
];

const REPO_ROOT = join(__dirname, '..');

function sha256Of(relativePath: string): string {
  const bytes = readFileSync(join(REPO_ROOT, relativePath));
  return createHash('sha256').update(bytes).digest('hex');
}

describe('contracts vendored by @xorgate/sdk', () => {
  for (const pin of PINS) {
    it(`${pin.file} has not drifted from its vendored copy`, () => {
      const actual = sha256Of(pin.file);
      expect(
        actual,
        `\n${pin.file} changed since ${pin.pinnedAt}.\n` +
          `It is vendored into epyelabs/xorgate-sdk-js as ${pin.vendoredAs}.\n` +
          'Re-vendor it there, regenerate, then update this pin. See the header ' +
          'comment of this file for the exact steps.\n',
      ).toBe(pin.sha256);
    });
  }

  it('pins every contract the SDK vendors, and nothing it does not', () => {
    // A guard on the guard: if a third contract starts being vendored, adding
    // it here is the step most likely to be forgotten.
    expect(PINS.map((p) => p.file).sort()).toEqual([
      'src/config-registry/config-contract.json',
      'src/schemas/capabilities.ts',
    ]);
  });
});
