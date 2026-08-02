// GET /og/help/:slug.png
//
// Dynamic Open Graph card for a help guide, rendered on demand and cached.
// The card is fed entirely from the bundled `guides` collection frontmatter,
// so no database is involved. An unknown slug 404s and the page keeps the
// site default image.
import type { APIRoute } from 'astro';
import { getEntry } from 'astro:content';
import { runtimeEnv } from '@/lib/api/response';
import { loadCardImage } from '@/lib/og/assets.js';
import { helpCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { helpCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const slug = params.slug;
  const entry = slug ? await getEntry('guides', slug) : undefined;
  if (!entry) return new Response('Not found', { status: 404 });

  const assets = env.ASSETS as unknown as Fetcher;
  const model = helpCardModel(entry.data);
  // Load the guide's illustration inside the build callback so it runs only on a
  // cache miss, not on every warm request. It is a rasterizer-safe PNG bundled
  // next to the source webp, absent for guides without one (card stays text-only).
  return renderOgCard(assets, request.url, async () => {
    const illustrationDataUrl = await loadCardImage(assets, request.url, `/help/og/${slug}.png`);
    return helpCardHtml({ ...model, illustrationDataUrl });
  });
};
