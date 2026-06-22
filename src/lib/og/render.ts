/// <reference types="@cloudflare/workers-types" />
// Render pipeline for the OG cards. ogPng wraps workers-og's ImageResponse into a
// 1200x630 PNG with a long, crawler-friendly cache policy. renderOgCard is the
// shared endpoint tail: load fonts + logo (cached per isolate), build the HTML
// from the supplied card builder, and encode. Each card is cheap to render but
// stable for a content version, so the CDN can serve it warm.

import { ImageResponse } from 'workers-og';
import { loadOgFonts, type OgFont } from './fonts.js';
import { OG_HEIGHT, OG_WIDTH } from './theme.js';

// Re-rendered only when the action/DRep/topic changes; an hour of browser cache
// and a day at the edge keeps shares fast while letting updates flow through.
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

export function ogPng(html: string, fonts: OgFont[]): Response {
  const image = new ImageResponse(html, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  const headers = new Headers(image.headers);
  headers.set('Cache-Control', CACHE_CONTROL);
  return new Response(image.body, { status: image.status, headers });
}

/** Loads fonts, builds the card HTML, and encodes the PNG. */
export async function renderOgCard(assets: Fetcher, origin: string, build: () => string): Promise<Response> {
  const fonts = await loadOgFonts(assets, origin);
  return ogPng(build(), fonts);
}
