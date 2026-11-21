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
    // 2026-10-13 (later): `obd.powerSource` description reworded to say it is
    // the TRACKER DEVICE's feed, not the adapter's (description-only; no shape
    // change). Re-vendored into the SDK on branch fix/obd-power-source-copy
    // (JSDoc-only regenerate; publish is the owner's). Previous pin, earlier
    // 2026-10-13: the `obd` namespace (P3 backend, SDK 0.15.0).
    // 2026-10-16: OBD torque fields (engine_torque_pct, reference_torque,
    // engine_torque) in the `obd` namespace's `fields` enum; re-vendored into
    // the SDK on branch feat/obd-torque (0.16.0; publish is the owner's).
    // 2026-11-21: the `cameraSensors` namespace appended last
    // (plans/support-other-camera-models, Phase 2 backend): additive, no
    // existing namespace changed. ⚠️ NOT YET re-vendored into the SDK: that is
    // Phase 3 of the plan (vendor copy + `NAMESPACE_TYPES` + regenerate; the
    // publish is the owner's). Until then the SDK's generated config types
    // simply do not know the namespace. Previous pin 2026-10-16
    // (5bb0025e…88a0, SDK 0.16.0).
    sha256: 'cb100aaa3d6aff25c7ad1ad91c887f275616ec3a62036eb16fa1c8c19a3d0959',
    vendoredAs: 'vendor/config-contract.json (verbatim copy)',
    pinnedAt: '2026-11-21',
  },
  {
    file: 'src/schemas/capabilities.ts',
    // 2026-10-13: v2 `peripherals.obd` (plans/obd2-bluetooth-integration, P2
    // backend): adapter/transport enums, rateHz, the closed OBD_FIELDS
    // vocabulary, info. Mirrored into vendor/io-capabilities.schema.json in
    // epyelabs/xorgate-sdk-js on branch feat/obd-peripherals (SDK 0.14.0,
    // regenerated; publish is the owner's). Previous pin, 2026-08-24:
    // schemaVersion 2 (cm4-support plan).
    // 2026-10-16: OBD_FIELDS appends the three torque fields after `link`
    // (SDK 0.16.0, branch feat/obd-torque). Previous pin 2026-10-13 (P2).
    sha256: '32bca71a6aad30cc87dbbb623827359c6cf9fec19622c00a52dd0d56c70399fe',
    vendoredAs: 'vendor/io-capabilities.schema.json (hand-derived mirror)',
    pinnedAt: '2026-10-16',
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
