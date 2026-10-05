// Anchor URL resolution: the scheme allowlist and the IPFS gateway mapping
// that turn an on-chain anchor URI into something a browser can open.
//
// A leaf on purpose. metadata.ts, where this used to live, pulls in the
// Markdown renderer (marked plus the xss sanitizer), the blake hasher and the
// document extractors, so a React island that only needs to link a reference
// would drag all of that into the client bundle. Nothing here imports
// anything, which is what lets the governance submit form's preview share the
// exact allowlist the action page links through instead of copying it.
// metadata.ts re-exports these, so every existing call site is unchanged.

/**
 * Public IPFS gateways, tried in order, for resolving an ipfs:// anchor.
 *
 * A list rather than a single gateway because the long-standing default,
 * ipfs.io, now answers every plain HTTPS fetch with 429 and a "switching to a
 * service worker gateway only" body, and its siblings (dweb.link, w3s.link,
 * nftstorage.link) do the same. With one hard-wired gateway that turned every
 * ipfs:// anchor on the site into "could not be retrieved", even though the
 * document was perfectly reachable elsewhere.
 *
 * Trusting the gateway is not required: whatever it hands back must still hash
 * to the on-chain anchor hash (see verifyAnchorDoc), so a hostile or broken
 * gateway can withhold a document but never substitute one. The first entry is
 * also the one used for reader-facing anchor links.
 */
export const IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.decoo.io/ipfs/',
] as const;

/**
 * The "<cid>[/path]" part of a path-style gateway URL (https://host/ipfs/<cid>),
 * or null when the URL is not one. Only the path root counts, so an ordinary
 * site that happens to have an /ipfs/ segment deeper in its path is not
 * mistaken for a gateway. The CID is not validated here: a gateway that does
 * not know it answers 404, which the fetch walk treats as a miss.
 */
function gatewayCidPath(url: URL): string | null {
  const m = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(url.pathname);
  return m ? m[1] + (m[2] ?? '') : null;
}

/**
 * Resolves an on-chain URL (anchor document or profile image) to a fetchable
 * URL: http(s) passes through, ipfs://<cid>/<path> maps to the public gateway,
 * anything else is unsupported (null). Exported so display surfaces can link
 * the anchor somewhere a browser can actually open (no ipfs: handler exists
 * for most users).
 */
export function resolveAnchorUrl(raw: string): string | null {
  return resolveAnchorUrls(raw)[0] ?? null;
}

/**
 * Every fetchable URL for an on-chain anchor, in the order they should be tried:
 * one per IPFS gateway for ipfs://, the URL itself followed by the other
 * gateways for an http(s) URL that is itself a gateway path
 * (https://<gateway>/ipfs/<cid>), a single entry for any other http(s) URL, and
 * none at all for an unsupported scheme. Only the fetch path walks the whole
 * list, display surfaces take the first entry via resolveAnchorUrl.
 *
 * The gateway form matters: proposers commonly anchor on a public gateway's
 * https URL (gateway.pinata.cloud, a quicknode or mypinata host), which makes
 * one slow or rate-limited host the only source for a document every gateway
 * can serve by CID. The on-chain hash guards the bytes wherever they come from,
 * so asking the fallback gateways for the same CID is as safe as for ipfs://.
 * The anchor's own host stays first: a private gateway may be the only one
 * that has the file pinned at all.
 */
export function resolveAnchorUrls(raw: string): string[] {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [];
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const cidPath = gatewayCidPath(url);
    if (!cidPath) return [url.href];
    const fallbacks = IPFS_GATEWAYS.map((gw) => gw + cidPath).filter((u) => u !== url.href);
    return [url.href, ...fallbacks];
  }
  if (url.protocol === 'ipfs:') {
    // ipfs://<cid>/<path> -> gateway. host holds the CID for ipfs:// URLs.
    const cidPath = (url.host + url.pathname).replace(/^\/+/, '');
    return cidPath ? IPFS_GATEWAYS.map((gw) => gw + cidPath) : [];
  }
  return [];
}
