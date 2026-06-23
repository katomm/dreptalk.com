/// <reference types="@cloudflare/workers-types" />
// Avatar helper for the OG cards. satori embeds images as data URLs, so a stored
// DRep avatar is read from R2 and base64-encoded here. The generated identicon is
// already an SVG data URL from cardenticon, used as the fallback when a DRep has
// no uploaded image. (The brand mark is an inline SVG built in templates.ts.)

import { AVATAR_KEY_PREFIX } from '../dreps/avatarStore.js';
import { cardenticonDataURL } from '../../vendor/cardenticon/index.js';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Avatar data URL for a DRep or forum author: the self-hosted R2 image when one
 * is stored, otherwise the deterministic cardenticon identicon. Any R2 miss or
 * error falls through to the identicon so a card always renders.
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
        const ct = obj.httpMetadata?.contentType ?? 'image/webp';
        return `data:${ct};base64,${toBase64(await obj.arrayBuffer())}`;
      }
    } catch {
      // fall through to the identicon
    }
  }
  return cardenticonDataURL(seed, { size: 160 });
}
