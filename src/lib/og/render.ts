// Thin wrapper over workers-og's ImageResponse: renders an HTML string to a
// 1200x630 PNG and attaches a long, crawler-friendly cache policy. Each card is
// cheap to render but stable for a content version, so the CDN can serve it warm.

import { ImageResponse } from 'workers-og';
import type { OgFont } from './fonts.js';
import { OG_HEIGHT, OG_WIDTH } from './theme.js';

// Re-rendered only when the action/DRep changes; an hour of browser cache and a
// day at the edge keeps shares fast while letting tally/stat updates flow through.
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

export function ogPng(html: string, fonts: OgFont[]): Response {
  const image = new ImageResponse(html, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  const headers = new Headers(image.headers);
  headers.set('Cache-Control', CACHE_CONTROL);
  return new Response(image.body, { status: image.status, headers });
}
