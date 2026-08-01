/// <reference types="@cloudflare/workers-types" />
// Avatar helper for the OG cards. satori embeds images as data URLs, so a stored
// DRep avatar is read from R2 and base64-encoded here. The generated identicon is
// already an SVG data URL, used as the fallback when a DRep has no uploaded image.
// (The brand mark is an inline SVG built in templates.ts.)

import { AVATAR_KEY_PREFIX } from '../dreps/avatarStore.js';
import { identiconDataUri } from '../identity/identicon.js';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// resvg (the rasterizer workers-og uses) decodes only PNG and JPEG for embedded
// <img> data URLs. Handing it a webp/avif/gif makes the whole card render to an
// empty 0-byte PNG, so only these two are inlined; every other format falls back
// to the identicon SVG (which always renders). The avatar store downscales large
// images to webp (see avatarStore.ts), so this fallback is common by design.
const RESVG_SAFE_TYPES = new Set(['image/png', 'image/jpeg']);

/**
 * Avatar data URL for a DRep or forum author: the self-hosted R2 image when one
 * is stored in a rasterizer-safe format, otherwise the deterministic identicon.
 * Any R2 miss, error, or unsupported format falls through to the identicon so a
 * card always renders.
 */
export async function loadAvatar(
  avatars: R2Bucket | undefined,
  seed: string,
  imageContentHash: string | null | undefined,
): Promise<string> {
  if (avatars && imageContentHash) {
    try {
      // Content-addressed objects are stored under the avatars/ key prefix
      // (matches serveAvatar); the bare hash never resolves.
      const obj = await avatars.get(AVATAR_KEY_PREFIX + imageContentHash);
      if (obj) {
        const ct = (obj.httpMetadata?.contentType ?? '').split(';')[0].trim().toLowerCase();
        if (RESVG_SAFE_TYPES.has(ct)) {
          return `data:${ct};base64,${toBase64(await obj.arrayBuffer())}`;
        }
        // Unsupported by resvg (webp/avif/gif/unknown): fall through to the identicon.
      }
    } catch {
      // fall through to the identicon
    }
  }
  return identiconDataUri(seed, 160);
}
