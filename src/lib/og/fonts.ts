/// <reference types="@cloudflare/workers-types" />
// Loads the fonts satori needs (it cannot read the app's variable woff2). The
// static Plus Jakarta Sans weights plus a 1.5KB single-glyph fallback that
// carries the ada sign (U+20B3), which is absent from the latin subset. All live
// in public/fonts, are read through the ASSETS binding, and are cached per
// isolate so each file is fetched at most once.

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500 | 600 | 700 | 800;
  style: 'normal';
}

const PJS_WEIGHTS = [500, 600, 700, 800] as const;
const cache = new Map<string, ArrayBuffer>();

async function load(assets: Fetcher, origin: string, file: string): Promise<ArrayBuffer> {
  let data = cache.get(file);
  if (!data) {
    const res = await assets.fetch(new URL(`/fonts/${file}`, origin));
    if (!res.ok) throw new Error(`OG font ${file} not found (${res.status})`);
    data = await res.arrayBuffer();
    cache.set(file, data);
  }
  return data;
}

export async function loadOgFonts(assets: Fetcher, origin: string): Promise<OgFont[]> {
  const fonts: OgFont[] = [];
  for (const weight of PJS_WEIGHTS) {
    fonts.push({
      name: 'Plus Jakarta Sans',
      data: await load(assets, origin, `plus-jakarta-sans-${weight}.ttf`),
      weight,
      style: 'normal',
    });
  }
  // Fallback family listed after Plus Jakarta Sans in the templates' font-family,
  // so satori uses it only for the ada glyph the primary subset lacks.
  fonts.push({ name: 'Ada', data: await load(assets, origin, 'ada-symbol.ttf'), weight: 700, style: 'normal' });
  return fonts;
}
