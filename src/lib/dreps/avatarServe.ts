/// <reference types="@cloudflare/workers-types" />
// Serve core for /api/avatar/<hash>: a plain R2 read. The URL is content
// addressed (sha256 of the bytes), so the response is immutable-cacheable and
// no validation beyond the hash shape is needed at request time. All download
// hardening runs at store time (see avatarStore.ts).
import {
  AVATAR_KEY_PREFIX,
  refitDropsAnimation,
  thumbAvatarKey,
  thumbRenditionEncoder,
  type ImagesLike,
} from './avatarStore.js';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HASH_RE = /^[0-9a-f]{64}$/;
// A source this small already costs about what a thumb would, so it is served
// as the thumb without a transform.
const THUMB_WORTH_BYTES = 6 * 1024;

const notFound = () => new Response('not found', { status: 404 });

function imageResponse(body: ReadableStream | ArrayBuffer, meta: { contentType: string; size: number; etag?: string }): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': meta.contentType,
      // size/etag enable exact content-length and If-None-Match revalidation.
      'content-length': String(meta.size),
      ...(meta.etag ? { etag: meta.etag } : {}),
      'cache-control': CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
}

const contentTypeOf = (obj: R2Object) => obj.httpMetadata?.contentType ?? 'application/octet-stream';

function objectResponse(obj: R2ObjectBody): Response {
  return imageResponse(obj.body, { contentType: contentTypeOf(obj), size: obj.size, etag: obj.httpEtag });
}

/** Serves one stored avatar; any invalid input or miss is a 404, never a 500. */
export async function serveAvatar(bucket: R2Bucket | undefined, hash: string | undefined): Promise<Response> {
  if (!bucket || !hash || !HASH_RE.test(hash)) return notFound();

  const obj = await bucket.get(AVATAR_KEY_PREFIX + hash);
  if (!obj) return notFound();
  return objectResponse(obj);
}

/**
 * Serves the small list rendition of a stored avatar. The first request derives
 * it from the stored bytes and writes it back under avatar-thumbs/, later ones
 * read it directly. Small sources and animated GIFs are streamed as they are, a
 * source the transform cannot beat is stored as its own thumb. Without the
 * Images binding, or when a transform fails, it redirects to the full avatar
 * and writes nothing, so a passing outage never pins the large bytes under the
 * thumb URL (the redirect is not edge-cached, the full URL is).
 */
export async function serveAvatarThumb(
  bucket: R2Bucket | undefined,
  images: ImagesLike | undefined,
  hash: string | undefined,
  defer: (work: Promise<unknown>) => void,
): Promise<Response> {
  if (!bucket || !hash || !HASH_RE.test(hash)) return notFound();

  const thumb = await bucket.get(thumbAvatarKey(hash));
  if (thumb) return objectResponse(thumb);

  const source = await bucket.get(AVATAR_KEY_PREFIX + hash);
  if (!source) return notFound();
  if (source.size <= THUMB_WORTH_BYTES || refitDropsAnimation(contentTypeOf(source))) return objectResponse(source);

  const fullAvatar = () =>
    new Response(null, { status: 307, headers: { location: `/api/avatar/${hash}`, 'cache-control': 'no-store' } });
  if (!images) return fullAvatar();

  const sourceBytes = await source.arrayBuffer();
  const encoded = await thumbRenditionEncoder(images)(sourceBytes);
  if (!encoded) return fullAvatar();
  const out = encoded.bytes.byteLength < sourceBytes.byteLength ? encoded : { bytes: sourceBytes, contentType: contentTypeOf(source) };

  defer(bucket.put(thumbAvatarKey(hash), out.bytes, { httpMetadata: { contentType: out.contentType } }));
  return imageResponse(out.bytes, { contentType: out.contentType, size: out.bytes.byteLength });
}
