// src/pages/cip100/[hash].json.ts
// GET /cip100/<hash>.json
// Serves one immutable CIP-100 discussion document. The bytes are stored, never
// rebuilt: a builder change must never alter the hash of a document that has
// already been cited.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDocForServe } from '@/lib/db/cip100';

export const prerender = false;
const HASH_RE = /^[0-9a-f]{64}$/;

// Deliberately NOT `immutable`. The content behind a hash never changes, but a
// deleted document has to be able to become a 410 for clients that already hold
// it, and `immutable` licenses a client to skip revalidation for the whole
// max-age. Revalidation is nearly free here because the ETag is the hash.
const CACHE = 'public, max-age=300, must-revalidate';
const GONE_CACHE = 'public, max-age=3600';

export const GET: APIRoute = async ({ params, locals, request }) => {
  const hash = (params.hash ?? '').toLowerCase();
  if (!HASH_RE.test(hash)) return new Response('Not found', { status: 404 });

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503 });

  const doc = await getDocForServe(db, hash);
  if (!doc) return new Response('Not found', { status: 404 });

  // The deletion check runs BEFORE the ETag comparison. A deleted document's
  // ETag always matches (a hash never changes), so comparing first would serve
  // "nothing changed" forever instead of the tombstone.
  if (doc.gone || doc.body === null) {
    return new Response('Gone', { status: 410, headers: { 'cache-control': GONE_CACHE } });
  }

  const etag = `"${hash}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': CACHE } });
  }

  return new Response(doc.body, {
    status: 200,
    headers: {
      'content-type': 'application/ld+json; charset=utf-8',
      'cache-control': CACHE,
      etag,
    },
  });
};
