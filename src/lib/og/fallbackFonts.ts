// Fallback fonts for names the bundled Latin subset cannot draw.
//
// The cards ship a small Plus Jakarta Sans subset, so a DRep called 忠実 (or
// Дмитрий, or Łukasz) used to render as an empty gap: satori draws nothing for a
// codepoint no loaded font covers. A full CJK face is megabytes and is exactly
// the kind of weight that already broke this render once (see movers.png.ts), so
// nothing extra is loaded up front. Instead the built card HTML is scanned, and
// only when it carries a codepoint outside the loaded fonts' coverage is a Noto
// face for that script fetched from Google Fonts.
//
// Cost of the common case: one Set lookup per character, no subrequest at all.
// Cost of a card with a non-Latin name: one CSS lookup plus one font download,
// on a cache miss only (the rendered PNG itself is edge-cached), memoised per
// isolate afterwards.

import { cachedCoveredCodepoints } from './fontCoverage.js';
import type { OgFont } from './fonts.js';

// Google serves a woff2 for modern browsers and satori cannot read woff2 (it has
// no brotli decoder), so the CSS is requested with a user agent from before
// woff2 support. That is the documented way to get a woff/ttf out of the API.
const LEGACY_UA = 'Mozilla/5.0 (Windows NT 6.1; rv:27.0) Gecko/20100101 Firefox/27.0';
const CSS_ENDPOINT = 'https://fonts.googleapis.com/css';
// A slow font service must not hold up a card render: on a timeout the card
// renders exactly as it does today, with the unsupported glyphs left blank. The
// download gets the longer budget because a CJK face is several megabytes (the
// alphabetic scripts come back subset to a couple of KB).
const CSS_TIMEOUT_MS = 3000;
const FONT_TIMEOUT_MS = 10000;
// A name mixing three scripts is not worth three multi-megabyte downloads. Two
// covers every realistic case (a script plus Latin punctuation is one family).
const MAX_FAMILIES = 2;
// CJK faces are megabytes each, so the per-isolate memo is deliberately small.
const MAX_CACHED_FONTS = 3;
// Google subsets a response to the requested characters for alphabetic scripts
// only; a CJK family always comes back whole. The request still has to name the
// characters (dropping them yields a Latin-only slice of the face, no ideographs
// at all), but the answer is the same megabytes every time, so these are memoised
// per family and the next CJK name is served from the copy already in the isolate.
const WHOLE_FACE_FAMILIES = new Set(['Noto Sans JP', 'Noto Sans KR', 'Noto Sans SC']);

/** Unicode block starts mapped to the Noto family that covers them. Ordered by
    block start; a codepoint takes the family of the last start below it. Blocks
    that no Noto family here covers map to null and are given up on. */
const BLOCKS: Array<[start: number, family: string | null]> = [
  [0x0000, 'Noto Sans'], // Latin, Latin Extended, IPA, Greek, Cyrillic, Vietnamese
  [0x0590, 'Noto Sans Hebrew'],
  [0x0600, 'Noto Sans Arabic'],
  [0x0700, null],
  [0x0900, 'Noto Sans Devanagari'],
  [0x0980, null],
  [0x0e00, 'Noto Sans Thai'],
  [0x0e80, null],
  [0x1e00, 'Noto Sans'], // Latin Extended Additional, Greek Extended
  [0x2100, null],
  [0x3000, 'Noto Sans JP'], // CJK punctuation and kana
  [0x3130, 'Noto Sans KR'], // Hangul jamo and syllables
  [0x3190, 'Noto Sans SC'], // CJK ideographs and everything after them
  [0xac00, 'Noto Sans KR'], // Hangul syllables
  [0xd7b0, 'Noto Sans SC'], // CJK compatibility ideographs and ideograph extensions
  [0xe000, null], // private use, presentation forms, emoji
];

function familyFor(codepoint: number): string | null {
  let family: string | null = null;
  for (const [start, name] of BLOCKS) {
    if (codepoint < start) break;
    family = name;
  }
  return family;
}

export interface FallbackRequest {
  family: string;
  /** The uncovered characters this family is asked for, deduplicated and sorted
      so the same name always produces the same request (and the same cache key). */
  text: string;
}

/**
 * Which Noto families the given text needs, and for which characters. Empty for
 * text the loaded fonts already cover, which is the overwhelmingly common case.
 *
 * Han script has no per-character way to tell Japanese from Chinese, so kana in
 * the same text pulls the ideographs to the Japanese face and Hangul to the
 * Korean one, matching how the name is most likely meant to read.
 */
