// src/pages/cip100/topic/[topicId].json.ts
// GET /cip100/topic/<topicId>.json
// The thread manifest, keyed by the stable topic id rather than the slug: slugs
// can change, ids cannot. The human URL is inside as `discussion`.
import type { APIRoute } from 'astro';
import { runtimeEnv, currentNetwork } from '@/lib/api/response';
import { buildThreadManifest } from '@/lib/cip100/views';
import { originForNetwork } from '@/lib/cip100/origin';

export const prerender = false;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export const GET: APIRoute = async ({ params, locals }) => {
  const topicId = params.topicId ?? '';
  if (!UUID_RE.test(topicId)) return new Response('Not found', { status: 404 });

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503 });

  const network = currentNetwork().network === 'preprod' ? 'preprod' : 'mainnet';
  const res = await buildThreadManifest(db, topicId, originForNetwork(network), network);
  if (res.status === 404) return new Response('Not found', { status: 404 });
  if (res.status === 410) {
    return new Response('Gone', { status: 410, headers: { 'cache-control': 'public, max-age=3600' } });
  }

  return new Response(res.body as string, {
    status: 200,
    headers: {
      'content-type': 'application/ld+json; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
};
