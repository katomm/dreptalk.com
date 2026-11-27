// GET /og/cc/:coldKey.png
//
// Open Graph card for one Constitutional Committee member profile: name, the
// identicon of the cold key as on the page, and the member's record. Only the
// canonical lowercase key resolves, an unknown key answers 404.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { listCommitteeColdKeys } from '@/lib/db/committee.js';
import { loadCcMemberProfile } from '@/lib/governance/ccLoad.js';
import { resolveCcRouteParam } from '@/lib/governance/ccRoute.js';
import { loadAvatar } from '@/lib/og/assets.js';
import { ccMemberCardInput, ccMemberCardModel } from '@/lib/og/ccCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { drepCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const route = resolveCcRouteParam(params.coldKey ?? '');
  if (!db || route.kind !== 'canonical') return new Response('Not found', { status: 404 });
  // One light read decides the 404, the full record is read only on a cache miss.
  if (!(await listCommitteeColdKeys(db)).includes(route.hex)) return new Response('Not found', { status: 404 });

  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, async () => {
    const [data, avatarDataUrl] = await Promise.all([
      loadCcMemberProfile(db, route.hex, { openVotes: false }),
      loadAvatar(undefined, route.hex, null),
    ]);
    if (!data) throw new Error(`committee member ${route.hex} vanished between reads`);
    const model = ccMemberCardModel(ccMemberCardInput(data.profile, data.readable), { avatarDataUrl });
    return drepCardHtml(model, 'Committee member');
  });
};
