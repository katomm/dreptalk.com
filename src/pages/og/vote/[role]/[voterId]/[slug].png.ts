// GET /og/vote/:role/:voterId/:slug.png
//
// Dynamic Open Graph card for a single voter's vote and rationale on a
// governance action, rendered on demand and cached. `role` is drep or spo
// (no heuristic), `voterId` is the DRep/pool slug or raw id, `slug` is the
// topic slug for the governance action. Avatar is the stored R2 image when
// present, else the identicon.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDrepByIdOrSlug } from '@/lib/db/dreps.js';
import { getGovernanceActionByTopicId } from '@/lib/db/governance.js';
import { getTopicBySlug } from '@/lib/db/forum.js';
import { getPoolByIdOrSlug } from '@/lib/db/pools.js';
import { getVoteStatement } from '@/lib/db/voteRationale.js';
import { loadAvatar } from '@/lib/og/assets.js';
import type { ImagesLike } from '@/lib/dreps/avatarStore.js';
import { voteCardModel } from '@/lib/og/model.js';
import { renderOgCard } from '@/lib/og/render.js';
import { voteCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const { role, voterId, slug } = params;
  if (!db || !voterId || !slug || (role !== 'drep' && role !== 'spo')) return new Response('Not found', { status: 404 });

  const topic = await getTopicBySlug(db, slug);
  const action = topic ? await getGovernanceActionByTopicId(db, topic.id) : null;
  if (!action) return new Response('Not found', { status: 404 });

  const isDrep = role === 'drep';
  const drep = isDrep ? await getDrepByIdOrSlug(db, voterId) : null;
  const pool = isDrep ? null : await getPoolByIdOrSlug(db, voterId);
  const voterKey = drep?.drepId ?? pool?.poolId;
  if (!voterKey) return new Response('Not found', { status: 404 });

  const vote = await getVoteStatement(db, { gaId: action.id, voterId: voterKey, role: isDrep ? 'DRep' : 'SPO' });
  if (!vote) return new Response('Not found', { status: 404 });

  const name = drep?.name ?? pool?.name ?? null;
  const seed = isDrep ? (drep!.hex ?? drep!.drepId) : (pool!.poolHash ?? pool!.poolId);
  const imageHash = drep?.imageContentHash ?? pool?.imageContentHash ?? null;
  const avatarDataUrl = await loadAvatar(
    env.AVATARS as R2Bucket | undefined,
    seed,
    imageHash,
    env.IMAGES as ImagesLike | undefined,
  );

  const model = voteCardModel(
    { name, voterId: voterKey, vote: vote.vote, rationaleText: vote.bodyText, actionTitle: action.title ?? topic!.title, role: isDrep ? 'DRep' : 'SPO' },
    { avatarDataUrl },
  );
  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, () => voteCardHtml(model));
};
