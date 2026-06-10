// GET /api/avatar/:hash
//
// Serves a self-hosted DRep avatar from R2, content addressed by the sha256 of
// its bytes (written by the gov-sync avatar store pass). No upstream fetch
// happens at request time: visitors never touch the third-party image host.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { serveAvatar } from '@/lib/dreps/avatarServe';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  return serveAvatar(env.AVATARS as R2Bucket | undefined, params.hash);
};
