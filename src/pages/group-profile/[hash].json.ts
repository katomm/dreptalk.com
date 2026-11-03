// GET /group-profile/<hash>.json
// Serves the immutable CIP-100 group profile bytes for a content hash, long-cached.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { drepGroupsAvailable } from '@/lib/groups/gate';
import { getProfileDocBody } from '@/lib/groups/profileDocs';

export const prerender = false;
const HASH_RE = /^[0-9a-f]{64}$/;

export const GET: APIRoute = async ({ params, locals }) => {
  if (!drepGroupsAvailable(currentNetwork().network)) return new Response('Not found', { status: 404 });
  const hash = params.hash ?? '';
  if (!HASH_RE.test(hash)) return new Response('Not found', { status: 404 });
  const db = runtimeEnv(locals as App.Locals).DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503 });
  const body = await getProfileDocBody(db, hash);
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Immutable: the hash is in the path, so the bytes never change.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
