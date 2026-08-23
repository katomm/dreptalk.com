// GET /og/match.png
//
// Dynamic Open Graph card for the Find your DRep quiz, rendered on demand and
// cached exactly like the help-guide cards. Static copy plus the matching-guide
// illustration, no database involved.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { loadCardImage } from '@/lib/og/assets.js';
import { MATCH_CARD } from '@/lib/og/matchCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { helpCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const assets = env.ASSETS as unknown as Fetcher;
  // The illustration loads inside the build callback so it runs only on a cache
  // miss. It is the rasterizer-safe PNG bundled for the matching guide.
  return renderOgCard(assets, request.url, async () => {
    const illustrationDataUrl = await loadCardImage(assets, request.url, '/help/og/drep-matching.png');
    return helpCardHtml({ ...MATCH_CARD, illustrationDataUrl });
  });
};
