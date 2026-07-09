// Profile URL slugs for pools: the ticker (or name) plus a short tail of the
// bech32 pool id for uniqueness ("hype-4x9k2"). Pure functions, no I/O; the
// gov-sync backfill assigns slugs and the route/links consume them.
import { slugBase, slugWithIdTail } from '../slug.js';

const SUFFIX_LEN = 5;
const SUFFIX_LEN_LONG = 10;

/** The profile slug for a pool, or null when the name yields no usable base. */
export function poolSlug(name: string | null, poolId: string, suffixLen: number = SUFFIX_LEN): string | null {
  if (!name) return null;
  const base = slugBase(name);
  if (!base) return null;
  return slugWithIdTail(base, poolId, suffixLen);
}

/**
 * Assigns slugs to the given pools from a pre-computed base (ticker or name),
 * avoiding the already-taken set (mutated as slugs are claimed). On a collision
 * the id tail is lengthened; a row that still collides keeps its id URL.
 */
export function assignPoolSlugs(
  rows: { poolId: string; base: string | null }[],
  taken: Set<string>,
): { poolId: string; slug: string }[] {
  const out: { poolId: string; slug: string }[] = [];
  for (const row of rows) {
    let slug = poolSlug(row.base, row.poolId);
    if (!slug) continue;
    if (taken.has(slug)) slug = poolSlug(row.base, row.poolId, SUFFIX_LEN_LONG);
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);
    out.push({ poolId: row.poolId, slug });
  }
  return out;
}
