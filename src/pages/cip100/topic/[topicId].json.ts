// src/pages/cip100/topic/[topicId].json.ts
// GET /cip100/topic/<topicId>.json
// The thread manifest, keyed by the stable topic id rather than the slug: slugs
// can change, ids cannot. The human URL is inside as `discussion`.
import type { APIRoute } from 'astro';
import { runtimeEnv, currentNetwork } from '@/lib/api/response';
import { buildThreadManifest } from '@/lib/cip100/views';
import { originForNetwork } from '@/lib/cip100/origin';
import { corsHeaders, corsPreflight } from '@/lib/cip100/cors';
import { isForumId } from '@/lib/validation/input';

export const prerender = false;

export const OPTIONS: APIRoute = () => corsPreflight();

export const GET: APIRoute = async ({ params, locals }) => {
  const topicId = params.topicId ?? '';
  if (!isForumId(topicId)) return new Response('Not found', { status: 404, headers: corsHeaders() });

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503, headers: corsHeaders() });

  const network = currentNetwork().network === 'preprod' ? 'preprod' : 'mainnet';
  const res = await buildThreadManifest(db, topicId, originForNetwork(network), network);
  if (res.status === 404) return new Response('Not found', { status: 404, headers: corsHeaders() });
  if (res.status === 410) {
    return new Response('Gone', { status: 410, headers: corsHeaders({ 'cache-control': 'public, max-age=3600' }) });
  }

  return new Response(res.body as string, {
    status: 200,
    headers: corsHeaders({
      'content-type': 'application/ld+json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    }),
  });
};
