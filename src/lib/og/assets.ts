/// <reference types="@cloudflare/workers-types" />
// Image helpers for the OG cards. satori embeds images as data URLs, so the logo
// (a raster PNG, safe in satori) and any stored DRep avatar are read as bytes and
// base64-encoded here. The generated identicon is already an SVG data URL from
// cardenticon, used as the fallback when a DRep has no uploaded image.

import { cardenticonDataURL } from '../../vendor/cardenticon/index.js';

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

let logoCache: string | null = null;

/** The brand mark as a PNG data URL, cached per isolate. */
export async function loadLogo(assets: Fetcher, origin: string): Promise<string> {
  if (logoCache) return logoCache;
  const res = await assets.fetch(new URL('/logo.png', origin));
  if (!res.ok) throw new Error(`OG logo not found (${res.status})`);
  logoCache = `data:image/png;base64,${toBase64(await res.arrayBuffer())}`;
  return logoCache;
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
      const obj = await avatars.get(imageContentHash);
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
