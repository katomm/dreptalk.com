// GET /og/cc.png
//
// Open Graph card for the Constitutional Committee overview at /cc/: the key
// figures over a small seat timeline, rendered on demand and cached. Reads
// through loadCcOverview like the page, so card and page never disagree.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { loadCcOverview } from '@/lib/governance/ccLoad.js';
import { ccOverviewCardModel } from '@/lib/og/ccCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { ccOverviewCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('Not found', { status: 404 });
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, async () => {
    const { facts, timeline } = await loadCcOverview(db);
    return ccOverviewCardHtml(ccOverviewCardModel(facts, timeline));
  });
};
