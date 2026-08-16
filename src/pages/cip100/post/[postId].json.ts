// src/pages/cip100/post/[postId].json.ts
// GET /cip100/post/<postId>.json
// A post's version index: the mutable document that body.externalUpdates in
// every snapshot points at. Serves a tombstone once the post is deleted, since
// a consumer needs to learn that the deletion happened.
import type { APIRoute } from 'astro';
import { currentNetwork, runtimeEnv } from '@/lib/api/response';
import { buildVersionIndex } from '@/lib/cip100/views';
import { originForNetwork } from '@/lib/cip100/origin';
import { corsHeaders, corsPreflight } from '@/lib/cip100/cors';

export const prerender = false;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export const OPTIONS: APIRoute = () => corsPreflight();

export const GET: APIRoute = async ({ params, locals }) => {
  const postId = params.postId ?? '';
  if (!UUID_RE.test(postId)) return new Response('Not found', { status: 404, headers: corsHeaders() });

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503, headers: corsHeaders() });

  const network = currentNetwork().network === 'preprod' ? 'preprod' : 'mainnet';
  const res = await buildVersionIndex(db, postId, originForNetwork(network));
  if (res.status === 404 || !res.body) return new Response('Not found', { status: 404, headers: corsHeaders() });

  return new Response(res.body, {
    status: 200,
    headers: corsHeaders({
      'content-type': 'application/ld+json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    }),
  });
};
