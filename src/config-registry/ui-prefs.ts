import { z } from 'zod';

/**
 * Cloud-only presentation preferences (`devices.ui_prefs`). Deliberately a
 * SEPARATE registry from the device-config namespaces: nothing here is ever
 * published to the device, and keeping the two lists apart is what makes the
 * split visible in code instead of only in a comment (design.md §3 goal 2 —
 * before this, "delivered to the device" vs "cloud-only" was distinguishable
 * only by reading the publish trigger list in the handler).
 *
 * Written by `PATCH /devices/{id}/ui-prefs`, which never publishes and never
 * bumps `config_rev`.
 */
export const IMU_VIEW_AZIMUTH_MIN = -360;
export const IMU_VIEW_AZIMUTH_MAX = 360;
// Elevation stops shy of the poles: at ±90° the view's look-at up-vector
// degenerates and the camera flips. Previously silently clamped on write; now
// rejected 4xx like every other out-of-range config value (the UI rolls the
// field back to the stored value on the error).
export const IMU_VIEW_ELEVATION_MIN = -85;
export const IMU_VIEW_ELEVATION_MAX = 85;

export const ACTIVE_STREAMS_VIEW_TYPES = ['card', 'map'] as const;

export const activeStreamsViewTypeSchema = z
  .enum(ACTIVE_STREAMS_VIEW_TYPES)
  .describe(
    'Layout for the Active Streams tab: card grid (default) or location-first map view.',
  );

export const imuViewSchema = z
  .object({
    azimuthDeg: z
      .number()
      .finite()
      .min(IMU_VIEW_AZIMUTH_MIN)
      .max(IMU_VIEW_AZIMUTH_MAX)
      .describe('Camera azimuth for the 3D orientation view, degrees.'),
    elevationDeg: z
      .number()
      .finite()
      .min(IMU_VIEW_ELEVATION_MIN)
      .max(IMU_VIEW_ELEVATION_MAX)
      .describe(
        'Camera elevation for the 3D orientation view, degrees. Bounded to ±85: at the poles ' +
          'the look-at up-vector degenerates and the view flips.',
      ),
  })
  .strict();

export type ImuView = z.infer<typeof imuViewSchema>;
export type ActiveStreamsViewType = z.infer<typeof activeStreamsViewTypeSchema>;

export const uiPrefsSchema = z
  .object({
    activeStreamsViewType: activeStreamsViewTypeSchema.optional(),
    imuView: imuViewSchema.optional(),
  })
  .strict();

export type UiPrefs = z.infer<typeof uiPrefsSchema>;

/**
 * What the web app renders when a pref has never been set. `imuView` mirrors
 * the orientation view's built-in 3/4 angle; the backend never applies these,
 * it only publishes them in the contract artifact so the UI has one source.
 */
export const UI_PREFS_DEFAULTS = {
  activeStreamsViewType: 'card',
  imuView: { azimuthDeg: 45, elevationDeg: 24 },
} as const;

/** Per-key spec for the two prefs, used to build the OpenAPI block. */
export const UI_PREF_KEYS = ['activeStreamsViewType', 'imuView'] as const;
export type UiPrefKey = (typeof UI_PREF_KEYS)[number];

/** `null` reverts a pref to its default (the stored key is deleted). */
export function parseUiPrefsPatch(
  body: unknown,
): { value: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be an object of ui-pref keys' };
  }
  const src = body as Record<string, unknown>;
  const keys = Object.keys(src);
  if (keys.length === 0) return { error: 'no ui-pref keys provided' };
  const unknown = keys.filter((k) => !(UI_PREF_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return { error: `unknown ui-pref key(s): ${unknown.join(', ')}` };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const raw = src[key];
    if (raw === null) {
      out[key] = null;
      continue;
    }
    const schema = key === 'imuView' ? imuViewSchema : activeStreamsViewTypeSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `${key}.${issue.path.join('.')}` : key;
      return { error: `${path}: ${issue?.message ?? 'invalid'}` };
    }
    out[key] = parsed.data;
  }
  return { value: out };
}
