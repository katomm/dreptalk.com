// GET /drep/[hash].json
//
// Serves the hosted CIP-119 DRep metadata document at the content-addressed URL
// the on-chain anchor points to. The drep id is not in the path: the on-chain
// anchor url field is capped at 128 chars (CIP-100), so only the hash is used.
// The stored body is returned verbatim (no parse/re-stringify) so the served
// bytes match the anchor hash exactly; the URL embeds the hash, so the bytes are
// immutable for a given URL.

import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDrepMetadataByHash } from '@/lib/db/drepMetadata';

export const prerender = false;

// blake2b-256 hex: exactly 64 lowercase hex chars.
const HASH_RE = /^[0-9a-f]{64}$/;

export const GET: APIRoute = async ({ params, locals }) => {
  const { hash } = params;

  if (!hash || !HASH_RE.test(hash)) {
    return new Response('not found', { status: 404 });
  }

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;

  if (!db) {
    return new Response('service unavailable', { status: 503 });
  }

  const row = await getDrepMetadataByHash(db, hash);

  if (!row) {
    return new Response('not found', { status: 404 });
  }

  // Return the stored body string verbatim: do not JSON.parse or re-stringify.
  // The bytes must match the blake2b-256 hash in the on-chain anchor.
  return new Response(row.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
