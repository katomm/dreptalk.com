// GET /drep/[drepId]/metadata.json
//
// Serves the hosted CIP-119 DRep metadata document at the stable URL that the
// on-chain anchor points to. The stored body is returned verbatim (no
// parse/re-stringify) so the served bytes match the anchor hash exactly.
//
// Cache: immutable with a 1-year max-age. The drepId is content-addressed via
// the on-chain anchor hash, so the stored bytes never change for a given id.

import type { APIRoute } from 'astro';
import { runtimeEnv } from '@/lib/api/response';
import { getDrepMetadata } from '@/lib/db/drepMetadata';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const { drepId } = params;

  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;

  if (!db) {
    return new Response('service unavailable', { status: 503 });
  }

  const row = await getDrepMetadata(db, drepId as string);

  if (!row) {
    return new Response('not found', { status: 404 });
  }

  // Return the stored body string verbatim: do not JSON.parse or re-stringify.
  // The bytes must match the blake2b-256 hash stored in the on-chain anchor.
  return new Response(row.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
