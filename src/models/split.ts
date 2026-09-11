import { createHash } from 'node:crypto';

/**
 * The split algorithm, a port of the forge's `xorgate_forge.dataset.split`
 * (`assign_splits`) so a version built here and `xmf dataset split` on the
 * same inputs agree image for image. Groups (an image's `group`, else its own
 * id) are ordered by a seeded sha256 rank and dealt to the splits by
 * cumulative fraction, the split with the largest unfilled share taking the
 * next group; images named in `keep` stay where they were and the fractions
 * apply to the rest.
 */

export type Split = 'train' | 'val' | 'test';
export const SPLITS: readonly Split[] = ['train', 'val', 'test'];

export interface SplitFractions {
  train: number;
  val: number;
  test: number;
}

export interface SplitImage {
  id: string;
  group: string | null;
}

export type SplitAssignment = Record<string, Split>;

/** `int.from_bytes(sha256(f"{seed}:{key}")[:8], "big") / 2**64`, as the forge ranks. */
export function splitRank(key: string, seed: number): number {
  const digest = createHash('sha256').update(`${seed}:${key}`).digest();
  const hi = digest.readBigUInt64BE(0);
  return Number(hi) / 2 ** 64;
}

export function assignSplits(
  images: readonly SplitImage[],
  fractions: SplitFractions,
  seed = 0,
  keep: Readonly<SplitAssignment> = {},
): SplitAssignment {
  const total = fractions.train + fractions.val + fractions.test;
  if (!(total > 0)) throw new Error('split fractions must sum to a positive number');
  const frTrain = fractions.train / total;
  const frVal = fractions.val / total;
  const out: SplitAssignment = {};
  const groups = new Map<string, string[]>();
  for (const img of images) {
    const kept = keep[img.id];
    if (kept !== undefined) {
      out[img.id] = kept;
      continue;
    }
    const key = img.group ?? img.id;
    const list = groups.get(key);
    if (list) list.push(img.id);
    else groups.set(key, [img.id]);
  }
  if (groups.size === 0) return out;
  const ordered = [...groups.entries()]
    .map(([key, ids]) => ({ key, ids, rank: splitRank(key, seed) }))
    .sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const remaining = ordered.reduce((n, g) => n + g.ids.length, 0);
  const quota: Record<Split, number> = { train: frTrain * remaining, val: frVal * remaining, test: 0 };
  quota.test = remaining - quota.train - quota.val;
  const filled: Record<Split, number> = { train: 0, val: 0, test: 0 };
  for (const g of ordered) {
    // The split with the largest unfilled share takes this group; ties go to
    // the earliest of train, val, test (the forge's `-order.index(s)` tiebreak).
    let target: Split = 'train';
    let best = -Infinity;
    for (const s of SPLITS) {
      const share = quota[s] - filled[s];
      if (share > best) {
        best = share;
        target = s;
      }
    }
    if (quota[target] - filled[target] <= 0) target = 'train';
    for (const id of g.ids) out[id] = target;
    filled[target] += g.ids.length;
  }
  return out;
}

export function splitCounts(assignment: Readonly<SplitAssignment>): Record<Split, number> {
  const counts: Record<Split, number> = { train: 0, val: 0, test: 0 };
  for (const s of Object.values(assignment)) counts[s] += 1;
  return counts;
}
