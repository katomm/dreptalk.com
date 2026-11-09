// GET /og/groups.png
//
// Dynamic Open Graph card for the DRep group directory, rendered on demand and cached
// exactly like the help-guide cards. Static copy plus the groups-guide drawing, no
// database involved. Answers 404 where groups do not run, like every groups surface.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { loadCardImage } from '@/lib/og/assets.js';
import { GROUPS_CARD, GROUPS_CARD_ILLUSTRATION } from '@/lib/og/groupsCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { helpCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return new Response('not found', { status: 404 });
  const env = runtimeEnv(locals as App.Locals);
  const assets = env.ASSETS as unknown as Fetcher;
  return renderOgCard(assets, request.url, async () => {
    const illustrationDataUrl = await loadCardImage(assets, request.url, GROUPS_CARD_ILLUSTRATION);
    return helpCardHtml({ ...GROUPS_CARD, illustrationDataUrl });
  });
};
