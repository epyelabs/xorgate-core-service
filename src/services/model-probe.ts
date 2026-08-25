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
 * - Exactly one candidate → assigned, done. Anything else (unknown platform,
 *   no candidate, two SKUs the probe can't separate) → the claim keeps
 *   `fallback` (the registration's model) and flags the device `needs_model`
 *   for one-click resolution in the console — never a failed install.
 */

export interface ClaimProbe {
  dtModel?: string | null;
  /** Number of cameras libcamera enumerated at install time; 0/absent = unknown. */
  cameras?: number | null;
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
  const cameras = probe.cameras ?? 0;
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
      reason: `probe matched ${candidates[0].sku} (platform=${platform}${cameras > 0 ? `, cameras=${cameras}` : ''})`,
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