export function fallbackRequests(text: string, covered: Set<number>): FallbackRequest[] {
  const byFamily = new Map<string, Set<number>>();
  for (const char of text) {
    const codepoint = char.codePointAt(0) as number;
    if (covered.has(codepoint)) continue;
    const family = familyFor(codepoint);
    if (!family) continue;
    const chars = byFamily.get(family);
    if (chars) chars.add(codepoint);
    else byFamily.set(family, new Set([codepoint]));
  }
  // Ideographs default to the simplified Chinese face; kana or Hangul in the same
  // text means the name is Japanese or Korean, so fold them into that face.
  const han = byFamily.get('Noto Sans SC');
  const kanaOrHangul = byFamily.get('Noto Sans JP') ?? byFamily.get('Noto Sans KR');
  if (han && kanaOrHangul) {
    for (const codepoint of han) kanaOrHangul.add(codepoint);
    byFamily.delete('Noto Sans SC');
  }
  return [...byFamily.entries()]
    .slice(0, MAX_FAMILIES)
    .map(([family, chars]) => ({
      family,
      text: [...chars].sort((a, b) => a - b).map((c) => String.fromCodePoint(c)).join(''),
    }));
}

// Memo per isolate, keyed by family and requested characters. A failed lookup is
// not cached: a transient outage should not blank the name for the isolate's life.
const fontCache = new Map<string, ArrayBuffer>();

/** Drops the memo. Only the tests need this, to keep one case from serving the
    next one a font out of the cache. */
export function clearFallbackFontCache(): void {
  fontCache.clear();
}

function remember(key: string, data: ArrayBuffer): void {
  if (fontCache.size >= MAX_CACHED_FONTS) {
    const oldest = fontCache.keys().next().value;
    if (oldest !== undefined) fontCache.delete(oldest);
  }
  fontCache.set(key, data);
}

/** Fetches one Noto face as woff bytes, or null on any failure. An alphabetic
    script comes back subset to the requested characters (a few KB); a CJK family
    comes back whole, several megabytes that satori parses lazily and lays out in
    well under a second. */
async function fetchFamily(request: FallbackRequest, fetcher: typeof fetch): Promise<ArrayBuffer | null> {
  const whole = WHOLE_FACE_FAMILIES.has(request.family);
  const key = whole ? request.family : `${request.family}|${request.text}`;
  const cached = fontCache.get(key);
  if (cached) return cached;
  try {
    const query = `family=${encodeURIComponent(request.family)}:700&text=${encodeURIComponent(request.text)}`;
    const css = await fetcher(`${CSS_ENDPOINT}?${query}`, {
      headers: { 'user-agent': LEGACY_UA },
      signal: AbortSignal.timeout(CSS_TIMEOUT_MS),
    });
    if (!css.ok) return null;
    const url = (await css.text()).match(/url\((https:\/\/[^)]+)\)/)?.[1];
    if (!url) return null;
    const font = await fetcher(url, { signal: AbortSignal.timeout(FONT_TIMEOUT_MS) });
    if (!font.ok) return null;
    const data = await font.arrayBuffer();
    if (data.byteLength === 0) return null;
    remember(key, data);
    return data;
  } catch {
    return null;
  }
}

/**
 * Extra fonts to hand satori so every character in `html` can be drawn. Returns
 * an empty array when the loaded fonts already cover the text, when the script
 * has no Noto family here, or when the font service is unreachable: the card
 * then renders as it does today rather than not at all.
 *
 * satori falls back to any loaded font that has the glyph, so these do not need
 * to be named in the templates' font-family.
 */
export async function loadFallbackFonts(
  html: string,
  loaded: OgFont[],
  fetcher: typeof fetch = fetch,
): Promise<OgFont[]> {
  const covered = new Set<number>();
  for (const font of loaded) for (const code of cachedCoveredCodepoints(font.data)) covered.add(code);
  const requests = fallbackRequests(html, covered);
  if (requests.length === 0) return [];
  const fonts = await Promise.all(
    requests.map(async (request): Promise<OgFont | null> => {
      const data = await fetchFamily(request, fetcher);
      return data && { name: request.family, data, weight: 700, style: 'normal' };
    }),
  );
  return fonts.filter((font): font is OgFont => font !== null);
}
