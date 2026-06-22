/// <reference types="@cloudflare/workers-types" />
// Loads the static Plus Jakarta Sans weights satori needs (it cannot read the
// app's variable woff2). The TTFs live in public/fonts and are read through the
// ASSETS binding, then cached in the isolate so each weight is fetched at most
// once per worker instance.

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600 | 700 | 800;
  style: 'normal';
}

const WEIGHTS = [500, 600, 700, 800] as const;
const cache = new Map<number, ArrayBuffer>();

export async function loadOgFonts(assets: Fetcher, origin: string): Promise<OgFont[]> {
  const fonts: OgFont[] = [];
  for (const weight of WEIGHTS) {
    let data = cache.get(weight);
    if (!data) {
      const res = await assets.fetch(new URL(`/fonts/plus-jakarta-sans-${weight}.ttf`, origin));
      if (!res.ok) throw new Error(`OG font ${weight} not found (${res.status})`);
      data = await res.arrayBuffer();
      cache.set(weight, data);
    }
    fonts.push({ name: 'Plus Jakarta Sans', data, weight, style: 'normal' });
  }
  return fonts;
}
