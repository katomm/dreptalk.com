// GET /api/avatar/:hash/thumb
//
// Small rendition of a self-hosted avatar for list-size placements (see
// avatarUrl). Same content addressing and edge caching as /api/avatar/:hash.
import { waitUntil } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { serveAvatarThumb } from '@/lib/dreps/avatarServe';
import { withEdgeCache } from '@/lib/http/edgeCache';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  return withEdgeCache(request, () => serveAvatarThumb(env.AVATARS as R2Bucket | undefined, env.IMAGES, params.hash, waitUntil));
};
