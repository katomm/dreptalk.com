// GET /vote-rationale/<hash>.json
// Serves the immutable CIP-100 rationale bytes for a content hash, long-cached.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getVoteRationaleBody } from '@/lib/db/voteRationale';

export const prerender = false;
const HASH_RE = /^[0-9a-f]{64}$/;

export const GET: APIRoute = async ({ params, locals }) => {
  const hash = (params.hash ?? '').toLowerCase();
  if (!HASH_RE.test(hash)) return new Response('Not found', { status: 404 });
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503 });
  const body = await getVoteRationaleBody(db, hash);
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
