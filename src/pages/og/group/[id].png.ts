// GET /og/group/:id.png
//
// Dynamic Open Graph card for one DRep group, rendered on demand and cached like the DRep card.
// The image is the group's hosted image when DRepTalk stores it, else the identicon of the group
// id, as on the group page. Answers 404 where groups do not run and for an unknown group.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { getGroup } from '@/lib/db/drepGroups.js';
import type { ImagesLike } from '@/lib/dreps/avatarStore.js';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { hostedAvatarHash } from '@/lib/groups/view.js';
import { loadAvatar } from '@/lib/og/assets.js';
import { groupCardModel } from '@/lib/og/groupCard.js';
import { renderOgCard } from '@/lib/og/render.js';
import { drepCardHtml } from '@/lib/og/templates.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const id = params.id;
  if (!drepGroupsAvailable(currentNetwork().network) || !db || !id) return new Response('Not found', { status: 404 });
  const group = await getGroup(db, id);
  if (!group) return new Response('Not found', { status: 404 });
  const profile = group.profile?.status === 'ok' ? group.profile : null;
  const imageHash = hostedAvatarHash(profile?.image);

  return renderOgCard(env.ASSETS as unknown as Fetcher, request.url, async () => {
    const avatarDataUrl = await loadAvatar(env.AVATARS as R2Bucket | undefined, group.groupId, imageHash, env.IMAGES as ImagesLike | undefined);
    const model = groupCardModel(
      {
        groupId: group.groupId,
        name: profile?.name ?? null,
        description: profile?.description ?? null,
        mode: group.mode,
        status: group.status,
        members: group.members,
        memberPower: group.memberPower,
        closing: group.closing,
        imageHash,
      },
      { avatarDataUrl },
    );
    return drepCardHtml(model, 'DRep group');
  });
};
