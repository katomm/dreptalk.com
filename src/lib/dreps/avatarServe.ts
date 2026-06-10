/// <reference types="@cloudflare/workers-types" />
// Serve core for /api/avatar/<hash>: a plain R2 read. The URL is content
// addressed (sha256 of the bytes), so the response is immutable-cacheable and
// no validation beyond the hash shape is needed at request time. All download
// hardening runs at store time (see avatarStore.ts).
import { AVATAR_KEY_PREFIX } from './avatarStore.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HASH_RE = /^[0-9a-f]{64}$/;

/** Serves one stored avatar; any invalid input or miss is a 404, never a 500. */
export async function serveAvatar(bucket: R2Bucket | undefined, hash: string | undefined): Promise<Response> {
  if (!bucket || !hash || !HASH_RE.test(hash)) return new Response('not found', { status: 404 });

  const obj = await bucket.get(AVATAR_KEY_PREFIX + hash);
  if (!obj) return new Response('not found', { status: 404 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      // size/etag enable exact content-length and If-None-Match revalidation.
      'content-length': String(obj.size),
      etag: obj.httpEtag,
      'cache-control': CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}
