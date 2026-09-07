// Link helpers for the review pages. Pure, no Astro imports, so the components
// and the node tests can both use them.

/**
 * Href for the /ga/ resolver from a "<txHash>#<index>" action id.
 *
 * The '#' is linked as its CIP-129 hex equivalent (the index as whole hex bytes)
 * because Astro does not decode a '%23' back to '#' in the route param, so an
 * encoded id would fall through to search. Anything that is not the hash-index
 * form is passed through url-encoded.
 */
export function govActionHref(id: string): string {
  const m = /^([0-9a-f]{64})#(\d{1,6})$/.exec(id);
  if (!m) return `/ga/${encodeURIComponent(id)}/`;
  let indexHex = Number(m[2]).toString(16);
  if (indexHex.length % 2) indexHex = `0${indexHex}`;
  return `/ga/${m[1]}${indexHex}/`;
}

/**
 * Inverse of govActionHref's CIP-129 form: a captured "/ga/" path segment back
 * to the "<hash>#<index>" id the pack keys its actions by. 64 hex chars for
 * the hash, then 1 to 4 hex bytes (2 to 8 hex chars, even length) for the
 * index. Null for anything else, including the already-decoded "#" form,
 * which the caller falls back to unchanged.
 */
export function govActionIdFromPath(segment: string): string | null {
  const m = /^([0-9a-f]{64})((?:[0-9a-f]{2}){1,4})$/.exec(segment);
  if (!m) return null;
  return `${m[1]}#${Number.parseInt(m[2], 16)}`;
}
