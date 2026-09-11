import type { Split, SplitAssignment } from './split';

/**
 * Writers for the three files of a forge dataset v1 (the forge repo's
 * `contracts/dataset.schema.json`, `annotations.schema.json` and
 * `splits.schema.json`, frozen at M1): `dataset.json`, one COCO detection
 * file with 0-based category ids and string image ids, and `splits.json`.
 * Boxes arrive as absolute xyxy (the platform's one internal representation)
 * and leave as COCO `[x, y, w, h]`.
 */

export interface VersionImage {
  id: string;
  fileName: string;
  width: number;
  height: number;
  group: string | null;
  source: unknown;
}

export interface VersionBox {
  imageId: string;
  classIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  source?: string | null;
  confidence?: number | null;
}

export interface CocoFile {
  info: Record<string, unknown>;
  categories: Array<{ id: number; name: string }>;
  images: Array<{
    id: string;
    file_name: string;
    width: number;
    height: number;
    group: string | null;
    source: unknown;
  }>;
  annotations: Array<{
    id: number;
    image_id: string;
    category_id: number;
    bbox: [number, number, number, number];
    area: number;
    iscrowd: 0;
    source: string | null;
    confidence: number | null;
  }>;
}

export interface DatasetHeader {
  datasetVersion: 1;
  task: 'object_detection';
  classes: string[];
  categoryIds: 'zero-based';
  images: number;
  splits: Record<Split, number>;
  source: {
    platform: string;
    datasetId: string;
    datasetName: string;
    version: number;
    createdAt: string;
  };
}

/** Two decimals is what the forge's own writer keeps and well under a pixel. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Absolute xyxy -> COCO xywh, clamped inside the image so the forge's bounds check holds. */
export function cocoBbox(box: VersionBox, width: number, height: number): [number, number, number, number] {
  const x1 = Math.min(Math.max(box.x1, 0), width);
  const y1 = Math.min(Math.max(box.y1, 0), height);
  const x2 = Math.min(Math.max(box.x2, 0), width);
  const y2 = Math.min(Math.max(box.y2, 0), height);
  return [round2(x1), round2(y1), round2(x2 - x1), round2(y2 - y1)];
}

export function buildCocoFile(args: {
  description: string;
  version: number;
  createdAt: string;
  classNames: readonly string[];
  images: readonly VersionImage[];
  boxes: readonly VersionBox[];
}): CocoFile {
  const byId = new Map(args.images.map((img) => [img.id, img]));
  const annotations: CocoFile['annotations'] = [];
  let nextId = 1;
  for (const box of args.boxes) {
    const img = byId.get(box.imageId);
    if (!img) continue;
    if (box.classIndex < 0 || box.classIndex >= args.classNames.length) continue;
    const bbox = cocoBbox(box, img.width, img.height);
    if (bbox[2] <= 0 || bbox[3] <= 0) continue;
    annotations.push({
      id: nextId++,
      image_id: box.imageId,
      category_id: box.classIndex,
      bbox,
      area: round2(bbox[2] * bbox[3]),
      iscrowd: 0,
      source: box.source ?? null,
      confidence: box.confidence ?? null,
    });
  }
  return {
    info: { description: args.description, version: String(args.version), date_created: args.createdAt },
    categories: args.classNames.map((name, id) => ({ id, name })),
    images: args.images.map((img) => ({
      id: img.id,
      file_name: img.fileName,
      width: img.width,
      height: img.height,
      group: img.group,
      source: img.source ?? null,
    })),
    annotations,
  };
}

export function buildDatasetHeader(args: {
  classNames: readonly string[];
  imageCount: number;
  splitCounts: Record<Split, number>;
  datasetId: string;
  datasetName: string;
  version: number;
  createdAt: string;
}): DatasetHeader {
  return {
    datasetVersion: 1,
    task: 'object_detection',
    classes: [...args.classNames],
    categoryIds: 'zero-based',
    images: args.imageCount,
    splits: { train: args.splitCounts.train, val: args.splitCounts.val, test: args.splitCounts.test },
    source: {
      platform: 'xorgate',
      datasetId: args.datasetId,
      datasetName: args.datasetName,
      version: args.version,
      createdAt: args.createdAt,
    },
  };
}

/** `splits.json`: image id -> split, keys sorted so the file is byte-stable. */
export function buildSplitsFile(splits: Readonly<SplitAssignment>): Record<string, Split> {
  const out: Record<string, Split> = {};
  for (const id of Object.keys(splits).sort()) out[id] = splits[id];
  return out;
}
