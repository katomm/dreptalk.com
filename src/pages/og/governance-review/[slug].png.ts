// GET /og/governance-review/:slug.png
//
// Dynamic Open Graph card for a Governance Review edition, rendered on demand
// and cached. The card is fed entirely from the bundled `review` collection
// frontmatter, so no database is involved. An unknown or malformed slug 404s
// and the page keeps the site default image.
import type { APIRoute } from 'astro';
import { getEntry } from 'astro:content';
import { runtimeEnv } from '@/lib/api/response';
import { reviewCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { reviewCardHtml } from '@/lib/og/templates.js';
import { parseSlug } from '@/lib/review/windows.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const slug = params.slug ?? '';
  const entry = parseSlug(slug) ? await getEntry('review', slug) : undefined;
  if (!entry) return new Response('Not found', { status: 404 });
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => reviewCardHtml(reviewCardModel(entry.data)));
};
