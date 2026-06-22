// GET /og/drep/:id.png
//
// Dynamic Open Graph card for a DRep profile, rendered on demand and cached.
// `id` is the DRep slug or raw drep id (both URL-safe). Avatar is the stored R2
// image when present, else the cardenticon identicon.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDrepByIdOrSlug } from '@/lib/db/dreps.js';
import { countDrepVotes, getDrepParticipation } from '@/lib/db/drepVotes.js';
import { getActiveDrepStake } from '@/lib/db/stakeParticipation.js';
import { influencePct } from '@/lib/drep/profile.js';
import { loadAvatar, loadLogo } from '@/lib/og/assets.js';
import { loadOgFonts } from '@/lib/og/fonts.js';
import { drepCardModel } from '@/lib/og/model.js';
import { ogPng } from '@/lib/og/render.js';
import { drepCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const id = params.id;
  if (!db || !id) return new Response('Not found', { status: 404 });

  const drep = await getDrepByIdOrSlug(db, id);
  if (!drep) return new Response('Not found', { status: 404 });

  const [votesCast, participation, activeStake, avatarDataUrl] = await Promise.all([
    countDrepVotes(db, drep.drepId),
    getDrepParticipation(db, drep.drepId, drep.registeredEpoch),
    getActiveDrepStake(db),
    loadAvatar(env.AVATARS as R2Bucket | undefined, drep.hex ?? drep.drepId, drep.imageContentHash),
  ]);

  const model = drepCardModel(drep, {
    avatarDataUrl,
    influencePct: influencePct(drep.votingPower, activeStake.total),
    votesCast,
    participation,
  });

  const [fonts, logo] = await Promise.all([
    loadOgFonts(env.ASSETS as unknown as Fetcher, request.url),
    loadLogo(env.ASSETS as unknown as Fetcher, request.url),
  ]);
  return ogPng(drepCardHtml(model, logo), fonts);
};
