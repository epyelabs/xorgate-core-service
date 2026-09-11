import { classIndexMap, type DatasetClass } from './classes';
import { buildCocoFile, buildDatasetHeader, buildSplitsFile, type CocoFile, type DatasetHeader, type VersionBox, type VersionImage } from './coco';
import { checkHealth, computeStats, type Health, type VersionStats } from './health';
import { versionImageFileName } from './keys';
import { assignSplits, splitCounts, type Split, type SplitAssignment, type SplitFractions } from './split';

/**
 * Everything a dataset version is, computed from rows (pure). The POST
 * handler runs it to refuse an unhealthy version before a row exists; the
 * builder runs it again on the same inputs to write the files. Same code,
 * same seed, same answer.
 */

export interface VersionItemInput {
  id: string;
  ext: string;
  width: number;
  height: number;
  groupKey: string | null;
  source: unknown;
}

export interface VersionAnnotationInput {
  itemId: string;
  classId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  source: string | null;
  confidence: number | null;
}

export interface VersionConfig {
  split: SplitFractions;
  seed: number;
  keepPrevious: boolean;
  includeAiLabeled: boolean;
}

export interface PreparedVersion {
  classNames: string[];
  splits: SplitAssignment;
  splitCounts: Record<Split, number>;
  stats: VersionStats;
  health: Health;
  images: VersionImage[];
  boxes: VersionBox[];
  /** Annotations that named a class no longer in the dataset (dropped, counted). */
  droppedBoxes: number;
}

export function prepareVersion(
  classes: readonly DatasetClass[],
  items: readonly VersionItemInput[],
  annotations: readonly VersionAnnotationInput[],
  config: VersionConfig,
  keep: Readonly<SplitAssignment> = {},
): PreparedVersion {
  const classNames = classes.map((c) => c.name);
  const index = classIndexMap(classes);
  const images: VersionImage[] = items.map((it) => ({
    id: it.id,
    fileName: versionImageFileName(it.id, it.ext),
    width: it.width,
    height: it.height,
    group: it.groupKey,
    source: it.source,
  }));
  const boxes: VersionBox[] = [];
  let droppedBoxes = 0;
  for (const a of annotations) {
    const classIndex = index.get(a.classId);
    if (classIndex === undefined) {
      droppedBoxes += 1;
      continue;
    }
    boxes.push({
      imageId: a.itemId,
      classIndex,
      x1: a.x1,
      y1: a.y1,
      x2: a.x2,
      y2: a.y2,
      source: a.source,
      confidence: a.confidence,
    });
  }
  const splitImages = images.map((img) => ({ id: img.id, group: img.group }));
  // Only images still in the version may be kept; a kept id that left the
  // dataset must not reappear in splits.json (the forge warns on it).
  const present = new Set(images.map((i) => i.id));
  const keepPresent: SplitAssignment = {};
  if (config.keepPrevious) {
    for (const [id, split] of Object.entries(keep)) if (present.has(id)) keepPresent[id] = split;
  }
  const splits = assignSplits(splitImages, config.split, config.seed, keepPresent);
  const stats = computeStats(
    splitImages,
    boxes.map((b) => ({ imageId: b.imageId, classIndex: b.classIndex })),
    splits,
    classNames,
  );
  const health = checkHealth(stats, splitImages, splits, classNames);
  return { classNames, splits, splitCounts: splitCounts(splits), stats, health, images, boxes, droppedBoxes };
}

export interface VersionFiles {
  header: DatasetHeader;
  coco: CocoFile;
  splits: Record<string, Split>;
}

export function buildVersionFiles(
  prepared: PreparedVersion,
  meta: { datasetId: string; datasetName: string; version: number; createdAt: string; message?: string | null },
): VersionFiles {
  const description = meta.message
    ? `${meta.datasetName} v${meta.version}: ${meta.message}`
    : `${meta.datasetName} v${meta.version}`;
  return {
    header: buildDatasetHeader({
      classNames: prepared.classNames,
      imageCount: prepared.images.length,
      splitCounts: prepared.splitCounts,
      datasetId: meta.datasetId,
      datasetName: meta.datasetName,
      version: meta.version,
      createdAt: meta.createdAt,
    }),
    coco: buildCocoFile({
      description,
      version: meta.version,
      createdAt: meta.createdAt,
      classNames: prepared.classNames,
      images: prepared.images,
      boxes: prepared.boxes,
    }),
    splits: buildSplitsFile(prepared.splits),
  };
}
