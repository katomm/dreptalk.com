// GET /og/help/:slug.png
//
// Dynamic Open Graph card for a help guide, rendered on demand and cached.
// The card is fed entirely from the bundled `guides` collection frontmatter,
// so no database is involved. An unknown slug 404s and the page keeps the
// site default image.
import type { APIRoute } from 'astro';
import { getEntry } from 'astro:content';
import { runtimeEnv } from '@/lib/api/response';
import { helpCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { discussionCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const slug = params.slug;
  const entry = slug ? await getEntry('guides', slug) : undefined;
  if (!entry) return new Response('Not found', { status: 404 });

  const model = helpCardModel(entry.data);
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => discussionCardHtml(model));
};
