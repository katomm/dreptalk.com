// POST /api/drep/metadata
//
// Hosts a DRep's CIP-119 metadata document and returns the stable URL +
// blake2b-256 hash the client embeds as the on-chain anchor. Writing requires
// proof of control of the DRep key (a CIP-8 signature over a fresh challenge):
// see handleDrepMetadata. The server never receives private keys.

import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { handleDrepMetadata } from '@/lib/governance/drepMetadataHandler';

export const prerender = false;

// Rate-limit config: 10 submissions per 60 s per client IP, checked before any
// parsing or crypto.
const RATE_MAX = 10;
const RATE_WINDOW_SEC = 60;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const db = env.DB as D1Database | undefined;
  const nonceKv = env.NONCES as KVNamespace | undefined;

  if (!db || !nonceKv) {
    return jsonResponse({ error: 'service unavailable' }, 503);
  }

  // Throttle per IP first (cheapest gate).
  const clientIp = clientIpFrom(request.headers);
  const allowed = await checkRate(nonceKv, `drep-meta:${clientIp}`, {
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
    now: Date.now(),
  });
  if (!allowed) {
    return jsonResponse({ error: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const result = await handleDrepMetadata({
    body,
    nonceKv,
    db,
    origin: new URL(request.url).origin,
    now: Date.now(),
  });
  return jsonResponse(result.json, result.status);
};
