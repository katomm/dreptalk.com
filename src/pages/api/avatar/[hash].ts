// GET /api/avatar/:hash
//
// Serves a self-hosted DRep avatar from R2, content addressed by the sha256 of
// its bytes (written by the gov-sync avatar store pass). No upstream fetch
// happens at request time: visitors never touch the third-party image host.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { serveAvatar } from '@/lib/dreps/avatarServe';
import { withEdgeCache } from '@/lib/http/edgeCache';

export const prerender = false;

// The URL is content addressed (immutable bytes per hash), so it is a perfect
// edge-cache key. Without the edge cache every uncached visitor pays the R2
// round-trip, which shows up in the avatar's LCP tail on profile pages.
export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = runtimeEnv(locals as App.Locals);
  return withEdgeCache(request, () => serveAvatar(env.AVATARS as R2Bucket | undefined, params.hash));
};
