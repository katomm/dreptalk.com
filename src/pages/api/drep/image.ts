// POST /api/drep/image
//
// Hosts a DRep profile image (JPG/PNG, max 256 KB) in R2, content-addressed by
// sha256, and returns the URL + hash the client embeds in its CIP-119 document.
// Unauthenticated like /api/drep/metadata (registration has no session yet);
// see drepImageHandler.ts for the trust model.

import type { APIRoute } from 'astro';
import { jsonResponse, runtimeEnv } from '@/lib/api/response';
import { checkRate } from '@/lib/rate';
import { clientIpFrom } from '@/lib/http/clientIp';
import { handleDrepImageUpload } from '@/lib/governance/drepImageHandler';
import { MAX_IMAGE_BYTES } from '@/lib/dreps/avatarStore';

export const prerender = false;

// Tighter than metadata hosting: image bytes are 100x larger than a JSON doc.
const RATE_MAX = 5;
const RATE_WINDOW_SEC = 300;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv(locals as App.Locals);
  const bucket = env.AVATARS as R2Bucket | undefined;
  const rateLimiter = env.RATE_LIMITER;

  if (!bucket || !rateLimiter) {
    return jsonResponse({ error: 'service unavailable' }, 503);
  }

  const clientIp = clientIpFrom(request.headers);
  const allowed = await checkRate(rateLimiter, `drep-img:${clientIp}`, {
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
    now: Date.now(),
  });
  if (!allowed) {
    return jsonResponse({ error: 'rate_limited' }, 429);
  }

  // Cheap pre-check before buffering the body; the handler re-checks the
  // actual byte length (content-length can lie or be absent).
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_IMAGE_BYTES) {
    return jsonResponse({ error: 'image too large (max 256 KB)' }, 413);
  }

  const bytes = await request.arrayBuffer();
  const result = await handleDrepImageUpload({
    bytes,
    bucket,
    origin: new URL(request.url).origin,
  });
  return jsonResponse(result.json, result.status);
};
