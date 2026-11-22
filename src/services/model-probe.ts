import type { DeviceModel } from '../db/schema';
import {
  ioCapabilitiesV2Schema,
  platformFromDtModel,
  type Platform,
} from '../schemas/capabilities';

/**
 * Probe-at-claim model assignment (cm4-support plan, D3).
 *
 * install.sh sends what the hardware says about itself with the claim:
 * `/proc/device-tree/model` and, when cameras are already bound, how many. This
 * maps that probe onto the model catalog. Pure — the handler supplies the
 * catalog — so the narrowing rules are unit-testable without a DB.
 *
 * Rules:
 * - Only v2 models are candidates (v1 rows declare no platform to match on).
 * - Platform must match. Camera count narrows FURTHER only when the probe saw
 *   at least one camera: on a fresh install the sensors' overlays aren't in
 *   config.txt yet, so a 0/absent count means "unknown", not "zero cameras".
 * - When the probe saw none, the number of cameras the OPERATOR declared on
 *   the registration stands in as the count (`declaredCameras`,
 *   plans/support-other-camera-models). That is the fresh-OS case exactly: the
 *   probe runs before any overlay line is written, so it can only say 0, while
 *   the Register dialog already knows how many sensors were picked.
 * - The declared count is also a LOWER BOUND on a count the probe did measure:
 *   when the registration declares more sensors than the probe saw, the
 *   declared count is used. The installer counts cameras BEFORE its package
 *   step, so a sensor that needs extra OS packages (the IMX335 on stock
 *   libcamera) is not listed yet: a two-camera device then reports 1, and
 *   narrowing on that 1 would assign a one-camera SKU with `needs_model`
 *   false, mint one channel, and drop the declared sensor of the port that
 *   SKU lacks. A measured count that is at least the declared one is used as
 *   measured, exactly as before.
 * - Exactly one candidate → assigned, done. Anything else (unknown platform,
 *   no candidate, two SKUs the probe can't separate) → the claim keeps
 *   `fallback` (the registration's model) and flags the device `needs_model`
 *   for one-click resolution in the console — never a failed install.
 */

export interface ClaimProbe {
  dtModel?: string | null;
  /** Number of cameras libcamera enumerated at install time; 0/absent = unknown. */
  cameras?: number | null;
  /**
   * Number of camera ports the registration declares a sensor on (`none` not
   * counted). Used as the count when `cameras` is 0/absent, and when it is
   * LARGER than `cameras` (the device cannot see every declared camera at
   * claim time). 0/absent = nothing declared: the measured count stands alone.
   */
  declaredCameras?: number | null;
}

export interface ModelResolution {
  model: DeviceModel;
  needsModel: boolean;
  /** Why this resolution — logged with the claim for onboarding forensics. */
  reason: string;
  platform: Platform | null;
}

function videoCount(model: DeviceModel): number | null {
  const parsed = ioCapabilitiesV2Schema.safeParse(model.ioCapabilities);
  if (!parsed.success) return null;
  return (parsed.data.media?.video ?? []).length;
}

function modelPlatform(model: DeviceModel): Platform | null {
  const parsed = ioCapabilitiesV2Schema.safeParse(model.ioCapabilities);
  return parsed.success ? parsed.data.system.platform : null;
}

/** A camera count as a whole positive number; anything else is 0 = unknown. */
function positiveCount(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function resolveModel(
  catalog: DeviceModel[],
  fallback: DeviceModel,
  probe: ClaimProbe,
): ModelResolution {
  const platform = platformFromDtModel(probe.dtModel);
  if (!platform) {
    return {
      model: fallback,
      needsModel: true,
      reason: `probe platform unrecognized (dtModel=${JSON.stringify(probe.dtModel ?? null)})`,
      platform: null,
    };
  }

  let candidates = catalog.filter((m) => modelPlatform(m) === platform);
  // With nothing declared the measured count is used exactly as before. A
  // declared count replaces it when the probe saw none, and when the probe saw
  // FEWER cameras than the registration declares (the lower bound above).
  const probed = probe.cameras ?? 0;
  const measured = probed > 0;
  const declared = positiveCount(probe.declaredCameras);
  const useDeclared = !measured || declared > probed;
  const cameras = useDeclared ? declared : probed;
  const countSource = !useDeclared ? '' : measured ? ` declared, probe saw ${probed}` : ' declared';
  if (cameras > 0 && candidates.length > 1) {
    const narrowed = candidates.filter((m) => videoCount(m) === cameras);
    // A camera count matching nothing is treated as non-narrowing rather than
    // eliminating: a half-wired bench must not exclude every real model.
    if (narrowed.length > 0) candidates = narrowed;
  }

  if (candidates.length === 1) {
    return {
      model: candidates[0],
      needsModel: false,
      reason: `probe matched ${candidates[0].sku} (platform=${platform}${cameras > 0 ? `, cameras=${cameras}${countSource}` : ''})`,
      platform,
    };
  }
  return {
    model: fallback,
    needsModel: true,
    reason:
      candidates.length === 0
        ? `no ${platform} model in the catalog`
        : `ambiguous: ${candidates.length} ${platform} models match`,
    platform,
  };
}
