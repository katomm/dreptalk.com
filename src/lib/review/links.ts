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
