// Cache-busting token for an OG card image URL, appended as `?v=<token>`.
//
// Scrapers (X, Discord, LinkedIn, ...) key their image cache on the exact image
// URL. Our /og/... endpoint always renders current content, but a scraper that
// already cached the image bytes under a static URL keeps showing the old card
// even after a re-scrape. Versioning the URL by the card's visible content means
// the URL changes whenever that content changes, so any fresh scrape is forced to
// refetch the image instead of reusing stale bytes.
//
// The token is derived only from fields the page already has in hand (no extra
// queries). Continuous, time-based bits of a governance card (the expiry
// countdown) are left out, since they would churn the token on every render and
// stay fresh via the endpoint's own cache-control TTL. The live tally is the
// exception: a caller may fold in a coarse bucket of it (e.g. the yes-share
// floored to 5%) so the URL turns over when support moves meaningfully, without
// changing on every single vote.

// Bump when a card template changes in a way that should re-version every
// existing share (new layout, moved fields), independent of the underlying data.
// 2: help cards gained the guide illustration and a two-column layout.
export const OG_CARD_VERSION = 2;

// djb2, base36. Not cryptographic: a compact fingerprint whose only job is to
// change when the inputs change. A collision merely misses a cache-bust (i.e.
// degrades to the pre-versioning behaviour), so it is harmless.
function fingerprint(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * A short, stable token for the given card fields. Null/undefined parts count as
 * empty, and the order is significant, so the same inputs always yield the same
 * token and any change to a rendered field yields a different one.
 */
export function ogCardVersion(
  parts: (string | number | bigint | boolean | null | undefined)[],
): string {
  // Parts are joined with a control char no field value contains, so adjacent
  // parts can never run together into a different-but-equal input.
  return fingerprint([OG_CARD_VERSION, ...parts].map((p) => (p == null ? '' : String(p))).join(''));
}
