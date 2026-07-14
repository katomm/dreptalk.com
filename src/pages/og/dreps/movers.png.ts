// GET /og/dreps/movers.png
//
// Dynamic Open Graph card for the "Movers of the epoch" page: the top gainers and
// losers by per-epoch voting-power delta, rendered on demand and cached. Reuses
// the same movers query and trend helpers as the page, so the card and the page
// never disagree. Avatars are the stored R2 image when present, else the identicon.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { listVotingPowerMovers, type Drep } from '@/lib/db/dreps.js';
import { drepDescriptor } from '@/lib/forum/author.js';
import { loadAvatar } from '@/lib/og/assets.js';
import { moversCardModel, type MoverInput } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { moversCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

// Three per side keeps every name and figure legible at thumbnail size.
const PER_SIDE = 3;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('Not found', { status: 404 });

  const { gainers, losers, epoch } = await listVotingPowerMovers(db, { limit: PER_SIDE });
  if (gainers.length === 0 && losers.length === 0) return new Response('Not found', { status: 404 });

  const avatars = env.AVATARS as R2Bucket | undefined;
  const toInputs = (list: Drep[]): Promise<MoverInput[]> =>
    Promise.all(
      list.map(async (d): Promise<MoverInput> => ({
        name: drepDescriptor(d).displayName,
        avatarDataUrl: await loadAvatar(avatars, d.hex ?? d.drepId, d.imageContentHash),
        snapshot: d.votingPowerSnapshot,
        prev: d.votingPowerPrev,
      })),
    );

  const [gainerInputs, loserInputs] = await Promise.all([toInputs(gainers), toInputs(losers)]);
  const model = moversCardModel({ epoch, gainers: gainerInputs, losers: loserInputs });

  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => moversCardHtml(model));
};
