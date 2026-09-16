// GET /og/governance-review.png
//
// Dynamic Open Graph card for the Governance Review hub. Like the edition
// cards it is fed entirely from the bundled `review` collection, so no
// database is involved: the newest edition's headline carries the card and the
// counters below it say how much the hub holds. With no edition published yet
// the route 404s and the page keeps the site default image.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { reviewIndexCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { reviewIndexCardHtml } from '@/lib/og/templates.js';
import { loadEditions } from '@/lib/review/editions.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const editions = await loadEditions();
  const latest = editions[0];
  if (!latest) return new Response('Not found', { status: 404 });

  const model = reviewIndexCardModel({
    latestTitle: latest.data.title,
    editionCount: editions.length,
    epochFrom: Math.min(...editions.map((e) => e.data.epochFrom)),
    epochTo: latest.data.epochTo,
  });
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => reviewIndexCardHtml(model));
};
