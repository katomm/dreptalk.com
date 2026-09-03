/// <reference types="@cloudflare/workers-types" />
// Avatar helper for the OG cards. satori embeds images as data URLs, so a stored
// DRep avatar is read from R2 and base64-encoded here. The generated identicon is
// already an SVG data URL, used as the fallback when a DRep has no uploaded image.
// (The brand mark is an inline SVG built in templates.ts.)

import {
  AVATAR_KEY_PREFIX,
  type ImagesLike,
  ogAvatarKey,
  pngRenditionEncoder,
} from '../dreps/avatarStore.js';
import { identiconDataUri } from '../identity/identicon.js';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// resvg (the rasterizer workers-og uses) decodes only PNG and JPEG for embedded
// <img> data URLs. Handing it a webp/avif/gif makes the whole card render to an
// empty 0-byte PNG, so only these two are inlined directly. Any other format is
// re-encoded to a PNG rendition once and read from R2 afterwards; only when that
// is unavailable does the card fall back to the identicon. The avatar store
// downscales large images to webp (see avatarStore.ts), so the rendition path is
// what keeps those DReps' own picture on their card.
const RESVG_SAFE_TYPES = new Set(['image/png', 'image/jpeg']);

/** Content type of an R2 object, lowercased and without any charset suffix. */
function contentType(obj: R2ObjectBody): string {
  return (obj.httpMetadata?.contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * PNG rendition of an avatar the rasterizer cannot decode: the cached object
 * when one exists, otherwise re-encoded from the stored bytes and written back
 * under the og-avatars/ prefix so each avatar is converted only once. Returns
 * null when no Images binding is available or the re-encode fails.
 */
async function pngRendition(
  avatars: R2Bucket,
  images: ImagesLike | undefined,
  hash: string,
  source: R2ObjectBody,
): Promise<string | null> {
  const key = ogAvatarKey(hash);
  const cached = await avatars.get(key);
  if (cached) return `data:image/png;base64,${toBase64(await cached.arrayBuffer())}`;
  if (!images) return null;

  const png = await pngRenditionEncoder(images)(await source.arrayBuffer());
  if (!png) return null;
  await avatars.put(key, png.bytes, { httpMetadata: { contentType: png.contentType } });
  return `data:image/png;base64,${toBase64(png.bytes)}`;
}

/**
 * Avatar data URL for a DRep or forum author: the self-hosted R2 image when it is
 * stored in a rasterizer-safe format, a PNG rendition of it when it is not, and
 * the deterministic identicon otherwise. Any R2 miss, error, or failed re-encode
 * falls through to the identicon so a card always renders.
 */
export async function loadAvatar(
  avatars: R2Bucket | undefined,
  seed: string,
  imageContentHash: string | null | undefined,
  images?: ImagesLike,
): Promise<string> {
  if (avatars && imageContentHash) {
    try {
      // Content-addressed objects are stored under the avatars/ key prefix
      // (matches serveAvatar); the bare hash never resolves.
      const obj = await avatars.get(AVATAR_KEY_PREFIX + imageContentHash);
      if (obj) {
        const ct = contentType(obj);
        if (RESVG_SAFE_TYPES.has(ct)) {
          return `data:${ct};base64,${toBase64(await obj.arrayBuffer())}`;
        }
        const png = await pngRendition(avatars, images, imageContentHash, obj);
        if (png) return png;
      }
    } catch {
      // fall through to the identicon
    }
  }
  return identiconDataUri(seed, 160);
}

/**
 * Load a bundled raster asset (a help-guide illustration) from the ASSETS binding
 * as a data URL for embedding in a card. resvg decodes only PNG and JPEG, so a
 * miss, an error, or any other content type returns null and the card renders
 * without the illustration (its prior text-only look), never a broken 0-byte PNG.
 */
export async function loadCardImage(
  assets: Fetcher | undefined,
  origin: string,
  path: string,
): Promise<string | null> {
  if (!assets) return null;
  try {
    const res = await assets.fetch(new URL(path, origin));
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!RESVG_SAFE_TYPES.has(ct)) return null;
    return `data:${ct};base64,${toBase64(await res.arrayBuffer())}`;
  } catch {
    return null;
  }
}
