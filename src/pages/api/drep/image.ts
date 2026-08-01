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
import { readBodyLimited } from '@/lib/http/bodyLimit';
import { handleDrepImageUpload } from '@/lib/governance/drepImageHandler';
import { MAX_DOWNLOAD_BYTES, imagesDownscaler } from '@/lib/dreps/avatarStore';

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

  // Cheap pre-check before reading any bytes; content-length can lie or be
  // absent (chunked), so the bounded reader below is the enforced ceiling.
  // Images over the store-as-is cap are downscaled by the handler, not
  // rejected; only the hard ceiling is enforced here.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_DOWNLOAD_BYTES) {
    return jsonResponse({ error: 'image too large (max 10 MB)' }, 413);
  }

  const read = await readBodyLimited(request.body, MAX_DOWNLOAD_BYTES);
  if (!read.ok) {
    return jsonResponse({ error: 'image too large (max 10 MB)' }, 413);
  }
  // The reader allocates an exact-size buffer, so .buffer carries no slack.
  const bytes = read.bytes.buffer as ArrayBuffer;
  const result = await handleDrepImageUpload({
    bytes,
    bucket,
    origin: new URL(request.url).origin,
    downscale: env.IMAGES ? imagesDownscaler(env.IMAGES) : undefined,
  });
  return jsonResponse(result.json, result.status);
};
