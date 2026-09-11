import { randomBytes } from 'node:crypto';
import { classNameError } from './names';

/**
 * The ordered class list a dataset carries (`datasets.classes`, design §4b):
 * `[{ id, name, color }]`. Ids are stable (a rename touches no annotation),
 * the order is the `classNames` order every version freezes, and the COCO
 * category id of a class is its index in that order at version time.
 */

export interface DatasetClass {
  id: string;
  name: string;
  /** `#rrggbb` */
  color: string;
}

export const MAX_CLASSES = 64;

/** Twelve distinguishable colors; classes past the twelfth wrap around. */
export const CLASS_PALETTE: readonly string[] = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#46f0f0',
  '#f032e6',
  '#bcf60c',
  '#fabebe',
  '#008080',
  '#e6beff',
];

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function newClassId(): string {
  return `c_${randomBytes(4).toString('hex')}`;
}

export type ClassInput = { id?: string; name: string; color?: string };

export type ClassEditResult =
  | { ok: true; classes: DatasetClass[]; removed: string[]; added: string[] }
  | { ok: false; error: string };

/**
 * Applies a full replacement list to the previous list: entries carrying a
 * known `id` keep it (rename, recolor, reorder), entries without one are new
 * classes, and a previous class absent from `next` is a deletion, refused
 * while `usage` reports annotations on it. Names must be unique
 * case-insensitively. Pure; the handler supplies `usage` from the DB.
 */
export function applyClassEdits(
  previous: DatasetClass[],
  next: ClassInput[],
  usage: ReadonlyMap<string, number> = new Map(),
): ClassEditResult {
  if (next.length === 0) return { ok: false, error: 'At least one class is required' };
  if (next.length > MAX_CLASSES) return { ok: false, error: `At most ${MAX_CLASSES} classes` };
  const prevById = new Map(previous.map((c) => [c.id, c]));
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const classes: DatasetClass[] = [];
  const added: string[] = [];
  for (let i = 0; i < next.length; i++) {
    const entry = next[i];
    const nameErr = classNameError(entry.name);
    if (nameErr) return { ok: false, error: `Class ${i + 1}: ${nameErr}` };
    const name = entry.name.trim();
    const lower = name.toLowerCase();
    if (seenNames.has(lower)) return { ok: false, error: `Duplicate class name "${name}"` };
    seenNames.add(lower);
    let id = entry.id;
    if (id !== undefined) {
      if (!prevById.has(id)) return { ok: false, error: `Unknown class id "${id}"` };
      if (seenIds.has(id)) return { ok: false, error: `Class id "${id}" appears twice` };
    } else {
      id = newClassId();
      while (prevById.has(id) || seenIds.has(id)) id = newClassId();
      added.push(id);
    }
    seenIds.add(id);
    const color =
      entry.color !== undefined
        ? entry.color
        : (prevById.get(id)?.color ?? CLASS_PALETTE[classes.length % CLASS_PALETTE.length]);
    if (!COLOR_RE.test(color)) return { ok: false, error: `Class "${name}": color must be #rrggbb` };
    classes.push({ id, name, color: color.toLowerCase() });
  }
  const removed = previous.filter((c) => !seenIds.has(c.id)).map((c) => c.id);
  for (const id of removed) {
    const n = usage.get(id) ?? 0;
    if (n > 0) {
      const name = prevById.get(id)?.name ?? id;
      return { ok: false, error: `Class "${name}" is used by ${n} annotation(s) and cannot be deleted` };
    }
  }
  return { ok: true, classes, removed, added };
}

/** A fresh list from names only (dataset creation). */
export function classesFromNames(names: string[]): ClassEditResult {
  return applyClassEdits(
    [],
    names.map((name) => ({ name })),
  );
}

/** Class id -> its index in the ordered list (the COCO category id at version time). */
export function classIndexMap(classes: readonly DatasetClass[]): Map<string, number> {
  return new Map(classes.map((c, i) => [c.id, i]));
}

/** Reads a stored `classes` jsonb defensively (rows are trusted, but shapes drift). */
export function parseStoredClasses(value: unknown): DatasetClass[] {
  if (!Array.isArray(value)) return [];
  const out: DatasetClass[] = [];
  for (const v of value) {
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as DatasetClass).id === 'string' &&
      typeof (v as DatasetClass).name === 'string'
    ) {
      const c = v as DatasetClass;
      out.push({
        id: c.id,
        name: c.name,
        color: typeof c.color === 'string' ? c.color : CLASS_PALETTE[out.length % CLASS_PALETTE.length],
      });
    }
  }
  return out;
}
