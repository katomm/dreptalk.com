// Profile URL slugs for DReps: a readable, keyword-carrying path segment built
// from the CIP-119 name plus a short tail of the DRep id for uniqueness
// ("lisa-cardano-9zulj"). Pure functions, no I/O; the sync backfill assigns
// slugs and the route/links consume them.

// Base length cap: long enough for a full name, short enough for a clean URL.
const BASE_MAX = 40;
// The id tail disambiguates equal names. Names are free-form on-chain metadata,
// so collisions and impersonation are possible; the tail is drawn from the
// bech32 id (charset [a-z0-9], slug-safe) and is effectively unique per DRep.
const SUFFIX_LEN = 5;
// Fallback tail when two DReps share both name base and short tail.
const SUFFIX_LEN_LONG = 10;

/**
 * Lowercased, ASCII-folded slug base of a display name: diacritics stripped,
 * non-alphanumeric runs collapsed to single hyphens, trimmed and capped.
 * Returns '' when nothing slug-safe remains (e.g. a fully non-Latin name).
 */
export function slugBase(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BASE_MAX)
    .replace(/-+$/, '');
}

/**
 * The profile slug for a DRep, or null when the name yields no usable base
 * (no name, or a name with no ASCII-foldable characters). Those DReps keep
 * their id-based URL.
 */
export function drepSlug(name: string | null, drepId: string, suffixLen: number = SUFFIX_LEN): string | null {
  if (!name) return null;
  const base = slugBase(name);
  if (!base) return null;
  return `${base}-${drepId.slice(-suffixLen)}`;
}

/**
 * Assigns slugs to the given DReps, avoiding the already-taken set (mutated as
 * slugs are claimed). On a collision the id tail is lengthened; the rare row
 * that still collides is skipped and simply keeps its id URL.
 */
export function assignSlugs(
  rows: { drepId: string; name: string | null }[],
  taken: Set<string>,
): { drepId: string; slug: string }[] {
  const out: { drepId: string; slug: string }[] = [];
  for (const row of rows) {
    let slug = drepSlug(row.name, row.drepId);
    if (!slug) continue;
    if (taken.has(slug)) slug = drepSlug(row.name, row.drepId, SUFFIX_LEN_LONG);
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);
    out.push({ drepId: row.drepId, slug });
  }
  return out;
}
