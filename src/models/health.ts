import type { Split, SplitAssignment } from './split';

/**
 * Version stats and the health check (design §4b `stats`, `health`; the
 * rules the forge's `xmf dataset validate` applies, run here BEFORE the build
 * so a version the forge would reject is refused at POST time with the same
 * wording). Errors refuse the version; warnings ride along on the row.
 */

export interface StatImage {
  id: string;
  group: string | null;
}

export interface StatBox {
  imageId: string;
  classIndex: number;
}

export interface PerSplit {
  train: number;
  val: number;
  test: number;
}

export interface VersionStats {
  images: PerSplit;
  annotations: PerSplit;
  /** Class name -> annotation counts per split. */
  perClass: Record<string, PerSplit>;
  /** Images that carry no box (background images), per split. */
  emptyImages: PerSplit;
}

export type HealthCode =
  | 'NO_IMAGES'
  | 'NO_TRAIN'
  | 'NO_VAL'
  | 'CLASS_NO_VAL_INSTANCES'
  | 'CLASS_FEW_VAL_INSTANCES'
  | 'CLASS_NO_ANNOTATIONS'
  | 'FEW_IMAGES'
  | 'GROUP_STRADDLES_SPLITS';

export interface HealthIssue {
  code: HealthCode;
  message: string;
  className?: string;
}

export interface Health {
  ok: boolean;
  errors: HealthIssue[];
  warnings: HealthIssue[];
}

/** The forge's `DEFAULT_MIN_VAL_INSTANCES`: below this a class is a warning, at zero an error. */
export const MIN_VAL_INSTANCES = 5;
/** Fewer images than this trains something, but rarely something worth the compute. */
export const FEW_IMAGES = 20;

function zero(): PerSplit {
  return { train: 0, val: 0, test: 0 };
}

export function computeStats(
  images: readonly StatImage[],
  boxes: readonly StatBox[],
  splits: Readonly<SplitAssignment>,
  classNames: readonly string[],
): VersionStats {
  const stats: VersionStats = { images: zero(), annotations: zero(), perClass: {}, emptyImages: zero() };
  for (const name of classNames) stats.perClass[name] = zero();
  const boxesPerImage = new Map<string, number>();
  for (const b of boxes) {
    const split = splits[b.imageId];
    if (!split) continue;
    stats.annotations[split] += 1;
    const name = classNames[b.classIndex];
    if (name !== undefined) stats.perClass[name][split] += 1;
    boxesPerImage.set(b.imageId, (boxesPerImage.get(b.imageId) ?? 0) + 1);
  }
  for (const img of images) {
    const split = splits[img.id];
    if (!split) continue;
    stats.images[split] += 1;
    if (!boxesPerImage.has(img.id)) stats.emptyImages[split] += 1;
  }
  return stats;
}

export function checkHealth(
  stats: VersionStats,
  images: readonly StatImage[],
  splits: Readonly<SplitAssignment>,
  classNames: readonly string[],
  opts: { minValInstances?: number } = {},
): Health {
  const minVal = opts.minValInstances ?? MIN_VAL_INSTANCES;
  const errors: HealthIssue[] = [];
  const warnings: HealthIssue[] = [];
  const total = stats.images.train + stats.images.val + stats.images.test;
  if (total === 0) {
    errors.push({ code: 'NO_IMAGES', message: 'No labeled image to build a version from' });
    return { ok: false, errors, warnings };
  }
  if (stats.images.train === 0) errors.push({ code: 'NO_TRAIN', message: 'No image is in the train split' });
  if (stats.images.val === 0) errors.push({ code: 'NO_VAL', message: 'No image is in the val split' });
  for (const name of classNames) {
    const per = stats.perClass[name] ?? zero();
    const all = per.train + per.val + per.test;
    if (all === 0) {
      warnings.push({
        code: 'CLASS_NO_ANNOTATIONS',
        className: name,
        message: `class "${name}" has no annotation in any split`,
      });
      continue;
    }
    if (per.val === 0) {
      errors.push({
        code: 'CLASS_NO_VAL_INSTANCES',
        className: name,
        message: `class "${name}" has no instance in the val split`,
      });
    } else if (per.val < minVal) {
      warnings.push({
        code: 'CLASS_FEW_VAL_INSTANCES',
        className: name,
        message: `class "${name}" has only ${per.val} val instance(s) (floor ${minVal})`,
      });
    }
  }
  if (total < FEW_IMAGES) {
    warnings.push({
      code: 'FEW_IMAGES',
      message: `only ${total} image(s); results below ${FEW_IMAGES} are rarely useful`,
    });
  }
  const byGroup = new Map<string, Set<Split>>();
  for (const img of images) {
    const split = splits[img.id];
    if (!img.group || !split) continue;
    const set = byGroup.get(img.group) ?? new Set<Split>();
    set.add(split);
    byGroup.set(img.group, set);
  }
  const straddling = [...byGroup.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([g]) => g)
    .sort();
  if (straddling.length > 0) {
    warnings.push({
      code: 'GROUP_STRADDLES_SPLITS',
      message: `${straddling.length} group(s) have images in more than one split: ${straddling.slice(0, 5).join(', ')}`,
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}
