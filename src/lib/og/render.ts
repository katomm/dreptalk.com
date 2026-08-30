/// <reference types="@cloudflare/workers-types" />
// Render pipeline for the OG cards. renderOgCard is the shared endpoint tail:
// serve a warm edge-cached copy when present, else load fonts + logo (cached per
// isolate), build the HTML, add a fallback face for any script the bundled Latin
// subset cannot draw, encode the PNG, edge-cache it, and return it. Each
// card is stable for a content version, so it renders once per colo instead of
// on every crawl. A render that fails (e.g. an embedded image the rasterizer
// cannot decode) is served the site's static OG image, never a broken 0-byte card.

import { waitUntil } from 'cloudflare:workers';
import { ImageResponse } from 'workers-og';
import { loadFallbackFonts } from './fallbackFonts.js';
import { loadOgFonts, type OgFont } from './fonts.js';
import { OG_HEIGHT, OG_WIDTH } from './theme.js';

// Re-rendered only when the action/DRep/topic changes; an hour of browser cache
// and a day at the edge keeps shares fast while letting updates flow through.
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';
// A fallback is a render failure, not a stable card: keep it out of the edge
// cache and browser-cache it only briefly so a fix (or recovery) shows up fast.
const FALLBACK_CACHE_CONTROL = 'public, max-age=300';

/**
 * Encodes the card HTML to PNG bytes, or null when the render fails. satori/resvg
 * failures end the ImageResponse body stream empty while the 200 header is already
 * committed, so buffering the body and checking for zero length is the only way to
 * tell a broken render from a real one (a valid 1200x630 card is always many KB).
 */
async function renderPng(html: string, fonts: OgFont[]): Promise<ArrayBuffer | null> {
  try {
    const image = new ImageResponse(html, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
    const buf = await new Response(image.body).arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Loads fonts, builds the card HTML, encodes the PNG, and edge-caches it. On any
    render failure returns the site's static OG image so a share is never a broken
    0-byte card. `url` is the request URL, used verbatim as the content-addressed
    cache key (each card URL already carries a content version). `build` may be
    async so any per-card asset loading (e.g. an embedded illustration) runs only
    after the cache misses, not on every warm request. */
export async function renderOgCard(
  assets: Fetcher,
  url: string,
  build: () => string | Promise<string>,
): Promise<Response> {
  const cache = (caches as CacheStorage & { default: Cache }).default;
  const cacheKey = new Request(url, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  // Return a fresh, mutable copy: the security middleware decorates every response
  // and a Cache API Response carries immutable headers (see api/search.ts).
  if (cached) return new Response(cached.body, cached);

  const [fonts, html] = await Promise.all([loadOgFonts(assets, url), build()]);
  // A name outside the bundled Latin subset (CJK, Cyrillic, Greek, Latin Extended)
  // would otherwise render as an empty gap. Only such a card pays for a fallback
  // face; a Latin-only card gets an empty array without a single subrequest.
  const fallbackFonts = await loadFallbackFonts(html, fonts);
  const png = await renderPng(html, [...fonts, ...fallbackFonts]);

  if (!png) {
    // The static default card, streamed from the assets binding. Never edge-cached,
    // so a later successful render replaces it rather than pinning the fallback.
    const fallback = await assets.fetch(new URL('/og.jpg', url));
    return new Response(fallback.body, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'Cache-Control': FALLBACK_CACHE_CONTROL },
    });
  }

  const response = new Response(png, {
    status: 200,
    headers: { 'content-type': 'image/png', 'Cache-Control': CACHE_CONTROL },
  });
  // Cache write after the response is sent; the render a miss just paid for warms
  // the colo for every later share of the same card.
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
