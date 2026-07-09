// Profile URL slug primitives, shared by DReps and pools: a readable base from a
// free-form name plus a short tail of the bech32 id for uniqueness. Pure, no I/O.

// Base length cap: long enough for a full name, short enough for a clean URL.
const BASE_MAX = 40;

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
 * A slug base joined to a tail of the bech32 id (charset [a-z0-9], slug-safe),
 * which disambiguates equal bases. Callers pass a longer tail on collision.
 */
export function slugWithIdTail(base: string, id: string, len: number): string {
  return `${base}-${id.slice(-len)}`;
}
