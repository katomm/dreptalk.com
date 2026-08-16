// src/pages/cip100/[hash].json.ts
// GET /cip100/<hash>.json
// Serves one immutable CIP-100 discussion document. The bytes are stored, never
// rebuilt: a builder change must never alter the hash of a document that has
// already been cited.
import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDocForServe } from '@/lib/db/cip100';
import { corsHeaders, corsPreflight } from '@/lib/cip100/cors';

export const prerender = false;
const HASH_RE = /^[0-9a-f]{64}$/;

// Deliberately NOT `immutable`. The content behind a hash never changes, but a
// deleted document has to be able to become a 410 for clients that already hold
// it, and `immutable` licenses a client to skip revalidation for the whole
// max-age. Revalidation is nearly free here because the ETag is the hash.
const CACHE = 'public, max-age=300, must-revalidate';
const GONE_CACHE = 'public, max-age=3600';

/** RFC 9110 If-None-Match: a comma separated list, entries optionally marked
 *  weak with a W/ prefix, and `*` matching anything that exists. Caches and
 *  proxies do send all three forms, and comparing the raw header against one
 *  quoted tag turns a cheap 304 into a full re-download. */
function etagMatches(header: string | null, hash: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === '*') return true;
  return value
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, ''))
    .includes(hash);
}

export const OPTIONS: APIRoute = () => corsPreflight();

export const GET: APIRoute = async ({ params, locals, request }) => {
  const hash = (params.hash ?? '').toLowerCase();
  if (!HASH_RE.test(hash)) return new Response('Not found', { status: 404, headers: corsHeaders() });

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  if (!db) return new Response('service unavailable', { status: 503, headers: corsHeaders() });

  const doc = await getDocForServe(db, hash);
  if (!doc) return new Response('Not found', { status: 404, headers: corsHeaders() });

  // Both availability checks run BEFORE the ETag comparison. An unavailable
  // document's ETag always matches (a hash never changes), so comparing first
  // would serve "nothing changed" forever instead of the tombstone.
  if (doc.state === 'gone' || doc.body === null) {
    return new Response('Gone', { status: 410, headers: corsHeaders({ 'cache-control': GONE_CACHE }) });
  }
  // A post hidden by community flags answers 404, not 410: 410 is terminal and
  // is the erasure path for deletions, which are permanent, while a flag can be
  // withdrawn and the document served again. Not cached either, for the same
  // reason.
  if (doc.state === 'hidden') return new Response('Not found', { status: 404, headers: corsHeaders() });

  const etag = `"${hash}"`;
  if (etagMatches(request.headers.get('if-none-match'), hash)) {
    return new Response(null, { status: 304, headers: corsHeaders({ etag, 'cache-control': CACHE }) });
  }

  return new Response(doc.body, {
    status: 200,
    headers: corsHeaders({
      'content-type': 'application/ld+json; charset=utf-8',
      'cache-control': CACHE,
      etag,
    }),
  });
};
