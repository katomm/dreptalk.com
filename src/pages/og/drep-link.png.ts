// GET /og/drep-link.png
//
// Open Graph card for the drep.link landing page, which lives on its own worker
// and points its og:image here so the card shares the site's renderer, fonts and
// edge cache. Static content, no database.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { renderOgCard } from '@/lib/og/render.js';
import { drepLinkCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => drepLinkCardHtml());
};
