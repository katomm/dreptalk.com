// Pure resolvers for the CIP-6 pool logo chain. The base off-chain metadata only
// points to a separate `extended` document; the logo lives there under one of two
// de-facto field paths (current `info.*`, legacy `adapools.*`), icon preferred over
// the larger logo. Everything here is https-only and does no I/O.

function httpsOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

export function extractExtendedUrl(baseMetaText: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(baseMetaText);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  return httpsOrNull((doc as Record<string, unknown>).extended);
}

export function extractLogoUrl(extendedJson: unknown): string | null {
  if (typeof extendedJson !== 'object' || extendedJson === null) return null;
  const root = extendedJson as Record<string, unknown>;
  const containers = [root.info, root.adapools].filter(
    (c): c is Record<string, unknown> => typeof c === 'object' && c !== null,
  );
  // Icon (small square) preferred over the larger logo, across both schemas.
  for (const key of ['url_png_icon_64x64', 'url_png_logo']) {
    for (const c of containers) {
      const hit = httpsOrNull(c[key]);
      if (hit) return hit;
    }
  }
  return null;
}
